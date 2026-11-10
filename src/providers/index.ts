import { registerProviderModules } from '../core/providers/registerProviderModules';
import { antigravityProviderRegistration } from './antigravity/registration';
import { claudeProviderRegistration } from './claude/registration';
import { codexProviderRegistration } from './codex/registration';
import { deepseekProviderRegistration } from './deepseek/registration';
import { grokProviderRegistration } from './grok/registration';
import { opencodeProviderRegistration } from './opencode/registration';
import { piProviderRegistration } from './pi/registration';

let builtInProvidersRegistered = false;

export const BUILT_IN_PROVIDER_MODULES = [
  antigravityProviderRegistration,
  claudeProviderRegistration,
  codexProviderRegistration,
  deepseekProviderRegistration,
  grokProviderRegistration,
  opencodeProviderRegistration,
  piProviderRegistration,
] as const;

export function registerBuiltInProviders(): void {
  if (builtInProvidersRegistered) {
    return;
  }

  registerProviderModules(BUILT_IN_PROVIDER_MODULES);
  builtInProvidersRegistered = true;
}

registerBuiltInProviders();
