import { z } from "zod";

export const gatewayActionSchema = z.enum(["start", "stop", "restart"]);
export const clientNameSchema = z.enum(["claude", "codex", "opencode", "pi"]);
export const updateChannelSchema = z.enum(["stable", "beta"]);

const safeIdentifier = z.string().min(1).max(256).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/,
);
const safeCapability = z.string().min(1).max(64).regex(
  /^[A-Za-z][A-Za-z0-9._+-]*$/,
);
const safeEndpoint = z.string().min(2).max(256).regex(
  /^(?:\/|ws:\/)[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+$/,
);

export const modelProbeSchema = z.object({
  modelId: safeIdentifier,
  endpoint: safeEndpoint,
  reasoningEffort: safeCapability.optional(),
}).strict();

export const configureClientsSchema = z.object({
  clients: z.array(clientNameSchema).min(1).max(4),
  dryRun: z.boolean(),
  remove: z.boolean(),
  setDefault: z.boolean(),
  model: safeIdentifier.optional(),
  claudeModel: safeIdentifier.optional(),
  codexModel: safeIdentifier.optional(),
  fastModel: safeIdentifier.optional(),
}).strict();

export const settingsUpdateSchema = z.object({
  launchAtLogin: z.boolean().optional(),
  updateChannel: updateChannelSchema.optional(),
  closeToTray: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0);
