import {
  encodeProviderModelSelectionId,
  isProviderModelSelectionId,
  toProviderRuntimeModelId,
} from '../../core/providers/modelSelection';

export function encodeClaudeModelSelectionId(modelId: string): string {
  return encodeProviderModelSelectionId('claude', modelId);
}

export function isClaudeModelSelectionId(modelId: string): boolean {
  return isProviderModelSelectionId('claude', modelId);
}

export function toClaudeRuntimeModelId(modelId: string): string {
  return toProviderRuntimeModelId('claude', modelId);
}
