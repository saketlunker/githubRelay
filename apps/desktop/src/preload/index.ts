import { contextBridge, ipcRenderer } from "electron";

import {
  IPC,
  type ConfigureClientsInput,
  type GatewayAction,
  type ModelProbeInput,
  type ModelRelayApi,
  type RelayEvent,
  type SettingsUpdate,
} from "../shared/contracts";

const api: ModelRelayApi = Object.freeze({
  snapshot: () => ipcRenderer.invoke(IPC.snapshot),
  gatewayAction: (action: GatewayAction) =>
    ipcRenderer.invoke(IPC.gatewayAction, action),
  authenticate: () => ipcRenderer.invoke(IPC.authenticate),
  cancelAuthentication: () => ipcRenderer.invoke(IPC.cancelAuthentication),
  refreshModels: () => ipcRenderer.invoke(IPC.refreshModels),
  probeModel: (input: ModelProbeInput) =>
    ipcRenderer.invoke(IPC.probeModel, input),
  configureClients: (input: ConfigureClientsInput) =>
    ipcRenderer.invoke(IPC.configureClients, input),
  updateSettings: (input: SettingsUpdate) =>
    ipcRenderer.invoke(IPC.updateSettings, input),
  checkForUpdates: () => ipcRenderer.invoke(IPC.checkForUpdates),
  downloadUpdate: () => ipcRenderer.invoke(IPC.downloadUpdate),
  installUpdate: () => ipcRenderer.invoke(IPC.installUpdate),
  onEvent: (callback: (event: RelayEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: RelayEvent) => {
      callback(payload);
    };
    ipcRenderer.on(IPC.event, listener);
    return () => ipcRenderer.removeListener(IPC.event, listener);
  },
});

contextBridge.exposeInMainWorld("modelRelay", api);
