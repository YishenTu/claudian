/** @vitest-environment jsdom */
import '@/providers';

import { axe } from '@test/helpers/accessibility';
import { TEST_CODEX_MODEL } from '@test/helpers/codexModels';
import { controlChangeSettled } from '@test/helpers/ObsidianHost';
import { CodexRuntimeHarness } from '@test/helpers/providers/codex/CodexRuntimeHarness';
import { createCodexWorkspaceHarness } from '@test/helpers/providers/codex/CodexWorkspaceHarness';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import * as fs from 'fs';

import { getInstallationKey } from '@/core/device/InstallationKey';
import { ProviderExecutionTransitionError } from '@/core/execution';
import { CodexExecutionBackend } from '@/providers/codex/execution/CodexExecutionBackend';
import { getCodexProviderSettings } from '@/providers/codex/settings';
import { codexChatUIConfig } from '@/providers/codex/ui/CodexChatUIConfig';

const mockNative = new CodexRuntimeHarness();
vi.mock('fs', async () => ({ ...(await vi.importActual<typeof import('fs')>('fs')) }));
vi.mock('cross-spawn', () => ({ default: vi.fn(() => mockNative.createProcess()) }));

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const fixtures: Awaited<ReturnType<typeof createCodexWorkspaceHarness>>[] = [];
const controls: Array<{ dispose(): void }> = [];
beforeEach(() => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
  mockNative.reset(); mockNative.autoReconcile = true;
  document.body.innerHTML = '<style>.claudian-hidden { display: none; }</style>';
});
afterEach(async () => {
  controls.splice(0).forEach(control => control.dispose());
  await Promise.all(fixtures.splice(0).map(fixture => fixture.dispose()));
  Object.defineProperty(process, 'platform', platform);
  vi.restoreAllMocks(); document.body.replaceChildren();
});
async function render(config: Record<string, unknown> = {}) {
  const fixture = await createCodexWorkspaceHarness(config);
  fixture.resolveCliPath.mockResolvedValue('/native/codex');
  fixtures.push(fixture);
  const container = document.body.createDiv();
  const notify = vi.fn();
  const control = fixture.services.settingsTabRenderer!.render(container, {
    plugin: fixture.plugin, notifyProviderModelOptionsChanged: notify, renderCustomContextLimits() {},
  });
  if (control) controls.push(control);
  return { ...fixture, container, notify };
}
function cliInput(container: HTMLElement) {
  fireEvent.click(within(container).getByRole('button', { name: 'Codex CLI installation' }));
  return within(container).getByRole<HTMLInputElement>('textbox', { name: 'Codex CLI path' });
}
async function toggle(container: HTMLElement, name: string, checked: boolean) {
  const input = within(container).getByRole<HTMLInputElement>('switch', { name });
  fireEvent.change(input, { target: { checked } });
  await controlChangeSettled(input);
  return input;
}
function commitText(input: HTMLInputElement, value: string) {
  fireEvent.input(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

it.each([false, true])('restores automatic CLI detection without retaining legacy paths (host override: %s)', async hasOverride => {
  const key = getInstallationKey();
  const next = await render({ cliPath: '/legacy/codex', cliPathsByHost: { 'other-host': '/keep/codex', ...(hasOverride ? { [key]: '/host/codex' } : {}) } });
  const input = cliInput(next.container);
  expect(input.value).toBe(hasOverride ? '/host/codex' : '/legacy/codex');
  commitText(input, '');
  await waitFor(() => {
    expect(next.saves).toHaveLength(1);
    expect(input.disabled).toBe(false);
  });
  expect(getCodexProviderSettings(next.saves[0]).cliPath).toBe('');
  expect(getCodexProviderSettings(next.settings).cliPathsByHost).toEqual({ 'other-host': '/keep/codex' });
});

it('checks the committed WSL distro and persists Linux CLI commands through a runtime transition', async () => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  const h = await render({ installationMethodsByHost: { [getInstallationKey()]: 'wsl' }, wslDistroOverridesByHost: { [getInstallationKey()]: 'Ubuntu' } });
  await waitFor(() => expect(h.resolveCliPath).toHaveBeenCalledWith('codex', expect.objectContaining({ executionTarget: expect.objectContaining({ distroName: 'Ubuntu' }) })));
  fireEvent.input(within(h.container).getByPlaceholderText('Ubuntu'), { target: { value: 'Debian' } });
  await waitFor(() => expect(h.resolveCliPath).toHaveBeenCalledWith('codex', expect.objectContaining({ executionTarget: expect.objectContaining({ distroName: 'Debian' }) })));
  const input = cliInput(h.container);
  for (const value of ['codex', '"/home/user/my tools/codex"']) {
    commitText(input, value);
    await waitFor(() => {
      expect(getCodexProviderSettings(h.settings).cliPathsByHost[h.plugin.storage.installationKey]).toBe(value);
      expect(input.disabled).toBe(false);
    });
  }
  expect(h.registry.getProviderGeneration('codex')).toBe(3);
  expect(mockNative.processes.flatMap(process => process.requests).filter(rpc => rpc.method === 'model/list')).toEqual([]);
});

it.each(['C:\\Other\\codex.exe', '"C:\\Other\\codex.exe"'])('rejects Windows CLI reference %s in WSL without overwriting the previous path', async value => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  const h = await render({ installationMethodsByHost: { [getInstallationKey()]: 'wsl' }, wslDistroOverridesByHost: { [getInstallationKey()]: 'Ubuntu' }, cliPath: 'C:\\Previous\\codex.exe' });
  const input = cliInput(h.container);
  commitText(input, value);
  expect(input.getAttribute('aria-invalid')).toBe('true');
  expect(h.saves).toEqual([]);
  expect(h.registry.getProviderGeneration('codex')).toBe(0);
  expect(getCodexProviderSettings(h.settings).cliPath).toBe('C:\\Previous\\codex.exe');
});

it('uses host-native validation despite saved WSL settings and accepts quoted existing paths', async () => {
  vi.spyOn(fs, 'existsSync').mockImplementation(path => String(path) === '/my tools/codex');
  vi.spyOn(fs, 'statSync').mockReturnValue({ isFile: () => true } as fs.Stats);
  const h = await render({ installationMethodsByHost: { [getInstallationKey()]: 'wsl' }, wslDistroOverridesByHost: { [getInstallationKey()]: 'Ubuntu' } });
  const input = cliInput(h.container);
  expect(input.placeholder).toBe('/usr/local/bin/codex');
  expect(within(h.container).getByText('Optional CLI path for this computer. Leave empty to detect automatically.')).toBeDefined();
  commitText(input, 'codex');
  expect(input.getAttribute('aria-invalid')).toBe('true');
  expect(h.saves).toEqual([]);
  commitText(input, '"/my tools/codex"');
  await waitFor(() => {
    expect(h.saves).toHaveLength(1);
    expect(input.disabled).toBe(false);
  });
  expect(getCodexProviderSettings(h.settings).cliPathsByHost[h.plugin.storage.installationKey]).toBe('"/my tools/codex"');
});

it('persists response selectors through the complete settings surface', async () => {
  const h = await render({ customModels: 'retired-custom-model' });
  expect(within(h.container).getByRole('heading', { name: 'Models' })).toBeDefined();
  expect(within(h.container).getByRole('heading', { name: 'Responses' })).toBeDefined();
  expect(within(h.container).getByRole('heading', { name: 'Safety' })).toBeDefined();
  expect(within(h.container).queryByRole('combobox', { name: 'Installation method' })).toBeNull();
  expect(within(h.container).queryByRole('textbox', { name: 'WSL distro override' })).toBeNull();
  const forbidden = h.container.createEl('select', { attr: { 'aria-label': 'Installation method' } });
  expect(within(h.container).getByRole('combobox', { name: 'Installation method' })).toBe(forbidden);
  forbidden.remove();
  expect(within(h.container).queryByText('Custom models')).toBeNull();
  for (const [name, key, initial, values] of [
    ['Response style', 'responseStyle', 'pragmatic', [['Friendly', 'friendly'], ['Neutral', 'none'], ['Pragmatic', 'pragmatic']]],
    ['Response verbosity', 'responseVerbosity', 'default', [['Low', 'low'], ['Medium', 'medium'], ['High', 'high'], ['Default', 'default']]],
  ] as const) {
    const select = within(h.container).getByRole<HTMLSelectElement>('combobox', { name });
    expect(select.value).toBe(initial);
    for (const [label, value] of values) {
      const option = within(select).getByRole<HTMLOptionElement>('option', { name: label });
      fireEvent.change(select, { target: { value: option.value } });
      await controlChangeSettled(select);
      expect(getCodexProviderSettings(h.saves.at(-1)!)[key]).toBe(value);
      expect(getCodexProviderSettings(await h.settingsStorage.load())[key]).toBe(value);
    }
  }
  expect(h.settings.providerConfigs.codex).not.toHaveProperty('customModels');
  expect((await axe(h.container)).violations).toEqual([]);
});

it('enables Ultra through real model availability and publishes to chat consumers', async () => {
  const h = await render({ discoveredModels: [{
    model: 'ultra-only', displayName: 'Ultra Only', description: '',
    supportedReasoningEfforts: [{ value: 'ultra', description: 'Delegate' }], defaultReasoningEffort: 'ultra',
    serviceTiers: [], defaultServiceTier: null, inputModalities: ['text'], isDefault: true,
  }], visibleModels: ['ultra-only'] });
  const input = within(h.container).getByRole<HTMLInputElement>('switch', { name: 'Enable ultra effort' });
  expect(input.checked).toBe(false);
  expect(codexChatUIConfig.getModelOptions(h.settings)).toEqual([]);
  expect(within(h.container).getAllByText('Requires Ultra effort to be enabled').length).toBeGreaterThan(0);
  await toggle(h.container, 'Enable ultra effort', true);
  expect(getCodexProviderSettings(h.saves.at(-1)!).enableUltraEffort).toBe(true);
  expect(codexChatUIConfig.getModelOptions(h.settings)).toEqual([expect.objectContaining({ value: 'openai-codex/ultra-only' })]);
  expect(within(h.container).queryByText('Requires Ultra effort to be enabled')).toBeNull();
  expect(h.notify).toHaveBeenCalledWith('codex');
});

it('commits provider enablement within the runtime transition and publishes without discovery', async () => {
  const h = await render({ enabled: false });
  const backend = new CodexExecutionBackend(h.plugin.getRuntimeHost('codex'), () => h.services.runtime);
  const config = {
    lifecycle: 'persistent', nativePersistence: 'enabled', workingDirectory: h.vault.root,
    interactionPort: { requestApproval: vi.fn(), askUserQuestion: vi.fn(), dismissInteraction: vi.fn() },
  } as const;
  const lease = h.registry.acquire(backend, config, 'chat');
  const save = h.settingsStorage.save.bind(h.settingsStorage);
  vi.spyOn(h.settingsStorage, 'save').mockImplementation(async draft => {
    expect(() => h.registry.acquire(backend, config, 'chat')).toThrow(ProviderExecutionTransitionError);
    await save(draft);
  });
  await toggle(h.container, 'Enable Codex', true);
  expect(getCodexProviderSettings(h.saves.at(-1)!).enabled).toBe(true);
  expect(lease.session.getStatus()).toBe('disposed');
  expect(h.registry.getProviderGeneration('codex')).toBe(1);
  expect(mockNative.processes).toHaveLength(0);
  expect(h.notify).toHaveBeenCalledWith('codex');
  await toggle(h.container, 'Enable Codex', false);
  expect(getCodexProviderSettings(h.settings).enabled).toBe(false);
  expect(h.notify).toHaveBeenCalledTimes(2);
});

it.each([false, true])('resynchronizes enablement after a failed transition (committed: %s)', async committed => {
  const h = await render();
  const transition = h.plugin.runProviderExecutionTransition.bind(h.plugin);
  vi.spyOn(h.plugin, 'runProviderExecutionTransition').mockImplementation(async (ids, mutate) => {
    if (committed) await transition(ids, mutate);
    throw new Error('enablement transition failed');
  });
  const input = within(h.container).getByRole<HTMLInputElement>('switch', { name: 'Enable Codex' });
  fireEvent.change(input, { target: { checked: false } });
  await expect(controlChangeSettled(input)).rejects.toThrow('enablement transition failed');
  expect(getCodexProviderSettings(h.settings).enabled).toBe(!committed);
  expect(input.checked).toBe(!committed);
  expect(h.notify).not.toHaveBeenCalled();
});

it('clears the no-model warning after a real model selection without notifying unrelated controls', async () => {
  const h = await render({ visibleModels: [] });
  const warning = within(h.container).getByText('No Codex models are enabled. Go to Models below and enable at least one model.');
  expect(getComputedStyle(warning).display).not.toBe('none');
  const model = within(h.container).getByRole('checkbox', { name: new RegExp(TEST_CODEX_MODEL) });
  fireEvent.click(model);
  await waitFor(() => expect(getCodexProviderSettings(h.settings).visibleModels).toEqual([TEST_CODEX_MODEL]));
  expect(getComputedStyle(warning).display).toBe('none');
  expect(h.notify).not.toHaveBeenCalled();
});
