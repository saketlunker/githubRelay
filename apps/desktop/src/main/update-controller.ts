import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";

import * as electronUpdater from "electron-updater";
import type { UpdateDownloadedEvent } from "electron-updater";

import { DESKTOP_STATE_SCHEMAS } from "../../../../runtime/lib/desktop-state.mjs";
import {
  selectReleaseAsset,
  verifyReleaseAsset,
  verifyReleaseManifest,
} from "../../../../runtime/lib/release-manifest.mjs";
import type { UpdateChannel } from "../shared/contracts";

const { autoUpdater } = electronUpdater;

interface UpdateState {
  state: string;
  message: string | null;
  availableVersion: string | null;
  progress: number | null;
}

interface GithubAsset {
  name: string;
  browser_download_url: string;
}

interface GithubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: GithubAsset[];
}

export class UpdateController extends EventEmitter {
  private readonly publicKeyPath: string;
  private channel: UpdateChannel = "stable";
  private stateValue: UpdateState = {
    state: "idle",
    message: null,
    availableVersion: null,
    progress: null,
  };
  private manifest: Record<string, unknown> | null = null;
  private releaseEtag: string | null = null;
  private cachedRelease: GithubRelease | null = null;

  constructor(publicKeyPath: string) {
    super();
    this.publicKeyPath = publicKeyPath;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on("update-available", (information) => {
      this.setState({
        state: "available",
        message: null,
        availableVersion: information.version,
        progress: null,
      });
    });
    autoUpdater.on("update-not-available", () => {
      this.setState({
        state: "current",
        message: "The installed version is current.",
        availableVersion: null,
        progress: null,
      });
    });
    autoUpdater.on("download-progress", (progress) => {
      this.setState({
        ...this.stateValue,
        state: "downloading",
        progress: progress.percent,
      });
    });
    autoUpdater.on("update-downloaded", (event) => {
      void this.verifyDownloaded(event);
    });
    autoUpdater.on("error", (error) => {
      this.setState({
        ...this.stateValue,
        state: "failed",
        message: error.message,
      });
    });
  }

  state() {
    return { ...this.stateValue };
  }

  setChannel(channel: UpdateChannel) {
    if (this.channel !== channel) {
      this.releaseEtag = null;
      this.cachedRelease = null;
      this.manifest = null;
    }
    this.channel = channel;
    autoUpdater.channel = channel;
    autoUpdater.allowPrerelease = channel === "beta";
  }

  private setState(state: UpdateState) {
    this.stateValue = state;
    this.emit("changed", this.state());
  }

  private async release(): Promise<GithubRelease> {
    const base = "https://api.github.com/repos/saketlunker/githubRelay";
    const response = await fetch(
      this.channel === "stable"
        ? `${base}/releases/latest`
        : `${base}/releases?per_page=20`,
      {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "github-model-relay-updater",
          ...(this.releaseEtag === null
            ? {}
            : { "if-none-match": this.releaseEtag }),
        },
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (response.status === 304 && this.cachedRelease !== null) {
      return this.cachedRelease;
    }
    if (!response.ok) {
      throw new Error(`Public release feed returned HTTP ${response.status}.`);
    }
    const value = await response.json();
    const release = this.channel === "stable"
      ? value as GithubRelease
      : (value as GithubRelease[]).find(
          (candidate) => !candidate.draft && candidate.prerelease,
        );
    if (!release) {
      throw new Error("No beta release is published.");
    }
    this.releaseEtag = response.headers.get("etag");
    this.cachedRelease = release;
    return release;
  }

  private async verifiedManifest() {
    const publicKey = await readFile(this.publicKeyPath, "utf8").catch(() => "");
    if (publicKey.trim().length === 0) {
      throw new Error(
        "Corporate release-manifest public key is not installed; updates are disabled.",
      );
    }
    const release = await this.release();
    const manifestAsset = release.assets.find(
      (asset) => asset.name === "release-manifest.json",
    );
    const signatureAsset = release.assets.find(
      (asset) => asset.name === "release-manifest.sig",
    );
    if (!manifestAsset || !signatureAsset) {
      throw new Error("Release is missing its signed manifest.");
    }
    const [manifestResponse, signatureResponse] = await Promise.all([
      fetch(manifestAsset.browser_download_url, {
        signal: AbortSignal.timeout(20_000),
      }),
      fetch(signatureAsset.browser_download_url, {
        signal: AbortSignal.timeout(20_000),
      }),
    ]);
    if (!manifestResponse.ok || !signatureResponse.ok) {
      throw new Error("Unable to download release signature metadata.");
    }
    return verifyReleaseManifest({
      manifest: await manifestResponse.text(),
      signature: (await signatureResponse.text()).trim(),
      publicKey,
      expectedChannel: this.channel,
      currentSchemas: DESKTOP_STATE_SCHEMAS,
    }) as Record<string, unknown>;
  }

  async check() {
    this.setState({
      state: "checking",
      message: null,
      availableVersion: null,
      progress: null,
    });
    try {
      this.manifest = await this.verifiedManifest();
      await autoUpdater.checkForUpdates();
    } catch (error) {
      this.setState({
        state: "failed",
        message: error instanceof Error ? error.message : String(error),
        availableVersion: null,
        progress: null,
      });
    }
  }

  async download() {
    if (this.manifest === null) {
      throw new Error("A verified update check is required before download.");
    }
    await autoUpdater.downloadUpdate();
  }

  private async verifyDownloaded(event: UpdateDownloadedEvent) {
    try {
      if (this.manifest === null) {
        throw new Error("Downloaded update has no verified manifest.");
      }
      const format = process.platform === "win32"
        ? "nsis"
        : process.platform === "darwin"
          ? "zip"
          : "appimage";
      const asset = selectReleaseAsset(this.manifest, {
        platform: process.platform,
        arch: process.arch,
        format,
      });
      const bytes = await readFile(path.resolve(event.downloadedFile));
      verifyReleaseAsset(asset, bytes);
      this.setState({
        state: "downloaded",
        message: "Signed update verified and ready to install.",
        availableVersion: this.stateValue.availableVersion,
        progress: 100,
      });
    } catch (error) {
      this.setState({
        ...this.stateValue,
        state: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  install() {
    if (this.stateValue.state !== "downloaded") {
      throw new Error("No verified update is ready to install.");
    }
    autoUpdater.quitAndInstall(false, true);
  }
}
