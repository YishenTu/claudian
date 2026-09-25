/** @jest-environment jsdom */

import '@/providers';

import { fireEvent, waitFor, within } from '@testing-library/dom';
import { axe } from 'jest-axe';

import { DEFAULT_CLAUDIAN_SETTINGS } from '@/app/settings/defaultSettings';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import { getClaudeProviderSettings, updateClaudeProviderSettings } from '@/providers/claude/settings';
import { EnvSnippetManager } from '@/shared/settings/EnvSnippetManager';

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
