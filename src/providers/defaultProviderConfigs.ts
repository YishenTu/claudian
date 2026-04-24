import type { ProviderConfigMap } from '../core/types/settings';
import { DEFAULT_CLAUDE_PROVIDER_SETTINGS } from './claude/settings';
import { DEFAULT_CODEX_PROVIDER_SETTINGS } from './codex/settings';
import { DEFAULT_OPENCODE_PROVIDER_SETTINGS } from './opencode/settings';

export function getBuiltInProviderDefaultConfigs(): ProviderConfigMap {
  return {
    claude: { ...DEFAULT_CLAUDE_PROVIDER_SETTINGS },
    codex: { ...DEFAULT_CODEX_PROVIDER_SETTINGS },
    opencode: { ...DEFAULT_OPENCODE_PROVIDER_SETTINGS },
  };
}
