/** @vitest-environment jsdom */
import '@/providers';

import { deserialize, serialize } from 'node:v8';

import { axe } from '@test/helpers/accessibility';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import { Notice } from 'obsidian';
import type { Mock } from 'vitest';

import { SettingsCoordinator } from '@/app/settings/SettingsCoordinator';
import type { CLIInstallation } from '@/core/providers/cli/CLIInstallationProbe';
import { getEnvironmentVariablesForScope, setEnvironmentVariablesForScope } from '@/core/providers/providerEnvironment';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import { renderCLIInstallationSetting } from '@/shared/settings/CLIInstallationSetting';
import { renderEnvironmentSettingsSection } from '@/shared/settings/EnvironmentSettingsSection';



vi.mock('obsidian', async () => (await vi.importActual<typeof import('@test/helpers/ObsidianSettingsDOM')>('@test/helpers/ObsidianSettingsDOM')));

afterEach(() => {
  (Notice as unknown as Mock).mockClear();
  document.body.replaceChildren();
});

it.each([
  { name: 'adding a review key', initial: 'PATH=/before', inserted: 'MY_TOOL_SETTING=custom', shared: 'MY_TOOL_SETTING=custom', provider: 'ANTHROPIC_MODEL=before', warning: 'Review environment ownership for: MY_TOOL_SETTING' },
  { name: 'removing a review key', initial: 'MY_TOOL_SETTING=old', inserted: 'PATH=/after', shared: 'PATH=/after', provider: 'ANTHROPIC_MODEL=before', warning: null },
  { name: 'a legacy snippet changing two rendered scopes', initial: 'PATH=/before', providerInitial: 'PATH=/provider-wrong', legacy: true, inserted: 'PATH=/after\nMY_TOOL_SETTING=custom\nANTHROPIC_MODEL=after', shared: 'PATH=/after\nMY_TOOL_SETTING=custom', provider: 'ANTHROPIC_MODEL=after', warning: 'Review environment ownership for: MY_TOOL_SETTING' },
])('refreshes the review message after $name', async ({ initial, inserted, shared, provider, warning, providerInitial, legacy }) => {
  globalThis.structuredClone ??= value => deserialize(serialize(value));
  const settings = {
    sharedEnvironmentVariables: initial,
    providerConfigs: { claude: { environmentVariables: providerInitial ?? 'ANTHROPIC_MODEL=before' } },
    envSnippets: [{ id: 'snippet', name: 'Saved configuration', scope: legacy ? undefined : 'shared', envVars: inserted }],
  };
  let saved = '';
  const coordinator = new SettingsCoordinator(settings, async draft => { saved = JSON.stringify(draft); });
  const applyEnvironmentVariables = vi.fn((scope: Parameters<typeof setEnvironmentVariablesForScope>[1], text: string) => coordinator.mutate(draft => { setEnvironmentVariablesForScope(draft, scope, text); }));
  const applyEnvironmentVariablesBatch = vi.fn((updates: Array<{ scope: Parameters<typeof setEnvironmentVariablesForScope>[1]; envText: string }>) => coordinator.mutate(draft => { for (const update of updates) setEnvironmentVariablesForScope(draft, update.scope, update.envText); }));
  const mutateSettings = vi.fn(coordinator.mutate.bind(coordinator));
  const host = {
    settings,
    app: { workspace: { getLeavesOfType: () => [] } },
    getEnvironmentVariablesForScope: (scope: Parameters<typeof getEnvironmentVariablesForScope>[1]) => getEnvironmentVariablesForScope(settings, scope),
    applyEnvironmentVariables,
    applyEnvironmentVariablesBatch,
    mutateSettings,
  } as unknown as ProviderHost;
  const root = document.body.createDiv({ cls: 'claudian-settings' });
  const general = root.createDiv();
  const specific = root.createDiv();
  const sharedRefresh = vi.fn();
  const providerRefresh = vi.fn();
  renderEnvironmentSettingsSection({ container: general, plugin: host, scope: 'shared', name: 'Shared environment', desc: '', placeholder: '', renderCustomContextLimits: sharedRefresh });
  renderEnvironmentSettingsSection({ container: specific, plugin: host, scope: 'provider:claude', name: 'Claude environment', desc: '', placeholder: '', renderCustomContextLimits: providerRefresh });
  const originalWarning = within(general).queryByText(/^Review environment ownership/);
  expect(originalWarning?.textContent ?? null).toBe(initial.startsWith('MY_TOOL_SETTING') ? 'Review environment ownership for: MY_TOOL_SETTING' : null);
  const originalProviderWarning = within(specific).queryByText(/^Review environment ownership/);
  expect(originalProviderWarning?.textContent ?? null).toBe(legacy ? 'Review environment ownership for: PATH' : null);
  fireEvent.click(within(general).getByRole('button', { name: 'Insert' }));
  await waitFor(() => expect(sharedRefresh).toHaveBeenCalledTimes(2));
  expect({ single: applyEnvironmentVariables.mock.calls.length, batch: applyEnvironmentVariablesBatch.mock.calls.length })
    .toEqual(legacy ? { single: 0, batch: 1 } : { single: 1, batch: 0 });
  expect(mutateSettings).toHaveBeenCalledTimes(1);
  expect(getEnvironmentVariablesForScope(settings, 'shared')).toBe(shared);
  expect(getEnvironmentVariablesForScope(settings, 'provider:claude')).toBe(provider);
  expect(getEnvironmentVariablesForScope(JSON.parse(saved), 'shared')).toBe(shared);
  expect((within(general).getByRole('textbox', { name: 'Shared environment' }) as HTMLTextAreaElement).value).toBe(shared);
  const message = within(general).queryByText(/^Review environment ownership/);
  expect(message?.textContent ?? null).toBe(warning);
  expect(message?.classList.contains('claudian-hidden') ?? false).toBe(false);
  expect(within(specific).queryByText(/^Review environment ownership/)).toBeNull();
  expect(await axe(root)).toHaveNoViolations();
});

it('shows the generic environment update notice when the detached update fails', async () => {
  let rejectApply: (error: Error) => void = () => {
    throw new Error('applyEnvironmentVariables was not invoked');
  };
  const applyEnvironmentVariables = vi.fn(
    () => new Promise<void>((_resolve, reject) => {
      rejectApply = reject;
    }),
  );
  const host = {
    settings: { envSnippets: [] },
    app: { workspace: { getLeavesOfType: () => [] } },
    getEnvironmentVariablesForScope: () => '',
    applyEnvironmentVariables,
  } as unknown as ProviderHost;

  const root = document.body.createDiv({ cls: 'claudian-settings' });
  const general = root.createDiv();
  renderEnvironmentSettingsSection({
    container: general,
    plugin: host,
    scope: 'shared',
    name: 'Environment',
    desc: '',
    placeholder: 'PATH=...',
  });

  const textbox = within(document.body).getByRole('textbox', { name: 'Environment' });
  fireEvent.input(textbox, { target: { value: 'PATH=/synthetic/bin' } });
  fireEvent.blur(textbox);

  expect(applyEnvironmentVariables).toHaveBeenCalledTimes(1);
  expect(applyEnvironmentVariables).toHaveBeenCalledWith('shared', 'PATH=/synthetic/bin');

  rejectApply(new Error('synthetic environment failure'));

  await waitFor(() => expect(Notice).toHaveBeenCalledWith('Could not complete environment update.'));
  expect(await axe(general)).toHaveNoViolations();
});

it('refreshes the rendered CLI installation after a successful environment update', async () => {
  let resolveApply: () => void = () => {
    throw new Error('applyEnvironmentVariables was not invoked');
  };
  const applyEnvironmentVariables = vi.fn(
    () => new Promise<void>((resolve) => {
      resolveApply = resolve;
    }),
  );
  let installation: CLIInstallation = { path: '/synthetic/cli-old', version: '1.0.0', source: 'auto' };
  const inspect = vi.fn(async () => installation);
  const host = {
    settings: { envSnippets: [] },
    app: { workspace: { getLeavesOfType: () => [] } },
    getEnvironmentVariablesForScope: () => '',
    applyEnvironmentVariables,
  } as unknown as ProviderHost;

  const root = document.body.createDiv({ cls: 'claudian-settings' });
  const general = root.createDiv();
  renderEnvironmentSettingsSection({
    container: general,
    plugin: host,
    scope: 'shared',
    name: 'Environment',
    desc: '',
    placeholder: 'PATH=...',
  });
  const cli = root.createDiv();
  renderCLIInstallationSetting({
    container: cli,
    cliName: 'Test CLI',
    name: 'Binary path',
    placeholder: 'Detected automatically',
    getValue: () => '',
    onChange: async () => {},
    inspect,
  });

  await waitFor(() => expect(within(cli).getByText('/synthetic/cli-old')).toBeTruthy());
  fireEvent.click(within(cli).getByRole('button', { name: 'Test CLI installation' }));

  const textbox = within(document.body).getByRole('textbox', { name: 'Environment' });
  fireEvent.input(textbox, { target: { value: 'PATH=/synthetic/bin' } });
  fireEvent.blur(textbox);
  expect(applyEnvironmentVariables).toHaveBeenCalledTimes(1);
  expect(applyEnvironmentVariables).toHaveBeenCalledWith('shared', 'PATH=/synthetic/bin');

  installation = { path: '/synthetic/cli-new', version: '2.0.0', source: 'custom' };
  resolveApply();

  await waitFor(() => expect(within(cli).getByText('/synthetic/cli-new')).toBeTruthy());
  expect(within(cli).queryByText('/synthetic/cli-old')).toBeNull();
});

it('recovers with a refreshed installation when a later environment update succeeds', async () => {
  const applyResults: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  const applyEnvironmentVariables = vi.fn(
    () => new Promise<void>((resolve, reject) => {
      applyResults.push({ resolve, reject });
    }),
  );
  let installation: CLIInstallation = { path: '/synthetic/cli-before', version: '1.0.0', source: 'auto' };
  const inspect = vi.fn(async () => installation);
  const renderCustomContextLimits = vi.fn();
  const host = {
    settings: { envSnippets: [] },
    app: { workspace: { getLeavesOfType: () => [] } },
    getEnvironmentVariablesForScope: () => '',
    applyEnvironmentVariables,
  } as unknown as ProviderHost;

  const root = document.body.createDiv({ cls: 'claudian-settings' });
  const general = root.createDiv();
  renderEnvironmentSettingsSection({
    container: general,
    plugin: host,
    scope: 'shared',
    name: 'Environment',
    desc: '',
    placeholder: 'PATH=...',
    renderCustomContextLimits,
  });
  const cli = root.createDiv();
  renderCLIInstallationSetting({
    container: cli,
    cliName: 'Test CLI',
    name: 'Binary path',
    placeholder: 'Detected automatically',
    getValue: () => '',
    onChange: async () => {},
    inspect,
  });

  await waitFor(() => expect(within(cli).getByText('/synthetic/cli-before')).toBeTruthy());
  expect(inspect).toHaveBeenCalledTimes(1);
  expect(renderCustomContextLimits).toHaveBeenCalledTimes(1);

  const textbox = within(document.body).getByRole('textbox', { name: 'Environment' });
  fireEvent.input(textbox, { target: { value: 'PATH=/synthetic/attempt-one' } });
  fireEvent.blur(textbox);
  expect(applyEnvironmentVariables).toHaveBeenNthCalledWith(1, 'shared', 'PATH=/synthetic/attempt-one');
  applyResults[0].reject(new Error('synthetic first attempt failure'));
  await waitFor(() => expect(Notice).toHaveBeenCalledWith('Could not complete environment update.'));
  expect({ 'inspect call count after failed apply': inspect.mock.calls.length }).toEqual({
    'inspect call count after failed apply': 1,
  });
  expect({ 'custom-context callout count after failed apply': renderCustomContextLimits.mock.calls.length }).toEqual({
    'custom-context callout count after failed apply': 1,
  });
  expect(within(cli).getByText('/synthetic/cli-before')).toBeTruthy();

  installation = { path: '/synthetic/cli-after', version: '2.0.0', source: 'auto' };
  fireEvent.input(textbox, { target: { value: 'PATH=/synthetic/bin' } });
  fireEvent.blur(textbox);
  expect(applyEnvironmentVariables).toHaveBeenNthCalledWith(2, 'shared', 'PATH=/synthetic/bin');
  applyResults[1].resolve();

  await waitFor(() => expect(within(cli).getByText('/synthetic/cli-after')).toBeTruthy());
  expect(within(cli).queryByText('/synthetic/cli-before')).toBeNull();
  expect({ 'custom-context callout count after later success': renderCustomContextLimits.mock.calls.length }).toEqual({
    'custom-context callout count after later success': 2,
  });
});

const applyFailureCases = [
  {
    label: 'pre-commit',
    error: new Error('pre-commit apply rejected for API_KEY=fake-secret-value at /fake/private/path'),
  },
  {
    label: 'post-commit',
    error: new Error('post-commit apply rejected after persistence for TOKEN=fake-token-value at /fake/private/path'),
  },
];

it.each(applyFailureCases)('shows only generic feedback without leakage for a $label apply failure', async ({ error }) => {
  let rejectApply: (error: Error) => void = () => {
    throw new Error('applyEnvironmentVariables was not invoked');
  };
  const applyEnvironmentVariables = vi.fn(
    () => new Promise<void>((_resolve, reject) => {
      rejectApply = reject;
    }),
  );
  const host = {
    settings: { envSnippets: [] },
    app: { workspace: { getLeavesOfType: () => [] } },
    getEnvironmentVariablesForScope: () => '',
    applyEnvironmentVariables,
  } as unknown as ProviderHost;

  const root = document.body.createDiv({ cls: 'claudian-settings' });
  const general = root.createDiv();
  renderEnvironmentSettingsSection({
    container: general,
    plugin: host,
    scope: 'shared',
    name: 'Environment',
    desc: '',
    placeholder: 'PATH=...',
  });

  const textbox = within(document.body).getByRole('textbox', { name: 'Environment' });
  fireEvent.input(textbox, { target: { value: 'PATH=/synthetic/bin' } });
  fireEvent.blur(textbox);
  expect(applyEnvironmentVariables).toHaveBeenCalledWith('shared', 'PATH=/synthetic/bin');

  rejectApply(error);

  await waitFor(() => expect(Notice).toHaveBeenCalledWith('Could not complete environment update.'));
  const noticeMessages = (Notice as unknown as Mock).mock.calls.map((args: unknown[]) => String(args[0]));
  expect(noticeMessages).toEqual(['Could not complete environment update.']);
  const renderedText = document.body.textContent ?? '';
  expect(renderedText).not.toContain('fake-secret-value');
  expect(renderedText).not.toContain('fake-token-value');
  expect(renderedText).not.toContain('/fake/private/path');
});
