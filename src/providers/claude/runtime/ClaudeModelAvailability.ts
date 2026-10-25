import { ProviderModelUnavailableError } from '../../../core/providers/models/ProviderModelUnavailableError';
import type { ProviderRuntimeHost } from '../../../core/providers/ProviderRuntimeHost';
import { decodeClaudeConfig } from '../config';
import { findEnabledClaudeModelOption } from '../modelOptions';

export function assertClaudeModelAvailable(
  host: Pick<ProviderRuntimeHost, 'config' | 'selection' | 'environmentText'>,
  requestedModel: string | undefined,
): void {
  const model = requestedModel ?? host.selection.model ?? '';
  if (!decodeClaudeConfig(host.config).enabled || !findEnabledClaudeModelOption(host, model)) {
    throw new ProviderModelUnavailableError('Claude Code');
  }
}
