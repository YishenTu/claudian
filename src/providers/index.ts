import { ProviderRegistry } from '../core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '../core/providers/ProviderWorkspaceRegistry';
import { claudeWorkspaceRegistration } from './claude/app/ClaudeWorkspaceServices';
import { claudeProviderRegistration } from './claude/registration';
import { codexWorkspaceRegistration } from './codex/app/CodexWorkspaceServices';
import { codexProviderRegistration } from './codex/registration';
import { opencodeWorkspaceRegistration } from './opencode/app/OpencodeWorkspaceServices';
import { opencodeProviderRegistration } from './opencode/registration';
import { piWorkspaceRegistration } from './pi/app/PiWorkspaceServices';
import { piProviderRegistration } from './pi/registration';

let builtInProvidersRegistered = false;

export function registerBuiltInProviders(): void {
  if (builtInProvidersRegistered) {
    return;
  }

  ProviderRegistry.register('claude', claudeProviderRegistration);
  ProviderRegistry.register('codex', codexProviderRegistration);
  ProviderRegistry.register('opencode', opencodeProviderRegistration);
  ProviderRegistry.register('pi', piProviderRegistration);
  ProviderWorkspaceRegistry.register('claude', claudeWorkspaceRegistration);
  ProviderWorkspaceRegistry.register('codex', codexWorkspaceRegistration);
  ProviderWorkspaceRegistry.register('opencode', opencodeWorkspaceRegistration);
  ProviderWorkspaceRegistry.register('pi', piWorkspaceRegistration);
  builtInProvidersRegistered = true;
}

registerBuiltInProviders();
