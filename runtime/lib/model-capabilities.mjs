import { validateModelId } from './model-catalog.mjs';

const VALUE_PATTERN = /^[A-Za-z][A-Za-z0-9._+-]{0,63}$/;
const ENDPOINT_PATTERN = /^(?:\/|ws:\/)[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]{1,255}$/;

function uniqueSafeStrings(value, pattern) {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.filter((entry) =>
    typeof entry === 'string' && pattern.test(entry)))];
}

export function reasoningEffortsForModel(model) {
  return uniqueSafeStrings(
    model?.capabilities?.supports?.reasoning_effort,
    VALUE_PATTERN,
  );
}

export function endpointsForModel(model) {
  return uniqueSafeStrings(model?.supported_endpoints, ENDPOINT_PATTERN);
}

function supports(model, capability) {
  return VALUE_PATTERN.test(capability)
    && model?.capabilities?.supports?.[capability] === true;
}

export function modelCapabilitySummary(model) {
  return {
    id: validateModelId(model?.id, 'model.id'),
    vendor: typeof model?.vendor === 'string' ? model.vendor : null,
    endpoints: endpointsForModel(model),
    reasoningEfforts: reasoningEffortsForModel(model),
    streaming: supports(model, 'streaming'),
    toolCalls: supports(model, 'tool_calls'),
    parallelToolCalls: supports(model, 'parallel_tool_calls'),
    vision: supports(model, 'vision'),
    structuredOutputs: supports(model, 'structured_outputs'),
    limits: structuredClone(model?.capabilities?.limits ?? {}),
  };
}

export function buildProbeRequest({
  model,
  endpoint,
  reasoningEffort = undefined,
  prompt = 'Reply with exactly: MODEL_RELAY_OK',
}) {
  const modelId = validateModelId(model?.id, 'model.id');
  if (!endpointsForModel(model).includes(endpoint)) {
    throw new Error(`Model "${modelId}" does not advertise endpoint "${endpoint}".`);
  }
  if (reasoningEffort !== undefined) {
    if (
      !VALUE_PATTERN.test(reasoningEffort)
      || !reasoningEffortsForModel(model).includes(reasoningEffort)
    ) {
      throw new Error(
        `Model "${modelId}" does not advertise reasoning effort "${reasoningEffort}".`,
      );
    }
  }
  if (endpoint === '/responses' || endpoint === 'ws:/responses') {
    return {
      path: '/v1/responses',
      body: {
        model: modelId,
        input: prompt,
        stream: false,
        max_output_tokens: 512,
        ...(reasoningEffort === undefined
          ? {}
          : { reasoning: { effort: reasoningEffort, summary: 'auto' } }),
      },
    };
  }
  if (endpoint === '/messages') {
    return {
      path: '/v1/messages',
      headers: { 'anthropic-version': '2023-06-01' },
      body: {
        model: modelId,
        max_tokens: 256,
        messages: [{ role: 'user', content: prompt }],
        ...(reasoningEffort === undefined
          ? {}
          : { output_config: { effort: reasoningEffort } }),
      },
    };
  }
  throw new Error(`No probe adapter exists for endpoint "${endpoint}".`);
}
