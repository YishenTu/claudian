/** @vitest-environment jsdom */
import '@/providers';
import '@test/helpers/ObsidianSettingsDOM';

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { deserialize, serialize } from 'node:v8';

import { axe } from '@test/helpers/accessibility';
import { DEFAULT_CLAUDIAN_SETTINGS } from '@test/helpers/defaultSettings';
import { controlChangeSettled } from '@test/helpers/ObsidianSettingsDOM';
import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import spawn from 'cross-spawn';

import type { ProviderExecutionLifecycleRegistry } from '@/core/execution';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { ClaudianSettings } from '@/core/types';
import { t } from '@/i18n/i18n';
import { createPiWorkspaceServices, type PiWorkspaceServices } from '@/providers/pi/app/PiWorkspaceServices';
import { getPiProviderSettings, updatePiProviderSettings } from '@/providers/pi/settings';

vi.mock('cross-spawn', () => ({ default: vi.fn() }));
vi.mock('obsidian', async () => ({
  ...(await vi.importActual<typeof import('@test/__mocks__/obsidian')>('@test/__mocks__/obsidian')),
  ...(await vi.importActual<typeof import('@test/helpers/ObsidianSettingsDOM')>('@test/helpers/ObsidianSettingsDOM')),
}));

let container: HTMLElement;
let settings: ClaudianSettings;
let persist: ReturnType<typeof vi.fn<(settings: ClaudianSettings) => Promise<void>>>;
let notify: ReturnType<typeof vi.fn<(providerId: string) => void>>;
let fixture: Awaited<ReturnType<typeof createProviderHostFixture>>;
let lifecycle: ProviderExecutionLifecycleRegistry;
let workspace: PiWorkspaceServices;
let renderer: { dispose(): void } | undefined;
let tempRoot: string;
let installationKey: string;

beforeEach(async () => {
  globalThis.structuredClone ??= value => deserialize(serialize(value));
  container = document.body.createDiv();
  settings = structuredClone(DEFAULT_CLAUDIAN_SETTINGS);
  updatePiProviderSettings(settings, { enabled: false });
  persist = vi.fn(async () => undefined);
  notify = vi.fn();
  fixture = await createProviderHostFixture({ settings, beforePersist: persist });
  installationKey = fixture.storage.installationKey;
  settings = fixture.settings;
  lifecycle = fixture.lifecycle;
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-settings-dom-'));
  vi.mocked(spawn).mockClear();
});

afterEach(async () => {
  renderer?.dispose();
  renderer = undefined;
  await workspace?.dispose();
  await fixture.dispose();
  container.remove();
  await fs.rm(tempRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function render() {
  const plugin = fixture.host;
  workspace = await createPiWorkspaceServices(plugin);
  const rendered = workspace.settingsTabRenderer!.render(container, {
    plugin,
    notifyProviderModelOptionsChanged: notify,
    renderCustomContextLimits: () => { throw new Error("Pi does not render custom context limits"); },
  });
  if (!rendered) throw new Error("Pi settings must expose cleanup");
  renderer = rendered;
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
  const reset = vi.spyOn(workspace.cliResolver!, 'reset');
  await setCLIPath(path.join(tempRoot, 'missing'));
  expect(persist).not.toHaveBeenCalled();
  expect(reset).not.toHaveBeenCalled();
  expect(cliInput().getAttribute('aria-invalid')).toBe('true');
  const boundaryPaths: string[] = [];
  const completedTransitions: Array<{ resetCalls: number; discoveredModels: typeof cachedModels }> = [];
  lifecycle.registerTransitionHook('pi', {
    beforeTransition: () => { boundaryPaths.push(getPiProviderSettings(settings).cliPathsByHost[installationKey]); },
    afterTransition: () => {
      boundaryPaths.push(getPiProviderSettings(settings).cliPathsByHost[installationKey]);
      completedTransitions.push({
        resetCalls: reset.mock.calls.length,
        discoveredModels: structuredClone(getPiProviderSettings(settings).discoveredModels),
      });
    },
  });
  await setCLIPath(`"${executable}"`);
  expect(boundaryPaths).toEqual(['/old/pi', `"${executable}"`]);
  expect(completedTransitions).toEqual([{ resetCalls: 1, discoveredModels: cachedModels }]);
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
  const reset = vi.spyOn(workspace.cliResolver!, 'reset');
  if (phase === 'before') lifecycle.registerTransitionHook('pi', { beforeTransition: () => { throw new Error('transition failed'); } });
  else reset.mockImplementationOnce(() => { throw new Error('resolver reset failed'); });
  await setCLIPath(executable);
  expect(getPiProviderSettings(settings).cliPathsByHost).toEqual({ [installationKey]: phase === 'before' ? '/old/pi' : executable });
  expect(cliInput().value).toBe(executable);
  expect(within(container).getByRole('alert').textContent).toBe(t('settings.cliInstallation.saveFailed'));
  expect(notify).not.toHaveBeenCalled();
  expect(reset).toHaveBeenCalledTimes(phase === 'before' ? 0 : 1);
});

it('renders accessible Pi controls without skill or hidden-command management', async () => {
  await render();
  expect(toggle()).toBeTruthy();
  expect(within(container).getByText('Models')).toBeTruthy();
  cliInput();
  for (const name of ['Skills', 'Commands', 'Hidden Pi commands and skills']) expect(within(container).queryByText(name)).toBeNull();
  expect((await axe(container, { runOnly: ['button-name', 'label', 'aria-valid-attr', 'aria-valid-attr-value'] })).violations).toEqual([]);
});
