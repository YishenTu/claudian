import { ProviderRegistry } from '../core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '../core/providers/ProviderWorkspaceRegistry';
import { claudeProviderRegistration } from './claude/registration';
import { codexProviderRegistration } from './codex/registration';
import { grokProviderRegistration } from './grok/registration';
import { opencodeProviderRegistration } from './opencode/registration';
import { piProviderRegistration } from './pi/registration';

let builtInProvidersRegistered = false;

export const BUILT_IN_PROVIDER_MODULES = [
  claudeProviderRegistration,
  codexProviderRegistration,
  grokProviderRegistration,
  opencodeProviderRegistration,
  piProviderRegistration,
] as const;

export function registerBuiltInProviders(): void {
  if (builtInProvidersRegistered) {
    return;
  }

  for (const providerModule of BUILT_IN_PROVIDER_MODULES) {
    ProviderRegistry.register(providerModule.id, providerModule);
    ProviderWorkspaceRegistry.register(providerModule.id, providerModule.workspace);
  }
  builtInProvidersRegistered = true;
}

registerBuiltInProviders();
