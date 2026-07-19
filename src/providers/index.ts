import { ProviderRegistry } from '../core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '../core/providers/ProviderWorkspaceRegistry';
import { claudeProviderRegistration } from './claude/registration';
import { codexProviderRegistration } from './codex/registration';
import { kimiProviderRegistration } from './kimi/registration';
import { opencodeProviderRegistration } from './opencode/registration';
import { piProviderRegistration } from './pi/registration';

let builtInProvidersRegistered = false;

export const BUILT_IN_PROVIDER_MODULES = [
  claudeProviderRegistration,
  codexProviderRegistration,
  opencodeProviderRegistration,
  piProviderRegistration,
  kimiProviderRegistration,
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
