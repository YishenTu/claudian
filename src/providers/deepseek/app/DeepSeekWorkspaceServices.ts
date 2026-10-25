import { parseEnvironmentVariables } from '@/core/process/env';
import type { ProviderModelCatalogController } from '@/core/providers/models/ProviderModelCatalog';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import type { ProviderWorkspaceRegistration, ProviderWorkspaceServices } from '@/core/providers/types';

import { DeepSeekCommandCatalog } from '../commands/DeepSeekCommandCatalog';
import { decodeDeepSeekConfig } from '../config';
import { DeepSeekSessionArchiveService } from '../history/DeepSeekSessionArchiveService';
import { DeepSeekCLIResolver } from '../runtime/DeepSeekCLIResolver';
import { DeepSeekHost, type DeepSeekProcessFactory } from '../runtime/DeepSeekHost';
import { DeepSeekHostProcess } from '../runtime/DeepSeekHostProcess';
import { createDeepSeekModels } from '../runtime/DeepSeekModels';
import { parseDeepSeekPresetPlugins } from '../runtime/DeepSeekPresetPlugins';
import { createDeepSeekSettingsTabRenderer } from '../ui/DeepSeekSettingsTab';
import { createDeepSeekCommandLoader } from './DeepSeekCommandLoader';

export interface DeepSeekWorkspaceServices extends ProviderWorkspaceServices {
  readonly cliResolver: DeepSeekCLIResolver;
  /** The workspace's single native Host, shared by every DeepSeek session and history read. */
  readonly deepseek: DeepSeekHost;
  readonly modelCatalog: ProviderModelCatalogController;
}

export function createDeepSeekWorkspaceServices(host: ProviderHost, start: DeepSeekProcessFactory = (options, signal) => DeepSeekHostProcess.start(options, signal)): DeepSeekWorkspaceServices {
  const runtimeHost = host.getRuntimeHost('deepseek');
  const cliResolver = new DeepSeekCLIResolver();
  const deepseek = new DeepSeekHost(async () => {
    const cliPath = await runtimeHost.resolveCliPath();
    if (!cliPath) throw new Error('DeepSeek Harness was not found. Install and configure dsh or DeepSeek Harness Desktop, or set its path in settings.');
    const environment = { ...process.env, ...parseEnvironmentVariables(runtimeHost.environmentText) };
    const presetPlugins = parseDeepSeekPresetPlugins(decodeDeepSeekConfig(runtimeHost.config).presetPlugins);
    return { cliPath, environment, cwd: host.workingDirectory ?? process.cwd(), presetPlugins };
  }, start, undefined, host.sessionToolEndpoint);
  const modelCatalog = createDeepSeekModels(runtimeHost, signal => deepseek.read(client => client.call('session/modelCatalog'), signal));
  const sessionArchive = new DeepSeekSessionArchiveService(deepseek);
  // Execution leases are released before these hooks run; the Host then restarts lazily with the new settings.
  const offTransition = host.executionLifecycleRegistry.registerTransitionHook('deepseek', {
    beforeTransition: async () => { modelCatalog.beginTransition(); await sessionArchive.beginTransition(); await deepseek.beginTransition(); await modelCatalog.quiesce(); },
    afterTransition: async () => { cliResolver.reset(); deepseek.endTransition(); modelCatalog.endTransition(); sessionArchive.endTransition(); },
  });
  return {
    startRuntime: () => deepseek.start(),
    cliResolver, deepseek, modelCatalog, commandCatalog: new DeepSeekCommandCatalog(), commandLoader: createDeepSeekCommandLoader(deepseek), settingsTabRenderer: createDeepSeekSettingsTabRenderer({ cliResolver, modelCatalog }), sessionArchive,
    async dispose() { offTransition(); await Promise.all([modelCatalog.dispose(), sessionArchive.dispose()]); await deepseek.dispose(); },
  };
}


export const deepseekWorkspaceRegistration: ProviderWorkspaceRegistration<DeepSeekWorkspaceServices> = {
  consumesAgentSkills: true,
  providesSessionArchive: true,
  initialize: async ({ plugin }) => createDeepSeekWorkspaceServices(plugin),
};

export function getDeepSeekWorkspaceServices(): DeepSeekWorkspaceServices {
  return ProviderWorkspaceRegistry.requireServices('deepseek') as DeepSeekWorkspaceServices;
}
