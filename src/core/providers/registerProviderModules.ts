import { ProviderRegistry } from './ProviderRegistry';
import { ProviderWorkspaceRegistry } from './ProviderWorkspaceRegistry';
import type { ProviderModule } from './types';

/** Registers each provider module's runtime and workspace registrations. */
export function registerProviderModules(modules: readonly ProviderModule[]): void {
  for (const providerModule of modules) {
    ProviderRegistry.register(providerModule.id, providerModule);
    ProviderWorkspaceRegistry.register(providerModule.id, providerModule.workspace);
  }
}
