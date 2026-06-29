import type { ProviderCommandCatalog } from '../../../core/providers/commands/ProviderCommandCatalog';
import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderTabWarmupPolicy,
  ProviderWorkspaceRegistration,
  ProviderWorkspaceServices,
} from '../../../core/providers/types';
import { CodeBuddyCommandCatalog } from '../commands/CodeBuddyCommandCatalog';
import { CodeBuddyCliResolver } from '../runtime/CodeBuddyCliResolver';
import { codeBuddySettingsTabRenderer } from '../ui/CodeBuddySettingsTab';
import { CodeBuddyRuntimeCommandLoader } from './CodeBuddyRuntimeCommandLoader';

export interface CodeBuddyWorkspaceServices extends ProviderWorkspaceServices {
  commandCatalog: ProviderCommandCatalog;
}

const codeBuddyTabWarmupPolicy: ProviderTabWarmupPolicy = {
  resolveMode() {
    return 'commands';
  },
};

export async function createCodeBuddyWorkspaceServices(): Promise<CodeBuddyWorkspaceServices> {
  return {
    cliResolver: new CodeBuddyCliResolver(),
    commandCatalog: new CodeBuddyCommandCatalog(),
    runtimeCommandLoader: new CodeBuddyRuntimeCommandLoader(),
    settingsTabRenderer: codeBuddySettingsTabRenderer,
    tabWarmupPolicy: codeBuddyTabWarmupPolicy,
  };
}

export const codeBuddyWorkspaceRegistration: ProviderWorkspaceRegistration<CodeBuddyWorkspaceServices> = {
  initialize: async () => createCodeBuddyWorkspaceServices(),
};

export function maybeGetCodeBuddyWorkspaceServices(): CodeBuddyWorkspaceServices | null {
  return ProviderWorkspaceRegistry.getServices('codebuddy') as CodeBuddyWorkspaceServices | null;
}
