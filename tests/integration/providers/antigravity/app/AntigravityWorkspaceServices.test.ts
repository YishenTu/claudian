import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import {
  antigravityConfigOptions,
  AntigravityNativeProcess,
  antigravitySessionModels,
} from '@test/helpers/providers/antigravity/AntigravityNativeProcess';
import spawn from 'cross-spawn';
import type { Mock } from 'vitest';

import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { ProviderCommandLoaderContext } from '@/core/providers/types';
import { antigravityModelPolicy } from '@/providers/antigravity/AntigravityModelPolicy';
import {
  type AntigravityWorkspaceServices,
  createAntigravityWorkspaceServices,
} from '@/providers/antigravity/app/AntigravityWorkspaceServices';
import { readAntigravitySessionModels } from '@/providers/antigravity/models';
import { updateAntigravityProviderSettings } from '@/providers/antigravity/settings';

vi.mock('cross-spawn', () => ({ default: vi.fn() }));

/** The built-in list agy 1.5.7 publishes for a new default-agent session. */
const AGY_COMMANDS = ['goal', 'compact', 'schedule', 'browser', 'plan', 'grill-me', 'teamwork', 'learn', 'boost',
  'agy-customizations', 'antigravity-guide', 'swarm'].map(name => ({ description: `${name} command`, name }));

let host: ProviderHost;
let persist: Mock<() => Promise<void>>;
let publish: Mock<() => Promise<void>>;
let native: AntigravityNativeProcess;
let services: AntigravityWorkspaceServices;

beforeEach(async () => {
  persist = vi.fn(async () => undefined);
  publish = vi.fn(async () => undefined);
  ({ host } = await createProviderHostFixture({
    overrides: { getResolvedProviderCliPath: async () => 'agy' },
    settings: { providerConfigs: { antigravity: { enabled: true } } },
    beforePersist: async () => { await persist(); },
    afterPublish: async () => { await publish(); },
  }));
  native = new AntigravityNativeProcess();
  native.newSessionId = 'session-probe';
  native.availableCommands = AGY_COMMANDS;
  vi.mocked(spawn).mockImplementation((_command, args) => args?.[0] === 'models' ? native.listModels() : native.child);
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

  it('publishes models and thinking levels without creating an ACP session', async () => {
    await services.modelCatalog!.refresh({ force: true });

    expect(native.newRequests).toEqual([]);
    expect(services.modelCatalog!.getSnapshot().models.map(model => model.id)).toEqual([
      'gemini-4-neon', 'gemini-4-argon', 'gemini-4-hydrogen', 'gemini-pro-orchestrator-neon',
      'gemini-pro-orchestrator-g1-pro', 'gemini-3.8-flash', 'claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-oss-120b-medium',
    ]);
    expect(antigravityModelPolicy.getModelOptions(host.settings)).toEqual([
      { label: 'Gemini 4 Neon', value: 'antigravity/gemini-4-neon' },
      { label: 'Gemini 4 Argon', value: 'antigravity/gemini-4-argon' },
      { label: 'Gemini 4 Hydrogen', value: 'antigravity/gemini-4-hydrogen' },
      { label: 'Orchestrator (Neon)', value: 'antigravity/gemini-pro-orchestrator-neon' },
      { label: 'Orchestrator (Argon)', value: 'antigravity/gemini-pro-orchestrator-g1-pro' },
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

  it('reads every model\'s thinking levels from the standalone list', async () => {
    await services.modelCatalog!.refresh({ force: true });

    expect(levels('gemini-4-neon')).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(levels('gemini-4-hydrogen')).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(levels('gemini-pro-orchestrator-neon')).toEqual([]);
    expect(levels('gemini-pro-orchestrator-g1-pro')).toEqual([]);
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

  it('retries an unsaved live model report when the user refreshes, without creating a discovery session', async () => {
    const report = readAntigravitySessionModels(antigravityConfigOptions(), antigravitySessionModels());
    persist.mockRejectedValueOnce(new Error('Settings write failed'));

    await expect(services.modelCatalogOwner.mergeLiveModels(report.models, report.currentModelId))
      .rejects.toThrow('Settings write failed');
    expect(services.modelCatalog!.getSnapshot().models).toEqual([]);
    const cancelled = new AbortController();
    cancelled.abort();
    await services.modelCatalogOwner.refresh(cancelled.signal);
    expect(persist).toHaveBeenCalledTimes(1);

    await services.modelCatalog!.refresh({ force: true });

    expect(services.modelCatalog!.getSnapshot().models.map(model => model.id)).toContain('gemini-4-argon');
    expect(levels('claude-opus-5-5')).toEqual(['low', 'medium', 'high']);
    expect(spawn).not.toHaveBeenCalled();
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it('does not repeat a durable live catalog write after post-commit publication fails', async () => {
    const report = readAntigravitySessionModels(antigravityConfigOptions(), antigravitySessionModels());
    publish.mockRejectedValueOnce(new Error('Publication failed'));

    await expect(services.modelCatalogOwner.mergeLiveModels(report.models, report.currentModelId))
      .rejects.toThrow('post-commit publication failed');
    await services.modelCatalog!.refresh({ force: true });

    expect(services.modelCatalog!.getSnapshot().models.map(model => model.id)).toContain('gemini-4-argon');
    expect(spawn).not.toHaveBeenCalled();
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it.each([0, 1])('keeps the live report when an earlier discovery exits with %i', async exitCode => {
    native.modelListExitCode = exitCode;
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    native.modelListGate = () => { entered(); return new Promise<void>(resolve => { release = resolve; }); };
    const refresh = services.modelCatalog!.refresh({ force: true });
    await started;
    const live = readAntigravitySessionModels(antigravityConfigOptions());
    await services.modelCatalogOwner.mergeLiveModels(live.models, 'gemini-3.8-flash');

    release();
    await refresh;

    expect(services.modelCatalog!.getSnapshot()).toMatchObject({ defaultModelId: 'gemini-3.8-flash', status: 'ready' });
    // This live report omitted Sonnet's efforts, while the pending standalone list supplies three.
    expect(levels('claude-sonnet-5-5')).toEqual([]);
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

describe('Antigravity catalog for a WSL installation', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  afterEach(() => { Object.defineProperty(process, 'platform', platform); });

  it('keeps a live report when clearing a distro override leaves agy in the same distro', async () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    // Without an override, a vault on a distro's share runs agy in that distro.
    Object.defineProperty(host, 'workingDirectory', { value: '\\\\wsl$\\Debian\\vault' });
    updateAntigravityProviderSettings(host.settings, { installationMethod: 'wsl', wslDistroOverride: 'Debian' });
    const live = readAntigravitySessionModels(antigravityConfigOptions());
    await services.modelCatalogOwner.mergeLiveModels(live.models, live.currentModelId);
    updateAntigravityProviderSettings(host.settings, { wslDistroOverride: '' });

    await services.modelCatalog!.refresh({ force: true });

    // A discovery session would mean the live report was attributed to another distro.
    expect(spawn).not.toHaveBeenCalled();
    expect(services.modelCatalog!.getSnapshot().models.map(model => model.id)).toContain('gemini-4-argon');
  });
});
