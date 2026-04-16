import { ProviderRegistry } from '../core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '../core/providers/ProviderWorkspaceRegistry';
import { claudeWorkspaceRegistration } from './claude/app/ClaudeWorkspaceServices';
import { claudeProviderRegistration } from './claude/registration';
import { codexWorkspaceRegistration } from './codex/app/CodexWorkspaceServices';
import { codexProviderRegistration } from './codex/registration';
import { acpProviderRegistration } from './acp/registration';

let builtInProvidersRegistered = false;

export function registerBuiltInProviders(): void {
  if (builtInProvidersRegistered) {
    return;
  }

  ProviderRegistry.register('claude', claudeProviderRegistration);
  ProviderRegistry.register('codex', codexProviderRegistration);
  ProviderRegistry.register('acp', acpProviderRegistration);
  ProviderWorkspaceRegistry.register('claude', claudeWorkspaceRegistration);
  ProviderWorkspaceRegistry.register('codex', codexWorkspaceRegistration);
  builtInProvidersRegistered = true;
}

registerBuiltInProviders();
