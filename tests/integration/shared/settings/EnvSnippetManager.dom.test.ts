/** @jest-environment jsdom */

import '@/providers';

import { fireEvent, waitFor, within } from '@testing-library/dom';
import { axe } from 'jest-axe';

import { DEFAULT_CLAUDIAN_SETTINGS } from '@/app/settings/defaultSettings';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import { getClaudeProviderSettings, updateClaudeProviderSettings } from '@/providers/claude/settings';
import { EnvSnippetManager, EnvSnippetModal } from '@/shared/settings/EnvSnippetManager';

jest.mock('obsidian', () => jest.requireActual('../../../helpers/ObsidianSettingsDOM'));

afterEach(() => document.body.replaceChildren());

const aliasCases: Array<Record<string, string> | undefined> = [undefined, {}, { custom: ' Snippet name ' }];

it.each(aliasCases)('applies snippet aliases through provider settings while preserving unrelated aliases (%p)', async modelAliases => {
  const settings = JSON.parse(JSON.stringify(DEFAULT_CLAUDIAN_SETTINGS)) as typeof DEFAULT_CLAUDIAN_SETTINGS;
  updateClaudeProviderSettings(settings, { modelAliases: { custom: 'Old name', other: 'Keep name' }, loadUserSettings: false });
  settings.envSnippets = [{
    id: 'snippet', name: 'Custom endpoint', description: '', scope: 'provider:claude',
    envVars: 'ANTHROPIC_MODEL=custom', modelAliases,
  }];
  const applyEnvironmentVariables = jest.fn().mockResolvedValue(undefined);
  const host = {
    settings, applyEnvironmentVariables,
    app: { workspace: { getLeavesOfType: () => [] } },
    mutateSettings: async (mutate: Parameters<ProviderHost['mutateSettings']>[0]) => { await mutate(settings); },
  } as unknown as ProviderHost;
  const container = document.body.createEl('main');
  const onChanged = jest.fn();
  new EnvSnippetManager(container, host, 'provider:claude', onChanged);
  fireEvent.click(within(container).getByRole('button', { name: 'Insert' }));
  const expected = modelAliases === undefined
    ? { custom: 'Old name', other: 'Keep name' }
    : 'custom' in modelAliases ? { custom: 'Snippet name', other: 'Keep name' } : { other: 'Keep name' };
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
  expect(getClaudeProviderSettings(settings).modelAliases).toEqual(expected);
  expect(applyEnvironmentVariables).toHaveBeenCalledWith('provider:claude', 'ANTHROPIC_MODEL=custom');
  expect(getClaudeProviderSettings(settings).loadUserSettings).toBe(false);
  expect(settings).not.toHaveProperty('customModelAliases');
  expect(await axe(container)).toHaveNoViolations();
});

it('offers saving the current environment from the empty snippet state', async () => {
  const settings = JSON.parse(JSON.stringify(DEFAULT_CLAUDIAN_SETTINGS)) as typeof DEFAULT_CLAUDIAN_SETTINGS;
  settings.envSnippets = [];
  const host = {
    settings,
    app: { workspace: { getLeavesOfType: () => [] } },
    getEnvironmentVariablesForScope: () => 'ANTHROPIC_MODEL=custom',
    mutateSettings: async (mutate: Parameters<ProviderHost['mutateSettings']>[0]) => { await mutate(settings); },
  } as unknown as ProviderHost;
  const container = document.body.createEl('main');
  new EnvSnippetManager(container, host, 'provider:claude');

  expect(within(container).getAllByRole('button')).toHaveLength(1);
  expect(await axe(container)).toHaveNoViolations();
  fireEvent.click(within(container).getByRole('button', { name: 'Save current environment as a snippet' }));

  const dialog = within(document.body).getByRole('dialog', { name: 'Save snippet' });
  expect(within(dialog).getByDisplayValue('ANTHROPIC_MODEL=custom')).toBeTruthy();
});

it.each([
  { alias: 'New alias', context: '64k', modelAliases: { custom: 'New alias' }, contextLimits: { custom: 64000 } },
  { alias: '', context: '', modelAliases: {}, contextLimits: undefined },
])('preserves override drafts across environment edits (%j)', async ({ alias, context, modelAliases, contextLimits }) => {
  const settings = JSON.parse(JSON.stringify(DEFAULT_CLAUDIAN_SETTINGS)) as typeof DEFAULT_CLAUDIAN_SETTINGS;
  const snippet = {
    id: 'snippet', name: 'Custom endpoint', description: '', scope: 'provider:claude' as const,
    envVars: 'ANTHROPIC_MODEL=custom', modelAliases: { custom: 'Old alias' }, contextLimits: { custom: 200000 },
  };
  const save = jest.fn();
  const host = { settings } as ProviderHost;
  const modal = new EnvSnippetModal({} as ProviderHost['app'], host, snippet, 'provider:claude', save);
  modal.open();
  const dialog = within(document.body).getByRole('dialog', { name: 'Edit snippet' });
  fireEvent.input(within(dialog).getByRole('textbox', { name: 'Alias for custom' }), { target: { value: alias } });
  fireEvent.input(within(dialog).getByRole('textbox', { name: 'Context window for custom' }), { target: { value: context } });
  const environment = within(dialog).getByDisplayValue(snippet.envVars);
  fireEvent.input(environment, { target: { value: `${snippet.envVars}\nCUSTOM_FLAG=true` } });
  fireEvent.blur(environment);

  expect((within(dialog).getByRole('textbox', { name: 'Alias for custom' }) as HTMLInputElement).value).toBe(alias);
  expect((within(dialog).getByRole('textbox', { name: 'Context window for custom' }) as HTMLInputElement).value).toBe(context);
  const overrideRow = within(dialog).getByRole('textbox', { name: 'Alias for custom' }).parentElement!;
  expect(await axe(overrideRow)).toHaveNoViolations();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Update' }));
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ modelAliases, contextLimits }));
});
