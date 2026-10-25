import { getProviderConfig, setProviderConfig } from '../../core/providers/providerConfig';
import { getRuntimeEnvironmentText } from '../../core/providers/providerEnvironment';
import { type ClaudeProviderSettings, decodeClaudeConfig, updateClaudeConfig } from './config';
import type { ClaudeModelSource } from './modelOptions';

export {
  type ClaudeProviderSettings,
  decodeOutputStyles,
  DEFAULT_CLAUDE_PROVIDER_SETTINGS,
  resolveClaudeSettingSources,
} from './config';

/** Reads Claude's configuration from the settings document. */
export function getClaudeProviderSettings(
  settings: Record<string, unknown>,
): ClaudeProviderSettings {
  return decodeClaudeConfig(getProviderConfig(settings, 'claude'));
}

/** Writes Claude's configuration into the settings document. */
export function updateClaudeProviderSettings(
  settings: Record<string, unknown>,
  updates: Partial<ClaudeProviderSettings>,
): ClaudeProviderSettings {
  const config = getProviderConfig(settings, 'claude');
  const next = updateClaudeConfig(config, updates);
  setProviderConfig(settings, 'claude', config);
  return next;
}

/** The model-option inputs the settings document holds for Claude; the environment is read on demand. */
export function getClaudeModelSource(settings: Record<string, unknown>): ClaudeModelSource {
  return {
    config: getProviderConfig(settings, 'claude'),
    get environmentText() { return getRuntimeEnvironmentText(settings, 'claude'); },
  };
}
