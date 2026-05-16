import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderCliResolver,
  ProviderWorkspaceRegistration,
  ProviderWorkspaceServices,
} from '../../../core/providers/types';
import { CursorCliResolver } from '../runtime/CursorCliResolver';
import { cursorSettingsTabRenderer } from '../ui/CursorSettingsTab';

export interface CursorWorkspaceServices extends ProviderWorkspaceServices {
  cliResolver: ProviderCliResolver;
}

export async function createCursorWorkspaceServices(): Promise<CursorWorkspaceServices> {
  return {
    cliResolver: new CursorCliResolver(),
    settingsTabRenderer: cursorSettingsTabRenderer,
  };
}

export const cursorWorkspaceRegistration: ProviderWorkspaceRegistration<CursorWorkspaceServices> = {
  initialize: async () => createCursorWorkspaceServices(),
};

export function maybeGetCursorWorkspaceServices(): CursorWorkspaceServices | null {
  return ProviderWorkspaceRegistry.getServices('cursor') as CursorWorkspaceServices | null;
}

export function getCursorWorkspaceServices(): CursorWorkspaceServices {
  return ProviderWorkspaceRegistry.requireServices('cursor') as CursorWorkspaceServices;
}
