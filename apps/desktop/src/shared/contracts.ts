export const IPC = {
  snapshot: "relay:snapshot",
  gatewayAction: "relay:gateway-action",
  authenticate: "relay:authenticate",
  cancelAuthentication: "relay:cancel-authentication",
  refreshModels: "relay:refresh-models",
  probeModel: "relay:probe-model",
  configureClients: "relay:configure-clients",
  updateSettings: "relay:update-settings",
  checkForUpdates: "relay:check-for-updates",
  downloadUpdate: "relay:download-update",
  installUpdate: "relay:install-update",
  event: "relay:event",
} as const;

export type GatewayAction = "start" | "stop" | "restart";
export type ClientName = "claude" | "codex" | "opencode" | "pi";
export type UpdateChannel = "stable" | "beta";

export interface GatewayStatus {
  desiredState: "running" | "stopped";
  status: string;
  endpoint: string;
  authenticated: boolean;
  supervisorPid: number | null;
  backendPid: number | null;
  activeVersionId: string;
  lastError: string | null;
}

export interface ModelView {
  id: string;
  vendor: string | null;
  endpoints: string[];
  reasoningEfforts: string[];
  streaming: boolean;
  toolCalls: boolean;
  parallelToolCalls: boolean;
  vision: boolean;
  structuredOutputs: boolean;
  limits: Record<string, unknown>;
}

export interface ClientView {
  name: ClientName;
  installed: boolean;
  executable: string | null;
}

export interface DesktopSettings {
  launchAtLogin: boolean;
  updateChannel: UpdateChannel;
  closeToTray: boolean;
}

export interface DesktopSnapshot {
  product: "GitHub Model Relay";
  unofficial: true;
  version: string;
  gateway: GatewayStatus;
  models: ModelView[];
  aliases: Record<string, string>;
  clients: ClientView[];
  settings: DesktopSettings;
  secureStorage: {
    available: boolean;
    backend: string;
  };
  paths: {
    root: string;
    logs: string;
    backups: string;
  };
  update: {
    state: string;
    message: string | null;
    availableVersion: string | null;
    progress: number | null;
  };
}

export interface ModelProbeInput {
  modelId: string;
  endpoint: string;
  reasoningEffort?: string;
}

export interface ConfigureClientsInput {
  clients: ClientName[];
  dryRun: boolean;
  remove: boolean;
  setDefault: boolean;
  model?: string;
  claudeModel?: string;
  codexModel?: string;
  fastModel?: string;
}

export interface SettingsUpdate {
  launchAtLogin?: boolean;
  updateChannel?: UpdateChannel;
  closeToTray?: boolean;
}

export type RelayEvent =
  | { type: "snapshot"; snapshot: DesktopSnapshot }
  | { type: "authentication"; operationId: string; state: string; message: string }
  | { type: "update"; state: string; message?: string; progress?: number };

export interface ModelRelayApi {
  snapshot(): Promise<DesktopSnapshot>;
  gatewayAction(action: GatewayAction): Promise<DesktopSnapshot>;
  authenticate(): Promise<{ operationId: string }>;
  cancelAuthentication(): Promise<void>;
  refreshModels(): Promise<DesktopSnapshot>;
  probeModel(input: ModelProbeInput): Promise<Record<string, unknown>>;
  configureClients(input: ConfigureClientsInput): Promise<Record<string, unknown>>;
  updateSettings(input: SettingsUpdate): Promise<DesktopSnapshot>;
  checkForUpdates(): Promise<DesktopSnapshot>;
  downloadUpdate(): Promise<void>;
  installUpdate(): Promise<void>;
  onEvent(callback: (event: RelayEvent) => void): () => void;
}
