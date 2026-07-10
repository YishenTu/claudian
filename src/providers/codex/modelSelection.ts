import {
  encodeProviderModelSelectionId,
  isProviderModelSelectionId,
  toProviderRuntimeModelId,
} from '../../core/providers/modelSelection';

export function encodeCodexModelSelectionId(modelId: string): string {
  return encodeProviderModelSelectionId('codex', modelId);
}

export function isCodexModelSelectionId(modelId: string): boolean {
  return isProviderModelSelectionId('codex', modelId);
}

export function toCodexRuntimeModelId(modelId: string): string {
  return toProviderRuntimeModelId('codex', modelId);
}

export function looksLikeCodexModel(modelId: string): boolean {
  return /^gpt-/i.test(modelId) || /^o\d/i.test(modelId);
}
