import type { ProviderConfigMap } from '../core/types/settings';
import { DEFAULT_CLAUDE_PROVIDER_SETTINGS } from './claude/config';
import { DEFAULT_CODEX_PROVIDER_CONFIG } from './codex/config';
import { DEFAULT_DEEPSEEK_PROVIDER_SETTINGS } from './deepseek/config';
import { DEFAULT_GROK_PROVIDER_SETTINGS } from './grok/config';
import { DEFAULT_OPENCODE_PROVIDER_SETTINGS } from './opencode/config';
import { DEFAULT_PI_PROVIDER_SETTINGS } from './pi/config';

export function getBuiltInProviderDefaultConfigs(): ProviderConfigMap {
  return {
    claude: { ...DEFAULT_CLAUDE_PROVIDER_SETTINGS },
    codex: { ...DEFAULT_CODEX_PROVIDER_CONFIG },
    deepseek: { ...DEFAULT_DEEPSEEK_PROVIDER_SETTINGS },
    grok: { ...DEFAULT_GROK_PROVIDER_SETTINGS },
    opencode: { ...DEFAULT_OPENCODE_PROVIDER_SETTINGS },
    pi: { ...DEFAULT_PI_PROVIDER_SETTINGS },
  };
}
