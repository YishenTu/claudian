import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import {
  antigravityConfigOptions,
  AntigravityNativeProcess,
  antigravitySessionModels,
} from '@test/helpers/providers/antigravity/AntigravityNativeProcess';
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

function levels(model: string): string[] {
  return antigravityModelPolicy.getReasoningOptions(`antigravity/${model}`, host.settings).map(option => option.value);
}

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

    expect(services.modelCatalog!.getSnapshot().models.map(model => model.id)).toEqual(['gemini-4-argon', 'gemini-3.8-flash', 'claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-oss-120b-medium']);
    expect(antigravityModelPolicy.getModelOptions(host.settings)).toEqual([
      { label: 'Gemini 4 Argon', value: 'antigravity/gemini-4-argon' },
      { label: 'Gemini 3.8 Flash', value: 'antigravity/gemini-3.8-flash' },
      { label: 'Claude Opus 5.5', value: 'antigravity/claude-opus-5-5' },
      { label: 'Claude Sonnet 5.5', value: 'antigravity/claude-sonnet-5-5' },
      { label: 'GPT-OSS 120B (Medium)', value: 'antigravity/gpt-oss-120b-medium' },
    ]);
    expect(antigravityModelPolicy.getReasoningOptions('antigravity/gemini-4-argon', host.settings)).toEqual([
      { label: 'Low', value: 'low' },
      { label: 'Medium', value: 'medium' },
      { label: 'High', value: 'high' },
    ]);
    expect(antigravityModelPolicy.getDefaultReasoningValue('antigravity/gemini-4-argon', host.settings)).toBe('high');
  });

  it('reads every model\'s thinking levels from the session report without switching models', async () => {
    await services.modelCatalog!.refresh({ force: true });

    expect(levels('gemini-4-argon')).toEqual(['low', 'medium', 'high']);
    expect(levels('claude-opus-5-5')).toEqual(['low', 'medium', 'high']);
    // GPT-OSS runs at a fixed medium effort, so agy offers no thinking level for it.
    expect(levels('gpt-oss-120b-medium')).toEqual([]);
    expect(native.configRequests).toEqual([]);
  });

  it('gives a model no borrowed thinking levels when a live session reports before discovery', async () => {
    const report = readAntigravitySessionModels(antigravityConfigOptions(), antigravitySessionModels());

    await services.modelCatalogOwner.mergeLiveModels(report.models, report.currentModelId);

    expect(levels('claude-sonnet-5-5')).toEqual(['low', 'medium', 'high']);
    expect(levels('gpt-oss-120b-medium')).toEqual([]);
  });

  it('does not start a discovery session once a live session has reported models', async () => {
    const live = readAntigravitySessionModels(antigravityConfigOptions());
    await services.modelCatalogOwner.mergeLiveModels(live.models, live.currentModelId);

    await services.modelCatalog!.refresh({ force: true });

    expect(spawn).not.toHaveBeenCalled();
    expect(services.modelCatalog!.getSnapshot().models.map(model => model.id)).toEqual(['gemini-4-argon', 'gemini-3.8-flash', 'claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-oss-120b-medium']);
  });

  it('keeps the live report when a discovery started earlier finishes later', async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    native.newSessionGate = () => { entered(); return new Promise<void>(resolve => { release = resolve; }); };
    const refresh = services.modelCatalog!.refresh({ force: true });
    await started;
    const live = readAntigravitySessionModels(antigravityConfigOptions());
    await services.modelCatalogOwner.mergeLiveModels(live.models, 'gemini-3.8-flash');

    release();
    await refresh;

    expect(services.modelCatalog!.getSnapshot().defaultModelId).toBe('gemini-3.8-flash');
  });

  it('keeps every model\'s thinking levels when a live session is on a fixed-effort model', async () => {
    const live = antigravityConfigOptions()
      .filter(option => option.id !== 'thought_level')
      .map(option => (option.id === 'model' ? { ...option, currentValue: 'gpt-oss-120b-medium' } : option));
    const report = readAntigravitySessionModels(live, antigravitySessionModels());

    await services.modelCatalogOwner.mergeLiveModels(report.models, report.currentModelId);

    expect(levels('gemini-4-argon')).toEqual(['low', 'medium', 'high']);
    expect(levels('claude-sonnet-5-5')).toEqual(['low', 'medium', 'high']);
    expect(levels('gpt-oss-120b-medium')).toEqual([]);
  });
});
