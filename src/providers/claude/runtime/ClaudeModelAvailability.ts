import { ProviderModelUnavailableError } from '../../../core/providers/models/ProviderModelUnavailableError';
import { findClaudeModelOption, getClaudeModelOptions } from '../modelOptions';
import { getClaudeProviderSettings } from '../settings';

export function assertClaudeModelAvailable(settings: Record<string, unknown>, requestedModel: string | undefined): void {
  const model = requestedModel ?? (typeof settings.model === 'string' ? settings.model : '');
  if (!(getClaudeProviderSettings(settings).enabled
    && Boolean(findClaudeModelOption(getClaudeModelOptions(settings), model)))) {
    throw new ProviderModelUnavailableError('Claude');
  }
}
