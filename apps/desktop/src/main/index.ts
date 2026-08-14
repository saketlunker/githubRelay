import path from "node:path";

import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  safeStorage,
  shell,
  Tray,
} from "electron";

import { resolveDesktopPaths } from "../../../../runtime/lib/platform-paths.mjs";
import { extractGatewayBundle } from "../../../../runtime/lib/bundle-extractor.mjs";
import {
  finalizeLegacyWindowsMigration,
  rollbackLegacyWindowsMigration,
  stageLegacyWindowsMigration,
} from "../../../../runtime/lib/windows-migration.mjs";
import {
  IPC,
  type DesktopSnapshot,
  type RelayEvent,
} from "../shared/contracts";
import { GatewayController } from "./gateway-controller";
import {
  CredentialVault,
  selectedStorageBackend,
} from "./credential-vault";
import { setLaunchAtLogin } from "./launch-at-login";
import { UpdateController } from "./update-controller";
import {
  configureClientsSchema,
  gatewayActionSchema,
  modelProbeSchema,
  settingsUpdateSchema,
} from "./validation";

const PRODUCT = "GitHub Model Relay";
let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let controller: GatewayController;
let updates: UpdateController;

function gatewayArchive() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "gateway-release.zip")
    : path.resolve(app.getAppPath(), ".gateway-release.zip");
}

function rendererPath() {
  return path.join(app.getAppPath(), "dist", "renderer", "index.html");
}

function preloadPath() {
  return path.join(app.getAppPath(), "dist", "preload", "index.cjs");
}

function send(event: RelayEvent) {
  if (window !== null && !window.isDestroyed()) {
    window.webContents.send(IPC.event, event);
  }
}

async function snapshot(): Promise<DesktopSnapshot> {
  const [gateway, models] = await Promise.all([
    controller.status(),
    controller.models(false).catch(() => ({ models: [], aliases: {} })),
  ]);
  const paths = resolveDesktopPaths({ appData: app.getPath("appData") });
  return {
    product: PRODUCT,
    unofficial: true,
    version: app.getVersion(),
    gateway,
    models: models.models,
    aliases: models.aliases,
    clients: controller.clients(),
    settings: controller.settings(),
    secureStorage: {
      available: safeStorage.isEncryptionAvailable()
        && selectedStorageBackend() !== "basic_text",
      backend: selectedStorageBackend(),
    },
    paths: {
      root: paths.root,
      logs: path.join(paths.root, "logs"),
      backups: path.join(paths.root, "backups"),
    },
    update: updates.state(),
  };
}

async function emitSnapshot() {
  send({ type: "snapshot", snapshot: await snapshot() });
  refreshTray();
}

function createWindow() {
  if (window !== null && !window.isDestroyed()) {
    window.show();
    window.focus();
    return;
  }
  window = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 820,
    minHeight: 600,
    title: PRODUCT,
    show: false,
    backgroundColor: "#f4f5f7",
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  window.removeMenu();
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.on("close", (event) => {
    if (!quitting && controller.settings().closeToTray) {
      event.preventDefault();
      window?.hide();
    }
  });
  window.once("ready-to-show", () => window?.show());
  void window.loadFile(rendererPath());
}

function refreshTray() {
  if (tray === null) {
    return;
  }
  void controller.status().then((status) => {
    tray?.setToolTip(`${PRODUCT} — ${status.status}`);
    tray?.setContextMenu(Menu.buildFromTemplate([
      { label: "Open Settings", click: createWindow },
      { type: "separator" },
      {
        label: "Start Gateway",
        enabled: status.status !== "ready",
        click: () => void controller.start().then(emitSnapshot),
      },
      {
        label: "Stop Gateway",
        enabled: status.status === "ready",
        click: () => void controller.stop().then(emitSnapshot),
      },
      {
        label: "Restart Gateway",
        click: () => void controller.restart().then(emitSnapshot),
      },
      { type: "separator" },
      {
        label: "Check for Updates",
        click: () => void updates.check(),
      },
      {
        label: "Diagnostics",
        click: () => {
          createWindow();
          send({ type: "update", state: "diagnostics", message: "Open Security & Diagnostics." });
        },
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          app.quit();
        },
      },
    ]));
  });
}

function createTray() {
  const image = nativeImage.createFromDataURL(
    "data:image/svg+xml;charset=utf-8,"
    + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">'
      + '<rect width="32" height="32" rx="7" fill="#3456d1"/>'
      + '<path d="M7 22V10h4l5 6 5-6h4v12h-4v-6l-5 6-5-6v6z" fill="white"/>'
      + "</svg>",
    ),
  );
  tray = new Tray(image);
  tray.on("double-click", createWindow);
  refreshTray();
}

function registerIpc() {
  ipcMain.handle(IPC.snapshot, () => snapshot());
  ipcMain.handle(IPC.gatewayAction, async (_event, raw) => {
    const action = gatewayActionSchema.parse(raw);
    await controller[action]();
    return await snapshot();
  });
  ipcMain.handle(IPC.authenticate, () => {
    if (
      !safeStorage.isEncryptionAvailable()
      || selectedStorageBackend() === "basic_text"
    ) {
      throw new Error(
        "Encrypted OS credential storage is required for GitHub authentication.",
      );
    }
    return controller.startAuthentication();
  });
  ipcMain.handle(IPC.cancelAuthentication, () => controller.cancelAuthentication());
  ipcMain.handle(IPC.refreshModels, async () => {
    await controller.models(true);
    return await snapshot();
  });
  ipcMain.handle(IPC.probeModel, (_event, raw) => {
    const value = modelProbeSchema.parse(raw);
    return controller.probeModel({
      modelId: value.modelId,
      endpoint: value.endpoint,
      ...(value.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: value.reasoningEffort }),
    });
  });
  ipcMain.handle(IPC.configureClients, (_event, raw) => {
    const value = configureClientsSchema.parse(raw);
    return controller.configureClients({
      clients: value.clients,
      dryRun: value.dryRun,
      remove: value.remove,
      setDefault: value.setDefault,
      ...(value.model === undefined ? {} : { model: value.model }),
      ...(value.claudeModel === undefined
        ? {}
        : { claudeModel: value.claudeModel }),
      ...(value.codexModel === undefined
        ? {}
        : { codexModel: value.codexModel }),
      ...(value.fastModel === undefined
        ? {}
        : { fastModel: value.fastModel }),
    });
  });
  ipcMain.handle(IPC.updateSettings, async (_event, raw) => {
    const update = settingsUpdateSchema.parse(raw);
    const current = controller.settings();
    const settings = {
      launchAtLogin: update.launchAtLogin ?? current.launchAtLogin,
      updateChannel: update.updateChannel ?? current.updateChannel,
      closeToTray: update.closeToTray ?? current.closeToTray,
    };
    await controller.updateSettings(settings);
    await setLaunchAtLogin(settings.launchAtLogin);
    updates.setChannel(settings.updateChannel);
    return await snapshot();
  });
  ipcMain.handle(IPC.checkForUpdates, async () => {
    await updates.check();
    return await snapshot();
  });
  ipcMain.handle(IPC.downloadUpdate, () => updates.download());
  ipcMain.handle(IPC.installUpdate, () => updates.install());
}

async function start() {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on("second-instance", createWindow);
  await app.whenReady();
  const paths = resolveDesktopPaths({
    ...(process.platform === "darwin"
      ? { appData: app.getPath("appData") }
      : {}),
  });
  const migration = await stageLegacyWindowsMigration({
    legacyRoot: paths.legacyWindowsRoot,
    targetRoot: paths.root,
  });
  try {
    const releaseRoot = await extractGatewayBundle({
      archive: gatewayArchive(),
      target: path.join(
        paths.root,
        "versions",
        `desktop-bundle-${app.getVersion()}`,
      ),
      expectedBackendVersion: "2.0.1",
    });
    controller = new GatewayController({
      root: paths.root,
      releaseRoot,
      nodePath: process.execPath,
      appVersion: app.getVersion(),
      backendVersion: "2.0.1",
      credentialVault: new CredentialVault(paths.root),
    });
    updates = new UpdateController(path.join(
      process.resourcesPath,
      "model-relay-resources",
      "release-public-key.pem",
    ));
    await controller.initialize();
    const gateway = await controller.status();
    if (migration?.legacyWasRunning && gateway.status !== "ready") {
      throw new Error(
        `Migrated gateway did not become ready: ${gateway.lastError ?? gateway.status}`,
      );
    }
    if (migration !== null) {
      await finalizeLegacyWindowsMigration({ targetRoot: paths.root });
    }
  } catch (error) {
    if (migration !== null) {
      await rollbackLegacyWindowsMigration({ targetRoot: paths.root });
    }
    throw error;
  }
  await setLaunchAtLogin(controller.settings().launchAtLogin);
  updates.setChannel(controller.settings().updateChannel);
  controller.on("changed", () => void emitSnapshot());
  controller.on("authentication", (payload) => send({
    type: "authentication",
    ...payload,
  }));
  updates.on("changed", (state) => {
    send({ type: "update", ...state });
    void emitSnapshot();
  });
  registerIpc();
  createTray();
  if (!process.argv.includes("--hidden")) {
    createWindow();
  }
  const initialUpdateDelay = 30_000 + Math.floor(Math.random() * 30_000);
  setTimeout(() => void updates.check(), initialUpdateDelay).unref();
  const periodicUpdateDelay = 6 * 60 * 60_000
    + Math.floor(Math.random() * 30 * 60_000);
  setInterval(() => void updates.check(), periodicUpdateDelay).unref();
}

app.on("before-quit", (event) => {
  if (quitting) {
    return;
  }
  event.preventDefault();
  quitting = true;
  void controller.dispose().finally(() => app.quit());
});
app.on("window-all-closed", () => {
  // The tray owns application lifetime.
});

void start().catch((error: unknown) => {
  console.error(error);
  app.exit(1);
});
