import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderCliResolver,
  ProviderWorkspaceRegistration,
  ProviderWorkspaceServices,
} from '../../../core/providers/types';
import type { HomeFileAdapter } from '../../../core/storage/HomeFileAdapter';
import type { VaultFileAdapter } from '../../../core/storage/VaultFileAdapter';
import type ClaudianPlugin from '../../../main';
import { CursorCliResolver } from '../runtime/CursorCliResolver';
import { cursorSettingsTabRenderer } from '../ui/CursorSettingsTab';

function createCursorCliResolver(): ProviderCliResolver {
  return new CursorCliResolver();
}

export async function createCursorWorkspaceServices(
  _plugin: ClaudianPlugin,
  _vaultAdapter: VaultFileAdapter,
  _homeAdapter: HomeFileAdapter,
): Promise<ProviderWorkspaceServices> {
  return {
    cliResolver: createCursorCliResolver(),
    settingsTabRenderer: cursorSettingsTabRenderer,
  };
}

export const cursorWorkspaceRegistration: ProviderWorkspaceRegistration = {
  initialize: async ({ plugin, vaultAdapter, homeAdapter }) => createCursorWorkspaceServices(
    plugin,
    vaultAdapter,
    homeAdapter,
  ),
};

export function getCursorWorkspaceServices(): ProviderWorkspaceServices | null {
  return ProviderWorkspaceRegistry.getServices('cursor');
}
