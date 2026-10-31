/** @vitest-environment jsdom */
import '@/providers';

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { deserialize, serialize } from 'node:v8';

import { axe } from '@test/helpers/accessibility';
import { controlChangeSettled } from '@test/helpers/ObsidianHost';
import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { writeGrokCatalog } from '@test/helpers/providers/grokSettings';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import spawn from 'cross-spawn';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import type { ClaudianSettings } from '@/core/types';
import { t } from '@/i18n/i18n';
import { createGrokWorkspaceServices, type GrokWorkspaceServices } from '@/providers/grok/app/GrokWorkspaceServices';
import { getGrokProviderSettings, updateGrokProviderSettings } from '@/providers/grok/settings';
import { grokSettingsTabRenderer } from '@/providers/grok/ui/GrokSettingsTab';

vi.mock('cross-spawn', () => ({ default: vi.fn(() => { throw new Error('Native CLI unavailable in settings test'); }) }));

let fixture: Awaited<ReturnType<typeof createProviderHostFixture>>;
let workspace: GrokWorkspaceServices;
let container: HTMLElement;
let renderer: { dispose(): void } | undefined;
let persist: ReturnType<typeof vi.fn<(settings: ClaudianSettings) => Promise<void>>>;
let notify: ReturnType<typeof vi.fn<(providerId: string) => void>>;

function makeCatalog() {
  return {
    defaultModelId: 'grok-4', fingerprint: 'catalog', refreshedAt: Date.now(),
    models: [
      { defaultReasoningEffort: 'medium', displayName: 'Grok 4', rawId: 'grok-4',
        reasoningMetadataResolved: true, reasoningEfforts: [
          { label: 'Low', value: 'low' }, { label: 'Medium', value: 'medium' }, { label: 'High', value: 'high' },
        ], supportsReasoning: true },
      { displayName: 'Kimi Coding', rawId: 'kimi-coding', reasoningEfforts: [], supportsReasoning: false },
    ],
  };
}

beforeEach(async () => {
  globalThis.structuredClone ??= value => deserialize(serialize(value));
  persist = vi.fn(async () => undefined);
  notify = vi.fn();
  fixture = await createProviderHostFixture({ beforePersist: persist });
  updateGrokProviderSettings(fixture.settings, {
    enabled: true, visibleModels: ['grok-4'], preferredReasoningByModel: { 'grok-4': 'medium' },
  });
  writeGrokCatalog(fixture.settings, makeCatalog());
  workspace = await createGrokWorkspaceServices(fixture.host);
  ProviderWorkspaceRegistry.setServices('grok', workspace);
  container = document.body.createDiv();
  vi.mocked(spawn).mockClear();
});

afterEach(async () => {
  renderer?.dispose();
  renderer = undefined;
  await workspace.dispose();
  ProviderWorkspaceRegistry.setServices('grok', undefined);
  await fixture.dispose();
  container.remove();
  vi.restoreAllMocks();
});

async function render(): Promise<void> {
  const rendered = grokSettingsTabRenderer.render(container, {
    plugin: fixture.host, notifyProviderModelOptionsChanged: notify, renderCustomContextLimits: () => undefined,
  });
  if (!rendered) throw new Error('Grok settings must expose cleanup');
  renderer = rendered;
  await workspace.modelCatalog!.refresh();
}

function toggle(): HTMLInputElement {
  return within(container).getByRole('switch', { name: 'Enable Grok Build' }) as HTMLInputElement;
}
async function changeEnabled(): Promise<void> {
  const input = toggle();
  fireEvent.change(input);
  await controlChangeSettled(input);
}
function cliInput(): HTMLInputElement {
  const disclosure = within(container).getByRole('button', { name: 'Grok Build installation' });
  if (disclosure.getAttribute('aria-expanded') === 'false') fireEvent.click(disclosure);
  return within(container).getByRole('textbox', { name: 'CLI path' }) as HTMLInputElement;
}
async function setCLIPath(value: string): Promise<void> {
  const input = cliInput();
  fireEvent.input(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(input.disabled).toBe(false));
}
async function executable(name = 'grok'): Promise<string> {
  const file = path.join(fixture.vault.root, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '#!/bin/sh\n', { mode: 0o755 });
  return file;
}
function expectSuccessfulSave(): void {
  expect(notify).toHaveBeenCalledWith('grok');
  expect(within(container).getByRole('alert').textContent).toBe('');
}

it('commits Grok enablement inside a transition without creating metadata', async () => {
  updateGrokProviderSettings(fixture.settings, { enabled: false });
  const boundaries: boolean[] = [];
  fixture.lifecycle.registerTransitionHook('grok', {
    beforeTransition: () => { boundaries.push(getGrokProviderSettings(fixture.settings).enabled); },
    afterTransition: () => { boundaries.push(getGrokProviderSettings(fixture.settings).enabled); },
  });
  await render();
  await changeEnabled();
  expect(boundaries).toEqual([false, true]);
  expect(getGrokProviderSettings(fixture.settings).enabled).toBe(true);
  expect(toggle().checked).toBe(true);
  expect(toggle().getAttribute('aria-checked')).toBe('true');
  expect(persist).toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
  expect(notify).toHaveBeenCalledWith('grok');
});

it('resynchronizes the Grok toggle when disabling the final provider is rejected', async () => {
  for (const id of ProviderRegistry.getRegisteredProviderIds()) ProviderRegistry.setEnabled(id, fixture.settings, id === 'grok');
  await render();
  await changeEnabled();
  expect(toggle().checked).toBe(true);
  expect(toggle().getAttribute('aria-checked')).toBe('true');
  expect(getGrokProviderSettings(fixture.settings).enabled).toBe(true);
  expect(persist).not.toHaveBeenCalled();
  expect(notify).not.toHaveBeenCalled();
  expect(within(container).getByText(t('settings.providerEnablement.lastProviderWarning'))).toBeTruthy();
});

it('resynchronizes the Grok toggle when the enablement transition fails', async () => {
  const transitionError = new Error('transition failed');
  fixture.lifecycle.registerTransitionHook('grok', { beforeTransition: () => { throw transitionError; } });
  await render();
  vi.mocked(spawn).mockClear();
  await expect(changeEnabled()).rejects.toBe(transitionError);
  expect(toggle().checked).toBe(true);
  expect(toggle().getAttribute('aria-checked')).toBe('true');
  expect(getGrokProviderSettings(fixture.settings).enabled).toBe(true);
  expect(persist).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
  expect(notify).not.toHaveBeenCalled();
});

it.skipIf(process.platform === 'win32')('validates an executable CLI file before persisting it', async () => {
  const file = await executable();
  await fs.chmod(file, 0o644);
  await render();
  await setCLIPath(file);
  expect(persist).not.toHaveBeenCalled();
  expect(cliInput().getAttribute('aria-invalid')).toBe('true');
  expect(within(container).getByRole('alert').textContent).toBe(t('settings.cliPath.validation.notExecutable'));
  await fs.chmod(file, 0o755);
  await setCLIPath(file);
  expect(getGrokProviderSettings(fixture.settings).cliPathsByHost).toEqual({ [fixture.storage.installationKey]: file });
  expectSuccessfulSave();
});

it('accepts a CLI path pasted with surrounding quotes', async () => {
  const file = await executable('my tools/grok');
  await render();
  await setCLIPath(`"${file}"`);
  expect(getGrokProviderSettings(fixture.settings).cliPathsByHost).toEqual({ [fixture.storage.installationKey]: `"${file}"` });
  expectSuccessfulSave();
});

it('retains the CLI path draft for retry after a pre-commit write failure', async () => {
  const file = await executable();
  persist.mockRejectedValueOnce(new Error('write failed'));
  const transitions: string[] = [];
  fixture.lifecycle.registerTransitionHook('grok', { beforeTransition: () => { transitions.push('start'); } });
  await render();
  await setCLIPath(file);
  expect(getGrokProviderSettings(fixture.settings).cliPathsByHost).toEqual({});
  expect(cliInput().value).toBe(file);
  expect(within(container).getByRole('alert').textContent).toBe(t('settings.cliInstallation.saveFailed'));
  expect(notify).not.toHaveBeenCalled();
  await setCLIPath(file);
  expect(transitions).toEqual(['start', 'start']);
  expect(persist).toHaveBeenCalledTimes(2);
  expect(getGrokProviderSettings(fixture.settings).cliPathsByHost).toEqual({ [fixture.storage.installationKey]: file });
  expectSuccessfulSave();
});

it('keeps a committed CLI path after recycle failure and allows reverting it', async () => {
  const file = await executable();
  const reset = vi.spyOn(workspace.cliResolver, 'reset').mockImplementationOnce(() => { throw new Error('recycle failed'); });
  const transitions: string[] = [];
  fixture.lifecycle.registerTransitionHook('grok', { beforeTransition: () => { transitions.push('start'); } });
  await render();
  await setCLIPath(file);
  expect(getGrokProviderSettings(fixture.settings).cliPathsByHost).toEqual({ [fixture.storage.installationKey]: file });
  expect(cliInput().value).toBe(file);
  expect(within(container).getByRole('alert').textContent).toBe(t('settings.cliInstallation.saveFailed'));
  expect(notify).not.toHaveBeenCalled();
  await setCLIPath('');
  expect(transitions).toEqual(['start', 'start']);
  expect(persist).toHaveBeenCalledTimes(2);
  expect(reset).toHaveBeenCalledTimes(2);
  expect(getGrokProviderSettings(fixture.settings).cliPathsByHost).toEqual({});
  expectSuccessfulSave();
});

it('rejects an existing relative CLI path', async () => {
  const file = await executable();
  const relative = path.relative(process.cwd(), file);
  await render();
  await setCLIPath(relative);
  expect(persist).not.toHaveBeenCalled();
  expect(cliInput().getAttribute('aria-invalid')).toBe('true');
  expect(within(container).getByRole('alert').textContent).toBe(t('settings.cliPath.validation.mustBeAbsolute'));
});

it('retains the current catalog and resets the resolver inside a provider execution transition', async () => {
  const file = await executable();
  const catalog = structuredClone(getGrokProviderSettings(fixture.settings).currentCatalog);
  const reset = vi.spyOn(workspace.cliResolver, 'reset');
  const boundaries: Array<{ path: string | undefined; resets: number; models: typeof catalog }> = [];
  const observe = () => { boundaries.push({
    path: getGrokProviderSettings(fixture.settings).cliPathsByHost[fixture.storage.installationKey],
    resets: reset.mock.calls.length, models: structuredClone(getGrokProviderSettings(fixture.settings).currentCatalog),
  }); };
  fixture.lifecycle.registerTransitionHook('grok', { beforeTransition: observe, afterTransition: observe });
  await render();
  await setCLIPath(file);
  expect(boundaries).toEqual([{ path: undefined, resets: 0, models: catalog }, { path: file, resets: 1, models: catalog }]);
  expect(getGrokProviderSettings(fixture.settings).currentCatalog?.models).toHaveLength(2);
  expectSuccessfulSave();
});

it('renders only the Grok environment scope without skill or command sections', async () => {
  updateGrokProviderSettings(fixture.settings, { environmentVariables: 'GROK_PROFILE=review' });
  await render();
  expect(within(container).getByRole('heading', { name: 'Models' })).toBeTruthy();
  expect(within(container).getByRole('heading', { name: 'Environment' })).toBeTruthy();
  const environment = within(container).getByRole('textbox', { name: t('settings.grok.environment.name') }) as HTMLTextAreaElement;
  expect(environment.value).toBe('GROK_PROFILE=review');
  for (const name of ['Authentication', 'Grok account', 'Bring your own model', 'Grok-native custom models', 'Agents', 'Subagents', 'Skills', 'Commands', 'Hidden Grok commands']) {
    expect(within(container).queryByText(name)).toBeNull();
  }
  expect((await axe(container, { runOnly: ['button-name', 'label', 'aria-valid-attr', 'aria-valid-attr-value'] })).violations).toEqual([]);
});
