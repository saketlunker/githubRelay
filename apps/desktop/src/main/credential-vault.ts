import { rm } from "node:fs/promises";
import path from "node:path";

import { safeStorage } from "electron";

import {
  atomicWriteFile,
  fileExists,
  readTextFile,
} from "../../../../runtime/lib/atomic-files.mjs";

export function selectedStorageBackend() {
  const storage = safeStorage as typeof safeStorage & {
    getSelectedStorageBackend?: () => string;
  };
  if (typeof storage.getSelectedStorageBackend === "function") {
    return storage.getSelectedStorageBackend();
  }
  if (process.platform === "win32") {
    return "dpapi";
  }
  if (process.platform === "darwin") {
    return "keychain";
  }
  return safeStorage.isEncryptionAvailable() ? "keyring" : "unavailable";
}

export class CredentialVault {
  private readonly plainPath: string;
  private readonly encryptedPath: string;

  constructor(root: string) {
    this.plainPath = path.join(root, "data", "backend", "github_token");
    this.encryptedPath = path.join(root, "secrets", "github-token.safe");
  }

  backend() {
    return selectedStorageBackend();
  }

  available() {
    return safeStorage.isEncryptionAvailable() && this.backend() !== "basic_text";
  }

  private requireAvailable() {
    if (!this.available()) {
      throw new Error(
        "Encrypted OS credential storage is unavailable. Configure a supported keyring before GitHub authentication.",
      );
    }
  }

  async hasCredential() {
    const plain = await readTextFile(this.plainPath);
    return (plain !== null && plain.trim().length > 0)
      || await fileExists(this.encryptedPath);
  }

  async materialize() {
    const plain = await readTextFile(this.plainPath);
    if (plain !== null && plain.trim().length > 0) {
      return;
    }
    const encrypted = await readTextFile(this.encryptedPath);
    if (encrypted === null) {
      return;
    }
    this.requireAvailable();
    const decrypted = safeStorage.decryptString(
      Buffer.from(encrypted.trim(), "base64"),
    );
    if (decrypted.trim().length === 0) {
      throw new Error("Stored GitHub credential is empty.");
    }
    await atomicWriteFile(this.plainPath, `${decrypted.trim()}\n`, {
      mode: 0o600,
      expectedContent: plain,
    });
  }

  async seal() {
    const plain = await readTextFile(this.plainPath);
    if (plain === null || plain.trim().length === 0) {
      return;
    }
    this.requireAvailable();
    const encrypted = safeStorage.encryptString(plain.trim()).toString("base64");
    await atomicWriteFile(this.encryptedPath, `${encrypted}\n`, {
      mode: 0o600,
    });
    await rm(this.plainPath, { force: true });
  }

  async clear() {
    await Promise.all([
      rm(this.plainPath, { force: true }),
      rm(this.encryptedPath, { force: true }),
    ]);
  }
}
