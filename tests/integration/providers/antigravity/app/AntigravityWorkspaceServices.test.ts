import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { antigravityConfigOptions, AntigravityNativeProcess } from '@test/helpers/providers/antigravity/AntigravityNativeProcess';
import spawn from 'cross-spawn';

import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { ProviderCommandLoaderContext } from '@/core/providers/types';
import { antigravityModelPolicy } from '@/providers/antigravity/AntigravityModelPolicy';
import {
  type AntigravityWorkspaceServices,
  createAntigravityWorkspaceServices,
} from '@/providers/antigravity/app/AntigravityWorkspaceServices';
import { readAntigravitySessionModels } from '@/providers/antigravity/models';

vi.mock('cross-spawn', () => ({ default: vi.fn() }));

/** The built-in list agy 1.5.0 publishes for a new session. */
const AGY_COMMANDS = ['goal', 'compact', 'schedule', 'browser', 'plan', 'grill-me', 'teamwork', 'learn', 'boost',
  'agy-customizations', 'antigravity-guide'].map(name => ({ description: `${name} command`, name }));

let host: ProviderHost;
let native: AntigravityNativeProcess;
let services: AntigravityWorkspaceServices;

beforeEach(async () => {
  ({ host } = await createProviderHostFixture({
    overrides: { getResolvedProviderCliPath: async () => 'agy' },
    settings: { providerConfigs: { antigravity: { enabled: true } } },
  }));
  native = new AntigravityNativeProcess();
  native.newSessionId = 'session-probe';
  native.availableCommands = AGY_COMMANDS;
  vi.mocked(spawn).mockReturnValue(native.child);
  services = await createAntigravityWorkspaceServices(host);
});

afterEach(async () => {
  await services.dispose();
  vi.mocked(spawn).mockReset();
});

function loaderContext(): ProviderCommandLoaderContext {
  return { allowIsolatedMetadataCreation: true, conversation: null, plugin: host };
}

describe('Antigravity workspace metadata discovery', () => {
  it('lists agy commands except the built-ins that cannot work over ACP', async () => {
    const result = await services.commandLoader!.loadCommands(loaderContext());

    if (result.status !== 'ready') throw new Error(`Expected ready commands, got ${result.status}`);
    expect(result.items.map(command => command.name)).toEqual([
      'goal', 'compact', 'grill-me', 'learn', 'agy-customizations', 'antigravity-guide',
    ]);
    // The discovery session is closed without a prompt, so agy does not list it.
    expect(native.closeRequests).toEqual(['session-probe']);
    expect(native.prompts).toHaveLength(0);
  });

  it('publishes the models and thinking levels the session reports', async () => {
    await services.modelCatalog!.refresh({ force: true });

    expect(services.modelCatalog!.getSnapshot().models.map(model => model.id)).toEqual(['gemini-4-argon', 'gemini-3.8-flash']);
    expect(antigravityModelPolicy.getModelOptions(host.settings)).toEqual([
      { label: 'Gemini 4 Argon', value: 'antigravity/gemini-4-argon' },
      { label: 'Gemini 3.8 Flash', value: 'antigravity/gemini-3.8-flash' },
    ]);
    expect(antigravityModelPolicy.getReasoningOptions('antigravity/gemini-4-argon', host.settings)).toEqual([
      { label: 'Low', value: 'low' },
      { label: 'Medium', value: 'medium' },
      { label: 'High', value: 'high' },
    ]);
    expect(antigravityModelPolicy.getDefaultReasoningValue('antigravity/gemini-4-argon', host.settings)).toBe('high');
  });

  it('does not start a discovery session once a live session has reported models', async () => {
    const live = readAntigravitySessionModels(antigravityConfigOptions());
    await services.modelCatalogOwner.mergeLiveModels(live.models, live.currentModelId);

    await services.modelCatalog!.refresh({ force: true });

    expect(spawn).not.toHaveBeenCalled();
    expect(services.modelCatalog!.getSnapshot().models.map(model => model.id)).toEqual(['gemini-4-argon', 'gemini-3.8-flash']);
  });
});
