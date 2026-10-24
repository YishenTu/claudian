/** @jest-environment jsdom */

import { fireEvent, waitFor, within } from '@testing-library/dom';
import { axe } from 'jest-axe';
import { Notice } from 'obsidian';

import type { CLIInstallation } from '@/core/providers/cli/CLIInstallationProbe';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import { renderCLIInstallationSetting } from '@/shared/settings/CLIInstallationSetting';
import { renderEnvironmentSettingsSection } from '@/shared/settings/EnvironmentSettingsSection';

jest.mock('obsidian', () => jest.requireActual('@test/helpers/ObsidianSettingsDOM'));

afterEach(() => {
  (Notice as unknown as jest.Mock).mockClear();
  document.body.replaceChildren();
});

it('shows the generic environment update notice when the detached update fails', async () => {
  let rejectApply: (error: Error) => void = () => {
    throw new Error('applyEnvironmentVariables was not invoked');
  };
  const applyEnvironmentVariables = jest.fn(
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
  const applyEnvironmentVariables = jest.fn(
    () => new Promise<void>((resolve) => {
      resolveApply = resolve;
    }),
  );
  let installation: CLIInstallation = { path: '/synthetic/cli-old', version: '1.0.0', source: 'auto' };
  const inspect = jest.fn(async () => installation);
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
  const applyEnvironmentVariables = jest.fn(
    () => new Promise<void>((resolve, reject) => {
      applyResults.push({ resolve, reject });
    }),
  );
  let installation: CLIInstallation = { path: '/synthetic/cli-before', version: '1.0.0', source: 'auto' };
  const inspect = jest.fn(async () => installation);
  const renderCustomContextLimits = jest.fn();
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
  const applyEnvironmentVariables = jest.fn(
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
  const noticeMessages = (Notice as unknown as jest.Mock).mock.calls.map((args: unknown[]) => String(args[0]));
  expect(noticeMessages).toEqual(['Could not complete environment update.']);
  const renderedText = document.body.textContent ?? '';
  expect(renderedText).not.toContain('fake-secret-value');
  expect(renderedText).not.toContain('fake-token-value');
  expect(renderedText).not.toContain('/fake/private/path');
});
