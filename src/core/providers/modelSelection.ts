import type { ProviderId } from './types';

const PROVIDER_MODEL_SELECTION_PREFIXES: Partial<Record<ProviderId, string>> = {
  claude: 'claude-code/',
  codex: 'openai-codex/',
  opencode: 'opencode/',
  pi: 'pi/',
};

export interface ProviderModelSelection {
  modelId: string;
  providerId: ProviderId;
}

export function getProviderModelSelectionPrefix(providerId: ProviderId): string | null {
  return PROVIDER_MODEL_SELECTION_PREFIXES[providerId] ?? null;
}

export function encodeProviderModelSelectionId(
  providerId: ProviderId,
  modelId: string,
): string {
  const normalized = modelId.trim();
  const prefix = getProviderModelSelectionPrefix(providerId);
  if (!prefix || !normalized || normalized.startsWith(prefix)) {
    return normalized;
  }

  return `${prefix}${normalized}`;
}

export function decodeProviderModelSelectionId(
  value: string,
): ProviderModelSelection | null {
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }

  for (const [providerId, prefix] of Object.entries(PROVIDER_MODEL_SELECTION_PREFIXES)) {
    if (!prefix || !normalized.startsWith(prefix)) {
      continue;
    }

    const modelId = normalized.slice(prefix.length).trim();
    if (!modelId) {
      return null;
    }

    return {
      providerId,
      modelId,
    };
  }

  return null;
}

export function isProviderModelSelectionId(
  providerId: ProviderId,
  value: string,
): boolean {
  return decodeProviderModelSelectionId(value)?.providerId === providerId;
}

export function toProviderRuntimeModelId(
  providerId: ProviderId,
  value: string,
): string {
  const decoded = decodeProviderModelSelectionId(value);
  return decoded?.providerId === providerId ? decoded.modelId : value;
}
