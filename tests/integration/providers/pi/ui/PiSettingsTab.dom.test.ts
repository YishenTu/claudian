/** @vitest-environment jsdom */
import '@/providers';

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { deserialize, serialize } from 'node:v8';

import { axe } from '@test/helpers/accessibility';
import { DEFAULT_CLAUDIAN_SETTINGS } from '@test/helpers/defaultSettings';
import { controlChangeSettled } from '@test/helpers/ObsidianHost';
import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { mountProviderSettings } from '@test/helpers/ProviderSettingsHarness';
import { WSLProcessFixture } from '@test/helpers/WSLProcessFixture';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import spawn from 'cross-spawn';

import type { ProviderExecutionLifecycleRegistry } from '@/core/execution';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { ClaudianSettings } from '@/core/types';
import { t } from '@/i18n/i18n';
import { createPiWorkspaceServices, type PiWorkspaceServices } from '@/providers/pi/app/PiWorkspaceServices';
import { getPiProviderSettings, updatePiProviderSettings } from '@/providers/pi/settings';

vi.mock('cross-spawn', () => ({ default: vi.fn() }));

let container: HTMLElement;
let settings: ClaudianSettings;
let persist: ReturnType<typeof vi.fn<(settings: ClaudianSettings) => Promise<void>>>;
let notify: ReturnType<typeof vi.fn<(providerId: string) => void>>;
let fixture: Awaited<ReturnType<typeof createProviderHostFixture>>;
let lifecycle: ProviderExecutionLifecycleRegistry;
let workspace: PiWorkspaceServices;
let tempRoot: string;
let installationKey: string;

beforeEach(async () => {
  globalThis.structuredClone ??= value => deserialize(serialize(value));
  settings = structuredClone(DEFAULT_CLAUDIAN_SETTINGS);
  updatePiProviderSettings(settings, { enabled: false });
  persist = vi.fn(async () => undefined);
  notify = vi.fn();
  fixture = await createProviderHostFixture({ settings, beforePersist: persist });
  installationKey = fixture.storage.installationKey;
  settings = fixture.settings;
  lifecycle = fixture.lifecycle;
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-settings-dom-'));
  vi.mocked(spawn).mockReset();
});

afterEach(async () => {
  await workspace?.dispose();
  await fixture.dispose();
  await fs.rm(tempRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function render() {
  const plugin = fixture.host;
  workspace = await createPiWorkspaceServices(plugin);
  ({ container } = mountProviderSettings(workspace.settingsTabRenderer!, plugin, {
    notifyProviderModelOptionsChanged: notify,
    renderCustomContextLimits: () => { throw new Error("Pi does not render custom context limits"); },
  }));
  return fixture.coordinator;
}

function toggle(): HTMLInputElement {
  return within(container).getByRole('switch', { name: 'Enable Pi' }) as HTMLInputElement;
}

async function changeEnabled(enabled: boolean): Promise<void> {
  const input = toggle();
  fireEvent.change(input, { target: { checked: enabled } });
  await controlChangeSettled(input);
}

function cliInput(): HTMLInputElement {
  const disclosure = within(container).getByRole('button', { name: 'Pi installation' });
  if (disclosure.getAttribute('aria-expanded') === 'false') fireEvent.click(disclosure);
  return within(container).getByRole('textbox', { name: 'CLI path' }) as HTMLInputElement;
}

async function setCLIPath(value: string): Promise<void> {
  const input = cliInput();
  fireEvent.input(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(input.disabled).toBe(false));
}

it('commits enablement inside the provider transition without launching metadata', async () => {
  await render();
  const boundaryValues: boolean[] = [];
  lifecycle.registerTransitionHook('pi', {
    beforeTransition: () => { boundaryValues.push(getPiProviderSettings(settings).enabled); },
    afterTransition: () => { boundaryValues.push(getPiProviderSettings(settings).enabled); },
  });
  await changeEnabled(true);
  expect(boundaryValues).toEqual([false, true]);
  expect(getPiProviderSettings(settings).enabled).toBe(true);
  expect(toggle().checked).toBe(true);
  expect(persist).toHaveBeenCalled();
  expect(notify).toHaveBeenCalledWith('pi');
  expect(spawn).not.toHaveBeenCalled();
});

it('rejects disabling the final provider and restores the rendered toggle', async () => {
  for (const id of ProviderRegistry.getRegisteredProviderIds()) ProviderRegistry.setEnabled(id, settings, id === 'pi');
  await render();
  expect(toggle().checked).toBe(true);
  await changeEnabled(false);
  expect(toggle().checked).toBe(true);
  expect(getPiProviderSettings(settings).enabled).toBe(true);
  expect(persist).not.toHaveBeenCalled();
  expect(notify).not.toHaveBeenCalled();
  expect(within(container).getByText(t('settings.providerEnablement.lastProviderWarning'))).toBeTruthy();
});

it.each(['before', 'after'] as const)('resynchronizes the toggle to durable settings when %s-transition fails', async phase => {
  await render();
  lifecycle.registerTransitionHook('pi', {
    beforeTransition: () => { if (phase === 'before') throw new Error('transition failed'); },
    afterTransition: () => { if (phase === 'after') throw new Error('transition failed'); },
  });
  await expect(changeEnabled(true)).rejects.toThrow();
  expect(getPiProviderSettings(settings).enabled).toBe(phase === 'after');
  expect(toggle().checked).toBe(phase === 'after');
  expect(notify).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
});

it.each([false, true])('clears legacy and host CLI overrides when restoring automatic detection (host override: %s)', async hasHostOverride => {
  updatePiProviderSettings(settings, {
    cliPath: '/legacy/pi',
    cliPathsByHost: { 'other-host': '/keep/pi', ...(hasHostOverride ? { [installationKey]: '/host/pi' } : {}) },
  });
  await render();
  expect(cliInput().value).toBe(hasHostOverride ? '/host/pi' : '/legacy/pi');
  await setCLIPath('');
  expect(getPiProviderSettings(settings).cliPath).toBe('');
  expect(getPiProviderSettings(settings).cliPathsByHost).toEqual({ 'other-host': '/keep/pi' });
});

it('validates CLI paths and commits a quoted path while retaining discovery inside the transition', async () => {
  const executable = path.join(tempRoot, 'my tools', 'pi');
  await fs.mkdir(path.dirname(executable));
  await fs.writeFile(executable, '#!/bin/sh\n');
  const cachedModels: ReturnType<typeof getPiProviderSettings>['discoveredModels'] = [
    { encodedId: 'pi:test/cached', id: 'cached', provider: 'test', label: 'Cached', input: ['text'], reasoning: false, thinkingLevels: ['off'] },
  ];
  updatePiProviderSettings(settings, {
    cliPathsByHost: { [installationKey]: '/old/pi' },
    discoveredModels: cachedModels,
  });
  await render();
  await setCLIPath(path.join(tempRoot, 'missing'));
  expect(persist).not.toHaveBeenCalled();
  expect(cliInput().getAttribute('aria-invalid')).toBe('true');
  const boundaryPaths: string[] = [];
  const completedTransitions: Array<{ resolvedPath: string | null; discoveredModels: typeof cachedModels }> = [];
  lifecycle.registerTransitionHook('pi', {
    beforeTransition: () => { boundaryPaths.push(getPiProviderSettings(settings).cliPathsByHost[installationKey]); },
    afterTransition: async () => {
      boundaryPaths.push(getPiProviderSettings(settings).cliPathsByHost[installationKey]);
      completedTransitions.push({
        resolvedPath: await workspace.cliResolver!.resolveFromSettings(settings),
        discoveredModels: structuredClone(getPiProviderSettings(settings).discoveredModels),
      });
    },
  });
  await setCLIPath(`"${executable}"`);
  expect(boundaryPaths).toEqual(['/old/pi', `"${executable}"`]);
  expect(completedTransitions).toEqual([{ resolvedPath: executable, discoveredModels: cachedModels }]);
  expect(getPiProviderSettings(settings).cliPathsByHost).toEqual({ [installationKey]: `"${executable}"` });
  expect(cliInput().value).toBe(`"${executable}"`);
  expect(persist).toHaveBeenCalled();
  expect(notify).toHaveBeenCalledWith('pi');
  expect(within(container).getByRole('alert').textContent).toBe('');
});

it.each(['before', 'after'] as const)('keeps the CLI input consistent when a failure occurs %s commit', async phase => {
  const executable = path.join(tempRoot, 'pi');
  await fs.writeFile(executable, '#!/bin/sh\n');
  updatePiProviderSettings(settings, { cliPathsByHost: { [installationKey]: '/old/pi' } });
  await render();
  lifecycle.registerTransitionHook('pi', phase === 'before'
    ? { beforeTransition: () => { throw new Error('transition failed'); } }
    : { afterTransition: () => { throw new Error('transition completion failed'); } });
  await setCLIPath(executable);
  expect(getPiProviderSettings(settings).cliPathsByHost).toEqual({ [installationKey]: phase === 'before' ? '/old/pi' : executable });
  expect(cliInput().value).toBe(executable);
  expect(within(container).getByRole('alert').textContent).toBe(t('settings.cliInstallation.saveFailed'));
  expect(notify).not.toHaveBeenCalled();
});

it('renders accessible Pi controls without skill or hidden-command management', async () => {
  await render();
  expect(toggle()).toBeTruthy();
  expect(within(container).getByText('Models')).toBeTruthy();
  cliInput();
  for (const name of ['Skills', 'Commands', 'Hidden Pi commands and skills']) expect(within(container).queryByText(name)).toBeNull();
  expect((await axe(container, { runOnly: ['button-name', 'label', 'aria-valid-attr', 'aria-valid-attr-value'] })).violations).toEqual([]);
});

it('preserves spaces typed into the real Pi WSL CLI path until the final commit', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  // The Linux CLI inspection runs through wsl.exe; the fixture models an installation lookup that finds nothing.
  const native = new WSLProcessFixture();
  vi.mocked(spawn).mockImplementation(native.spawn);
  try {
    updatePiProviderSettings(settings, { enabled: true, installationMethodsByHost: { [installationKey]: 'wsl' } });
    await render();
    const input = cliInput();
    expect(getPiProviderSettings(settings).installationMethod).toBe('wsl');
    input.focus();
    const typed = '/home/user/my tools/pi';
    for (const character of typed) {
      fireEvent.input(input, { target: { value: input.value + character } });
      await Promise.resolve();
    }
    expect(getPiProviderSettings(settings).cliPathsByHost[installationKey]).toBeUndefined();
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(getPiProviderSettings(settings).cliPathsByHost[installationKey]).toBe(typed));
    expect(getPiProviderSettings(await fixture.settingsStorage.load()).cliPathsByHost[installationKey]).toBe(typed);
    expect(input.value).toBe(typed);
    const method = within(container).getByRole('combobox', { name: 'Installation method' });
    const distro = within(container).getByRole('textbox', { name: 'WSL distro override' }) as HTMLInputElement;
    expect(distro.disabled).toBe(false);
    fireEvent.change(method, { target: { value: 'native-windows' } });
    await waitFor(() => expect(distro.disabled).toBe(true));
    expect(getPiProviderSettings(settings).installationMethod).toBe('native-windows');
    fireEvent.change(method, { target: { value: 'wsl' } });
    await waitFor(() => expect(distro.disabled).toBe(false));
    fireEvent.input(distro, { target: { value: 'Debian' } });
    await waitFor(() => expect(getPiProviderSettings(settings).wslDistroOverride).toBe('Debian'));
    expect((await axe(method.parentElement!)).violations).toEqual([]);
    expect((await axe(distro.parentElement!)).violations).toEqual([]);
    expect((await axe(input.closest('.claudian-cli-installation')!)).violations).toEqual([]);
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }
});
