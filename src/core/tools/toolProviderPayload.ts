import type { ToolProviderPayload } from '../types';

export function normalizeToolProviderPayload(value: unknown): ToolProviderPayload | null {
  if (!isRecord(value)) return null;
  const hasRawInput = Object.prototype.hasOwnProperty.call(value, 'rawInput');
  const hasRawOutput = Object.prototype.hasOwnProperty.call(value, 'rawOutput');
  const rawName = typeof value.rawName === 'string' && value.rawName.trim()
    ? value.rawName
    : undefined;
  if (!hasRawInput && !hasRawOutput && !rawName) return null;
  return {
    ...(hasRawInput ? { rawInput: value.rawInput } : {}),
    ...(rawName ? { rawName } : {}),
    ...(hasRawOutput ? { rawOutput: value.rawOutput } : {}),
  };
}

export function extractToolProviderPayload(value: unknown): ToolProviderPayload | null {
  return isRecord(value) ? normalizeToolProviderPayload(value.providerPayload) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
