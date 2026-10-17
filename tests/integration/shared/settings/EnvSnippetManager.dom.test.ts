/** @jest-environment jsdom */

import '@/providers';

import { fireEvent, waitFor, within } from '@testing-library/dom';
import { axe } from 'jest-axe';
import { Notice } from 'obsidian';

import { DEFAULT_CLAUDIAN_SETTINGS } from '@/app/settings/defaultSettings';
import { SettingsCoordinator } from '@/app/settings/SettingsCoordinator';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import { getClaudeProviderSettings, updateClaudeProviderSettings } from '@/providers/claude/settings';
import { EnvSnippetManager, EnvSnippetModal } from '@/shared/settings/EnvSnippetManager';

jest.mock('obsidian', () => jest.requireActual('../../../helpers/ObsidianSettingsDOM'));

type ModalTimerJoin = () => Promise<void>;

const timerSpyCleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of timerSpyCleanups.splice(0)) cleanup();
  document.body.replaceChildren();
});

/**
 * Wraps a real modal open with a narrow capture of the deferred-focus timer that open
 * schedules: the original callback still runs at the original delay on the real timer.
 * The returned join resolves only after that callback completed.
 */
function captureModalFocusTimers(openModal: () => void): ModalTimerJoin {
  const realSetTimeout = window.setTimeout.bind(window);
  const completions: Array<Promise<void>> = [];
  const spy = jest
    .spyOn(window, 'setTimeout')
    .mockImplementation(((handler: string | ((...callbackArgs: unknown[]) => void), timeout?: number, ...args: unknown[]) => {
      if (typeof handler !== 'function') {
        return realSetTimeout(String(handler), timeout);
      }
      let completed: () => void = () => undefined;
      completions.push(new Promise<void>((resolve) => { completed = resolve; }));
      return realSetTimeout(() => {
        try {
          handler(...args);
        } finally {
          completed();
        }
      }, timeout);
    }) as typeof window.setTimeout);
  const restore = (): void => { spy.mockRestore(); };
  timerSpyCleanups.push(restore);
  try {
    openModal();
  } finally {
    restore();
    timerSpyCleanups.splice(timerSpyCleanups.indexOf(restore), 1);
  }
  return async () => {
    await Promise.all(completions);
  };
}

function notifyCalls(notice: jest.Mock): string[] {
  return notice.mock.calls.map((args: unknown[]) => String(args[0]));
}

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
  const joinFocusTimers = captureModalFocusTimers(() => {
    fireEvent.click(within(container).getByRole('button', { name: 'Save current environment as a snippet' }));
  });

  const dialog = within(document.body).getByRole('dialog', { name: 'Save snippet' });
  expect(within(dialog).getByDisplayValue('ANTHROPIC_MODEL=custom')).toBeTruthy();
  await joinFocusTimers();
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
  const joinFocusTimers = captureModalFocusTimers(() => { modal.open(); });
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
  await joinFocusTimers();
});

it.each(['de-DE', 'fr-FR', 'ar-EG', 'en-US'])(
  'keeps an unchanged saved context limit through Update under the %s number locale',
  async numberLocale => {
    const originalToLocaleString = Number.prototype.toLocaleString;
    Number.prototype.toLocaleString = function (this: number, locales?: Intl.LocalesArgument, options?: Intl.NumberFormatOptions): string {
      return originalToLocaleString.call(this, locales ?? numberLocale, options);
    };
    try {
      const settings = JSON.parse(JSON.stringify(DEFAULT_CLAUDIAN_SETTINGS)) as typeof DEFAULT_CLAUDIAN_SETTINGS;
      const snippet = {
        id: 'snippet', name: 'Custom endpoint', description: '', scope: 'provider:claude' as const,
        envVars: 'ANTHROPIC_MODEL=custom',
        modelAliases: { custom: 'Old alias' },
        contextLimits: { custom: 256500 },
      };
      const save = jest.fn();
      const host = { settings } as ProviderHost;
      const modal = new EnvSnippetModal({} as ProviderHost['app'], host, snippet, 'provider:claude', save);
      const joinFocusTimers = captureModalFocusTimers(() => { modal.open(); });
      const dialog = within(document.body).getByRole('dialog', { name: 'Edit snippet' });
      const contextInput = within(dialog).getByRole('textbox', { name: 'Context window for custom' }) as HTMLInputElement;
      expect(contextInput.value).toBe('256,500');
      const overrideRow = within(dialog).getByRole('textbox', { name: 'Alias for custom' }).parentElement!;
      expect(await axe(overrideRow)).toHaveNoViolations();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Update' }));
      expect(save).toHaveBeenCalledWith(expect.objectContaining({ contextLimits: { custom: 256500 } }));
      await joinFocusTimers();
    } finally {
      Number.prototype.toLocaleString = originalToLocaleString;
    }
  },
);

it('reports a save failure notice and keeps settings unchanged when snippet persistence fails', async () => {
  const notice = Notice as unknown as jest.Mock;
  notice.mockClear();
  const settings = JSON.parse(JSON.stringify(DEFAULT_CLAUDIAN_SETTINGS)) as typeof DEFAULT_CLAUDIAN_SETTINGS;
  settings.envSnippets = [];
  const persist = jest.fn<Promise<void>, [typeof settings]>().mockRejectedValue(new Error('storage unavailable'));
  const coordinator = new SettingsCoordinator(settings, persist);
  const host = {
    settings,
    app: { workspace: { getLeavesOfType: () => [] } },
    getEnvironmentVariablesForScope: () => 'ANTHROPIC_MODEL=custom',
    mutateSettings: coordinator.mutate.bind(coordinator),
  } as unknown as ProviderHost;
  const container = document.body.createEl('main');
  new EnvSnippetManager(container, host, 'provider:claude');

  const joinFocusTimers = captureModalFocusTimers(() => {
    fireEvent.click(within(container).getByRole('button', { name: 'Save current environment as a snippet' }));
  });
  const dialog = within(document.body).getByRole('dialog', { name: 'Save snippet' });
  const nameField = within(within(dialog).getByText('Name').parentElement!).getByRole('textbox');
  fireEvent.input(nameField, { target: { value: 'New snippet name' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(notifyCalls(notice)).toContain('Could not complete environment snippet save'));
  await joinFocusTimers();
  expect(persist).toHaveBeenCalled();
  expect(coordinator.getCommittedSettings().envSnippets).toEqual([]);
  expect(within(container).getByRole('button', { name: 'Save current environment as a snippet' })).toBeTruthy();
  expect(within(container).queryByText('New snippet name')).toBeNull();
  expect(notifyCalls(notice).filter((message) => message === 'Could not complete environment snippet save')).toHaveLength(1);
  expect(notifyCalls(notice)).not.toContain('Environment snippet "New snippet name" saved');
});

it('reports an update failure notice and keeps the original snippet when persistence fails', async () => {
  const notice = Notice as unknown as jest.Mock;
  notice.mockClear();
  const settings = JSON.parse(JSON.stringify(DEFAULT_CLAUDIAN_SETTINGS)) as typeof DEFAULT_CLAUDIAN_SETTINGS;
  settings.envSnippets = [{
    id: 'snippet', name: 'Existing snippet name', description: '', scope: 'provider:claude',
    envVars: 'ANTHROPIC_MODEL=custom',
  }];
  const originalSnippets = JSON.parse(JSON.stringify(settings.envSnippets));
  const persist = jest.fn<Promise<void>, [typeof settings]>().mockRejectedValue(new Error('storage unavailable'));
  const coordinator = new SettingsCoordinator(settings, persist);
  const host = {
    settings,
    app: { workspace: { getLeavesOfType: () => [] } },
    getEnvironmentVariablesForScope: () => 'ANTHROPIC_MODEL=custom',
    mutateSettings: coordinator.mutate.bind(coordinator),
  } as unknown as ProviderHost;
  const container = document.body.createEl('main');
  new EnvSnippetManager(container, host, 'provider:claude');

  const joinFocusTimers = captureModalFocusTimers(() => {
    fireEvent.click(within(container).getByRole('button', { name: 'Edit' }));
  });
  const dialog = within(document.body).getByRole('dialog', { name: 'Edit snippet' });
  const nameField = within(within(dialog).getByText('Name').parentElement!).getByRole('textbox');
  fireEvent.input(nameField, { target: { value: 'Renamed snippet name' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Update' }));

  await waitFor(() => expect(notifyCalls(notice)).toContain('Could not complete environment snippet update'));
  await joinFocusTimers();
  expect(persist).toHaveBeenCalled();
  expect(coordinator.getCommittedSettings().envSnippets).toEqual(originalSnippets);
  expect(within(container).getByText('Existing snippet name')).toBeTruthy();
  expect(within(container).queryByText('Renamed snippet name')).toBeNull();
  expect(notifyCalls(notice).filter((message) => message === 'Could not complete environment snippet update')).toHaveLength(1);
  expect(notifyCalls(notice)).not.toContain('Environment snippet "Renamed snippet name" updated');
});

it('saves a snippet through the coordinator and renders it when persistence succeeds', async () => {
  const notice = Notice as unknown as jest.Mock;
  notice.mockClear();
  const settings = JSON.parse(JSON.stringify(DEFAULT_CLAUDIAN_SETTINGS)) as typeof DEFAULT_CLAUDIAN_SETTINGS;
  settings.envSnippets = [];
  const persist = jest.fn<Promise<void>, [typeof settings]>().mockResolvedValue(undefined);
  const coordinator = new SettingsCoordinator(settings, persist);
  const host = {
    settings,
    app: { workspace: { getLeavesOfType: () => [] } },
    getEnvironmentVariablesForScope: () => 'ANTHROPIC_MODEL=custom',
    mutateSettings: coordinator.mutate.bind(coordinator),
  } as unknown as ProviderHost;
  const container = document.body.createEl('main');
  new EnvSnippetManager(container, host, 'provider:claude');

  const joinFocusTimers = captureModalFocusTimers(() => {
    fireEvent.click(within(container).getByRole('button', { name: 'Save current environment as a snippet' }));
  });
  const dialog = within(document.body).getByRole('dialog', { name: 'Save snippet' });
  const nameField = within(within(dialog).getByText('Name').parentElement!).getByRole('textbox');
  fireEvent.input(nameField, { target: { value: 'New snippet name' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(notifyCalls(notice)).toContain('Environment snippet "New snippet name" saved'));
  await joinFocusTimers();
  expect(persist).toHaveBeenCalledTimes(1);
  const persistedSettings = persist.mock.calls[0][0] as typeof settings;
  expect(persistedSettings.envSnippets).toEqual([
    expect.objectContaining({
      name: 'New snippet name',
      envVars: 'ANTHROPIC_MODEL=custom',
      scope: 'provider:claude',
    }),
  ]);
  expect(persistedSettings.envSnippets[0].id).toMatch(/^snippet-/);
  expect(coordinator.getCommittedSettings().envSnippets).toHaveLength(1);
  expect(coordinator.getCommittedSettings().envSnippets[0]).toEqual(expect.objectContaining({ name: 'New snippet name' }));
  expect(within(container).getByText('New snippet name')).toBeTruthy();
  expect(notifyCalls(notice)).not.toContain('Could not complete environment snippet save');
});

it('updates a snippet through the coordinator and renders the new name when persistence succeeds', async () => {
  const notice = Notice as unknown as jest.Mock;
  notice.mockClear();
  const settings = JSON.parse(JSON.stringify(DEFAULT_CLAUDIAN_SETTINGS)) as typeof DEFAULT_CLAUDIAN_SETTINGS;
  settings.envSnippets = [{
    id: 'snippet', name: 'Existing snippet name', description: '', scope: 'provider:claude',
    envVars: 'ANTHROPIC_MODEL=custom',
  }];
  const persist = jest.fn<Promise<void>, [typeof settings]>().mockResolvedValue(undefined);
  const coordinator = new SettingsCoordinator(settings, persist);
  const host = {
    settings,
    app: { workspace: { getLeavesOfType: () => [] } },
    getEnvironmentVariablesForScope: () => 'ANTHROPIC_MODEL=custom',
    mutateSettings: coordinator.mutate.bind(coordinator),
  } as unknown as ProviderHost;
  const container = document.body.createEl('main');
  new EnvSnippetManager(container, host, 'provider:claude');

  const joinFocusTimers = captureModalFocusTimers(() => {
    fireEvent.click(within(container).getByRole('button', { name: 'Edit' }));
  });
  const dialog = within(document.body).getByRole('dialog', { name: 'Edit snippet' });
  const nameField = within(within(dialog).getByText('Name').parentElement!).getByRole('textbox');
  fireEvent.input(nameField, { target: { value: 'Renamed snippet name' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Update' }));

  await waitFor(() => expect(notifyCalls(notice)).toContain('Environment snippet "Renamed snippet name" updated'));
  await joinFocusTimers();
  expect(persist).toHaveBeenCalledTimes(1);
  const persistedSettings = persist.mock.calls[0][0] as typeof settings;
  expect(persistedSettings.envSnippets).toEqual([
    expect.objectContaining({
      id: 'snippet',
      name: 'Renamed snippet name',
      envVars: 'ANTHROPIC_MODEL=custom',
      scope: 'provider:claude',
    }),
  ]);
  expect(persistedSettings.envSnippets[0].id).toBe('snippet');
  expect(coordinator.getCommittedSettings().envSnippets).toHaveLength(1);
  expect(coordinator.getCommittedSettings().envSnippets[0]).toEqual(expect.objectContaining({ name: 'Renamed snippet name' }));
  expect(within(container).getByText('Renamed snippet name')).toBeTruthy();
  expect(within(container).queryByText('Existing snippet name')).toBeNull();
  expect(notifyCalls(notice)).not.toContain('Could not complete environment snippet update');
});
