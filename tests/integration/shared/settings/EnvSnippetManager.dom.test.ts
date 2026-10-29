/** @vitest-environment jsdom */

import '@/providers';

import { axe } from '@test/helpers/accessibility';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import { Notice } from 'obsidian';
import type { Mock } from 'vitest';

import { ClaudianSettingsStorage } from '@/app/settings/ClaudianSettingsStorage';
import { DEFAULT_CLAUDIAN_SETTINGS } from '@/app/settings/defaultSettings';
import { ProviderChatOptionsReconciler } from '@/app/settings/ProviderChatOptionsReconciler';
import { SettingsCoordinator } from '@/app/settings/SettingsCoordinator';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import type { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import { getChatSettingsSnapshot } from '@/features/chat/ChatSettings';
import { ChatViewPublisher } from '@/features/chat/workspace/ChatViewPublisher';
import { getClaudeProviderSettings, updateClaudeProviderSettings } from '@/providers/claude/settings';
import { claudeChatUIConfig } from '@/providers/claude/ui/ClaudeChatUIConfig';
import { EnvSnippetManager, EnvSnippetModal } from '@/shared/settings/EnvSnippetManager';
import { ModelSelector } from '@/shared/toolbar/ModelSelector';



vi.mock('obsidian', async () => (await vi.importActual<typeof import('../../../helpers/ObsidianSettingsDOM')>('../../../helpers/ObsidianSettingsDOM')));

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
  const spy = vi.spyOn(window, 'setTimeout')
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

function notifyCalls(notice: Mock): string[] {
  return notice.mock.calls.map((args: unknown[]) => String(args[0]));
}

const aliasCases: Array<Record<string, string> | undefined> = [undefined, {}, { custom: ' Snippet name ' }];

it('preserves own context-limit keys when inserting a snippet with production object-spread semantics', async () => {
  const settings = JSON.parse(JSON.stringify(DEFAULT_CLAUDIAN_SETTINGS)) as typeof DEFAULT_CLAUDIAN_SETTINGS;
  settings.customContextLimits = { sibling: 256000 };
  settings.envSnippets = [{
    id: 'snippet', name: 'Custom limits', description: '', scope: 'provider:claude',
    envVars: 'ANTHROPIC_MODEL=custom',
    contextLimits: JSON.parse('{"__proto__":64000,"custom":128000}') as Record<string, number>,
  }];
  const coordinator = new SettingsCoordinator(settings, async () => undefined);
  const host = {
    notifyProviderChatOptionsChanged: vi.fn(),
    settings,
    app: { workspace: { getLeavesOfType: () => [] } },
    applyEnvironmentVariables: async () => undefined,
    mutateSettings: coordinator.mutate.bind(coordinator),
  } as unknown as ProviderHost;
  const container = document.body.createEl('main');
  const changed = vi.fn();
  new EnvSnippetManager(container, host, 'provider:claude', changed);

  fireEvent.click(within(container).getByRole('button', { name: 'Insert' }));
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));

  expect(Object.getOwnPropertyDescriptor(settings.customContextLimits, '__proto__')?.value).toBe(64000);
  expect(JSON.parse(JSON.stringify(settings.customContextLimits))).toEqual(
    JSON.parse('{"sibling":256000,"__proto__":64000,"custom":128000}'),
  );
  expect(await axe(container)).toHaveNoViolations();
});

it.each(aliasCases)('applies snippet aliases through provider settings while preserving unrelated aliases (%o)', async modelAliases => {
  const settings = JSON.parse(JSON.stringify(DEFAULT_CLAUDIAN_SETTINGS)) as typeof DEFAULT_CLAUDIAN_SETTINGS;
  updateClaudeProviderSettings(settings, { modelAliases: { custom: 'Old name', other: 'Keep name' }, loadUserSettings: false });
  settings.envSnippets = [{
    id: 'snippet', name: 'Custom endpoint', description: '', scope: 'provider:claude',
    envVars: 'ANTHROPIC_MODEL=custom', modelAliases,
  }];
  const applyEnvironmentVariables = vi.fn().mockResolvedValue(undefined);
  const host = {
    notifyProviderChatOptionsChanged: vi.fn(),
    settings, applyEnvironmentVariables,
    app: { workspace: { getLeavesOfType: () => [] } },
    mutateSettings: async (mutate: Parameters<ProviderHost['mutateSettings']>[0]) => { await mutate(settings); },
  } as unknown as ProviderHost;
  const container = document.body.createEl('main');
  const onChanged = vi.fn();
  new EnvSnippetManager(container, host, 'provider:claude', onChanged);
  expect(['Insert', 'Edit', 'Delete'].map(name =>
    within(container).getByRole<HTMLButtonElement>('button', { name }).type,
  )).toEqual(['button', 'button', 'button']);
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
    notifyProviderChatOptionsChanged: vi.fn(),
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
  await joinFocusTimers();
  expect(await axe(dialog)).toHaveNoViolations();
  const name = within(dialog).getByRole('textbox', { name: 'Name' });
  const description = within(dialog).getByRole('textbox', { name: 'Description' });
  const environment = within(dialog).getByRole('textbox', { name: 'Environment variables' });
  expect((environment as HTMLTextAreaElement).value).toBe('ANTHROPIC_MODEL=custom');
  fireEvent.input(name, { target: { value: 'Work endpoint' } });
  fireEvent.input(description, { target: { value: 'Used for work' } });
  fireEvent.input(environment, { target: { value: 'ANTHROPIC_MODEL=custom\nANTHROPIC_BASE_URL=https://example.invalid' } });
  fireEvent.blur(environment);
  expect(['Cancel', 'Save'].map(name =>
    within(dialog).getByRole<HTMLButtonElement>('button', { name }).type,
  )).toEqual(['button', 'button']);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(within(document.body).queryByRole('dialog', { name: 'Save snippet' })).toBeNull());
  expect(settings.envSnippets).toEqual([expect.objectContaining({
    name: 'Work endpoint', description: 'Used for work', envVars: 'ANTHROPIC_MODEL=custom\nANTHROPIC_BASE_URL=https://example.invalid',
  })]);
  await waitFor(() => expect(within(container).getByRole('button', { name: 'Insert' })).toBeTruthy());
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
  const save = vi.fn();
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
      const save = vi.fn();
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

it.each((['Update', 'name Enter', 'Save'] as const).flatMap(action =>
  ['abc', '1,5k'].map(invalidContext => ({ action, invalidContext })),
))(
  'rejects $invalidContext through $action and saves corrected drafts from the same modal',
  async ({ action, invalidContext }) => {
    const notice = Notice as unknown as Mock;
    notice.mockClear();
    const settings = JSON.parse(JSON.stringify(DEFAULT_CLAUDIAN_SETTINGS)) as typeof DEFAULT_CLAUDIAN_SETTINGS;
    const envVars = 'ANTHROPIC_MODEL=sibling\nANTHROPIC_DEFAULT_SONNET_MODEL=custom';
    const originalSnippet = {
      id: 'snippet', name: 'Existing snippet name', description: 'Original description',
      scope: 'provider:claude' as const, envVars,
      modelAliases: { custom: 'Old alias', sibling: 'Old sibling' },
      contextLimits: { custom: 200000, sibling: 100000 },
    };
    const unrelatedSnippet = {
      id: 'unrelated', name: 'Unrelated snippet', description: '', envVars: 'OTHER=value', scope: 'shared' as const,
    };
    settings.envSnippets = action === 'Save' ? [unrelatedSnippet] : [originalSnippet, unrelatedSnippet];
    const originalSettings = structuredClone(settings);
    let completePersistence = (): void => undefined;
    const persist = vi.fn<(...args: [typeof settings]) => Promise<void>>(() => new Promise<void>(resolve => {
      completePersistence = resolve;
    }));
    const coordinator = new SettingsCoordinator(settings, persist);
    const mutateSettings = vi.fn(coordinator.mutate.bind(coordinator));
    const host = {
      settings, mutateSettings,
      app: { workspace: { getLeavesOfType: () => [] } },
      getEnvironmentVariablesForScope: () => envVars,
    } as unknown as ProviderHost;
    const container = document.body.createEl('main');
    new EnvSnippetManager(container, host, 'provider:claude');
    const joinFocusTimers = captureModalFocusTimers(() => {
      fireEvent.click(within(container).getByRole('button', {
        name: action === 'Save' ? 'Save current environment as a snippet' : 'Edit',
      }));
    });
    await joinFocusTimers();
    const dialogName = action === 'Save' ? 'Save snippet' : 'Edit snippet';
    const dialog = within(document.body).getByRole('dialog', { name: dialogName });
    const fields = within(dialog);
    expect(fields.getByRole<HTMLButtonElement>('button', {
      name: action === 'Save' ? 'Save' : 'Update',
    }).type).toBe('button');
    const nameField = within(fields.getByText('Name').parentElement!).getByRole<HTMLInputElement>('textbox');
    const descriptionField = within(fields.getByText('Description').parentElement!).getByRole<HTMLInputElement>('textbox');
    fireEvent.input(nameField, { target: { value: 'Renamed snippet name' } });
    fireEvent.input(descriptionField, { target: { value: 'Draft description' } });
    fireEvent.input(fields.getByRole('textbox', { name: 'Context window for custom' }), { target: { value: invalidContext } });
    fireEvent.input(fields.getByRole('textbox', { name: 'Context window for sibling' }), { target: { value: '128k' } });
    fireEvent.input(fields.getByRole('textbox', { name: 'Alias for custom' }), { target: { value: ' Custom draft ' } });
    fireEvent.input(fields.getByRole('textbox', { name: 'Alias for sibling' }), { target: { value: ' Sibling draft ' } });
    const environment = within(fields.getByText('Environment variables').parentElement!).getByRole<HTMLTextAreaElement>('textbox');
    expect(environment.value).toBe(envVars);
    const draftEnvironment = `${envVars}\nANTHROPIC_BASE_URL=https://example.invalid`;
    fireEvent.input(environment, { target: { value: draftEnvironment } });
    fireEvent.blur(environment);

    // Environment blur rebuilds the model rows; interact with the current controls.
    const customContext = fields.getByRole<HTMLInputElement>('textbox', { name: 'Context window for custom' });
    expect(customContext.isConnected).toBe(true);
    expect(customContext.value).toBe(invalidContext);
    expect(fields.getByRole<HTMLInputElement>('textbox', { name: 'Context window for sibling' }).value).toBe('128k');
    const submit = (): boolean => {
      if (action === 'name Enter') {
        return fireEvent.keyDown(nameField, { key: 'Enter' });
      }
      return fireEvent.click(fields.getByRole('button', { name: action }));
    };
    expect(submit()).toBe(action !== 'name Enter');
    // Let the real coordinator queue reach its persistence boundary if admitted.
    await new Promise<void>(resolve => window.setTimeout(resolve, 0));
    expect(notifyCalls(notice)).toEqual(['Invalid format. Use: 256k, 1m, or exact count (1000-10000000).']);
    expect(within(document.body).getByRole('dialog', { name: dialogName })).toBe(dialog);
    expect(dialog.isConnected).toBe(true);
    expect(nameField.value).toBe('Renamed snippet name');
    expect(descriptionField.value).toBe('Draft description');
    expect(environment.value).toBe(draftEnvironment);
    expect(customContext.value).toBe(invalidContext);
    expect(fields.getByRole<HTMLInputElement>('textbox', { name: 'Context window for sibling' }).value).toBe('128k');
    expect(fields.getByRole<HTMLInputElement>('textbox', { name: 'Alias for custom' }).value).toBe(' Custom draft ');
    expect(fields.getByRole<HTMLInputElement>('textbox', { name: 'Alias for sibling' }).value).toBe(' Sibling draft ');
    expect(mutateSettings).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(coordinator.getCommittedSettings()).toEqual(originalSettings);
    expect(within(container).queryByText('Existing snippet name')?.isConnected ?? false).toBe(action !== 'Save');
    expect(within(container).queryByText('Renamed snippet name')).toBeNull();
    expect(await axe(customContext.parentElement!)).toHaveNoViolations();

    fireEvent.input(customContext, { target: { value: '64k' } });
    expect(submit()).toBe(action !== 'name Enter');
    await waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
    expect(coordinator.getCommittedSettings()).toEqual(originalSettings);
    expect(within(document.body).getByRole('dialog', { name: dialogName })).toBe(dialog);
    expect(fields.getAllByRole<HTMLInputElement>('textbox').every(input => input.disabled)).toBe(true);
    fireEvent.keyDown(nameField, { key: 'Enter' });
    fireEvent.click(fields.getByRole('button', { name: action === 'Save' ? 'Save' : 'Update' }));
    const savedSnippet = {
      id: expect.stringMatching(action === 'Save' ? /^snippet-/ : /^snippet$/),
      name: 'Renamed snippet name', description: 'Draft description', scope: 'provider:claude',
      envVars: draftEnvironment, modelAliases: { custom: 'Custom draft', sibling: 'Sibling draft' },
      contextLimits: { custom: 64000, sibling: 128000 },
    };
    const expectedSnippets = action === 'Save'
      ? [unrelatedSnippet, savedSnippet] : [savedSnippet, unrelatedSnippet];
    expect(persist.mock.calls[0][0]).toEqual({ ...originalSettings, envSnippets: expectedSnippets });
    completePersistence();
    const success = `Environment snippet "Renamed snippet name" ${action === 'Save' ? 'saved' : 'updated'}`;
    await waitFor(() => expect(notifyCalls(notice)).toContain(success));
    expect(within(document.body).queryByRole('dialog', { name: dialogName })).toBeNull();
    expect(notifyCalls(notice)).toEqual([
      'Invalid format. Use: 256k, 1m, or exact count (1000-10000000).', success,
    ]);
    expect(mutateSettings).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(coordinator.getCommittedSettings()).toEqual({ ...originalSettings, envSnippets: expectedSnippets });
    expect(within(container).getByText('Renamed snippet name')).toBeTruthy();
  },
);

it.each(['Save', 'Update'] as const)('retains every %s draft after persistence fails and retries from that same modal', async action => {
  const notice = Notice as unknown as Mock;
  notice.mockClear();
  const settings = structuredClone(DEFAULT_CLAUDIAN_SETTINGS);
  settings.envSnippets = action === 'Save' ? [] : [{
    id: 'snippet', name: 'Existing snippet name', description: '', scope: 'provider:claude',
    envVars: 'ANTHROPIC_MODEL=custom',
  }];
  const originalSnippets = structuredClone(settings.envSnippets);
  const persist = vi.fn<(...args: [typeof settings]) => Promise<void>>()
    .mockRejectedValueOnce(new Error('storage unavailable')).mockResolvedValue(undefined);
  const coordinator = new SettingsCoordinator(settings, persist);
  const host = {
    notifyProviderChatOptionsChanged: vi.fn(),
    settings,
    app: { workspace: { getLeavesOfType: () => [] } },
    getEnvironmentVariablesForScope: () => 'ANTHROPIC_MODEL=custom',
    mutateSettings: coordinator.mutate.bind(coordinator),
  } as unknown as ProviderHost;
  const container = document.body.createEl('main');
  new EnvSnippetManager(container, host, 'provider:claude');
  const joinFocusTimers = captureModalFocusTimers(() => {
    fireEvent.click(within(container).getByRole('button', {
      name: action === 'Save' ? 'Save current environment as a snippet' : 'Edit',
    }));
  });
  await joinFocusTimers();
  const title = action === 'Save' ? 'Save snippet' : 'Edit snippet';
  const dialog = within(document.body).getByRole('dialog', { name: title });
  const fields = within(dialog);
  const field = (name: string) => within(fields.getByText(name).parentElement!).getByRole<HTMLInputElement>('textbox');
  const name = 'Work endpoint';
  const description = 'Keep these settings';
  const envVars = 'ANTHROPIC_MODEL=custom\nANTHROPIC_BASE_URL=https://example.invalid';
  fireEvent.input(field('Name'), { target: { value: name } });
  fireEvent.input(field('Description'), { target: { value: description } });
  fireEvent.input(field('Environment variables'), { target: { value: envVars } });
  fireEvent.blur(field('Environment variables'));
  fireEvent.input(fields.getByRole('textbox', { name: 'Alias for custom' }), { target: { value: 'Work model' } });
  fireEvent.input(fields.getByRole('textbox', { name: 'Context window for custom' }), { target: { value: '64k' } });
  const save = fields.getByRole<HTMLButtonElement>('button', { name: action });
  fireEvent.click(save);
  const error = `Could not complete environment snippet ${action === 'Save' ? 'save' : 'update'}`;
  await waitFor(() => expect(notifyCalls(notice)).toContain(error));
  expect(persist).toHaveBeenCalledTimes(1);
  expect(coordinator.getCommittedSettings().envSnippets).toEqual(originalSnippets);
  expect(within(document.body).getByRole('dialog', { name: title })).toBe(dialog);
  expect(field('Name').value).toBe(name);
  expect(field('Description').value).toBe(description);
  expect(field('Environment variables').value).toBe(envVars);
  expect(fields.getByRole<HTMLInputElement>('textbox', { name: 'Alias for custom' }).value).toBe('Work model');
  expect(fields.getByRole<HTMLInputElement>('textbox', { name: 'Context window for custom' }).value).toBe('64k');
  expect(save.disabled).toBe(false);
  expect(within(container).queryByText(name)).toBeNull();
  expect(notifyCalls(notice)).toEqual([error]);
  expect(await axe(save.parentElement!)).toHaveNoViolations();
  fireEvent.click(save);
  const success = `Environment snippet "${name}" ${action === 'Save' ? 'saved' : 'updated'}`;
  await waitFor(() => expect(notifyCalls(notice)).toContain(success));
  expect(within(document.body).queryByRole('dialog', { name: title })).toBeNull();
  expect(persist).toHaveBeenCalledTimes(2);
  expect(coordinator.getCommittedSettings().envSnippets).toEqual([expect.objectContaining({
    name, description, envVars, modelAliases: { custom: 'Work model' }, contextLimits: { custom: 64000 },
  })]);
  expect(within(container).getByText(name)).toBeTruthy();
  expect(notifyCalls(notice)).toEqual([error, success]);
});

it.each(['Save', 'Update'] as const)('does not offer another %s after persistence committed but publication failed', async action => {
  const notice = Notice as unknown as Mock;
  notice.mockClear();
  const settings = structuredClone(DEFAULT_CLAUDIAN_SETTINGS);
  settings.envSnippets = action === 'Save' ? [] : [{
    id: 'snippet', name: 'Existing snippet name', description: '', scope: 'provider:claude',
    envVars: 'ANTHROPIC_MODEL=custom',
  }];
  const persist = vi.fn<(...args: [typeof settings]) => Promise<void>>().mockResolvedValue(undefined);
  const publish = vi.fn(() => { throw new Error('view refresh failed'); });
  const coordinator = new SettingsCoordinator(settings, persist, publish);
  const host = {
    settings,
    app: { workspace: { getLeavesOfType: () => [] } },
    getEnvironmentVariablesForScope: () => 'ANTHROPIC_MODEL=custom',
    mutateSettings: coordinator.mutate.bind(coordinator),
  } as unknown as ProviderHost;
  const container = document.body.createEl('main');
  new EnvSnippetManager(container, host, 'provider:claude');
  await captureModalFocusTimers(() => {
    fireEvent.click(within(container).getByRole('button', {
      name: action === 'Save' ? 'Save current environment as a snippet' : 'Edit',
    }));
  })();
  const title = action === 'Save' ? 'Save snippet' : 'Edit snippet';
  const dialog = within(document.body).getByRole('dialog', { name: title });
  const name = within(within(dialog).getByText('Name').parentElement!).getByRole('textbox');
  fireEvent.input(name, { target: { value: 'Committed snippet' } });
  fireEvent.click(within(dialog).getByRole('button', { name: action }));
  await waitFor(() => expect(notifyCalls(notice)).toEqual(['Environment snippet was saved, but settings refresh failed.']));
  expect(within(document.body).queryByRole('dialog', { name: title })).toBeNull();
  expect(persist).toHaveBeenCalledTimes(1);
  expect(publish).toHaveBeenCalledTimes(1);
  expect(settings.envSnippets).toEqual([expect.objectContaining({ name: 'Committed snippet' })]);
  expect(within(container).getByText('Committed snippet')).toBeTruthy();
});

it('saves a snippet through the coordinator and renders it when persistence succeeds', async () => {
  const notice = Notice as unknown as Mock;
  notice.mockClear();
  const settings = JSON.parse(JSON.stringify(DEFAULT_CLAUDIAN_SETTINGS)) as typeof DEFAULT_CLAUDIAN_SETTINGS;
  settings.envSnippets = [];
  const persist = vi.fn<(...args: [typeof settings]) => Promise<void>>().mockResolvedValue(undefined);
  const coordinator = new SettingsCoordinator(settings, persist);
  const host = {
    notifyProviderChatOptionsChanged: vi.fn(),
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

it.each(['', '   '])('clears a context override (%o) through the coordinator while saving valid sibling drafts', async blank => {
  const notice = Notice as unknown as Mock;
  notice.mockClear();
  const settings = JSON.parse(JSON.stringify(DEFAULT_CLAUDIAN_SETTINGS)) as typeof DEFAULT_CLAUDIAN_SETTINGS;
  settings.envSnippets = [{
    id: 'snippet', name: 'Existing snippet name', description: '', scope: 'provider:claude',
    envVars: 'ANTHROPIC_MODEL=custom\nANTHROPIC_DEFAULT_SONNET_MODEL=sibling',
    contextLimits: { custom: 200000, sibling: 100000 },
    modelAliases: { custom: 'Old alias' },
  }];
  const persist = vi.fn<(...args: [typeof settings]) => Promise<void>>().mockResolvedValue(undefined);
  const coordinator = new SettingsCoordinator(settings, persist);
  const host = {
    notifyProviderChatOptionsChanged: vi.fn(),
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
  await joinFocusTimers();
  const dialog = within(document.body).getByRole('dialog', { name: 'Edit snippet' });
  const nameField = within(within(dialog).getByText('Name').parentElement!).getByRole('textbox');
  fireEvent.input(nameField, { target: { value: 'Renamed snippet name' } });
  fireEvent.input(within(dialog).getByRole('textbox', { name: 'Context window for custom' }), { target: { value: blank } });
  fireEvent.input(within(dialog).getByRole('textbox', { name: 'Context window for sibling' }), { target: { value: '128k' } });
  fireEvent.input(within(dialog).getByRole('textbox', { name: 'Alias for custom' }), { target: { value: '' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Update' }));

  await waitFor(() => expect(notifyCalls(notice)).toContain('Environment snippet "Renamed snippet name" updated'));
  await joinFocusTimers();
  expect(persist).toHaveBeenCalledTimes(1);
  const persistedSettings = persist.mock.calls[0][0] as typeof settings;
  expect(persistedSettings.envSnippets).toEqual([
    expect.objectContaining({
      id: 'snippet',
      name: 'Renamed snippet name',
      envVars: 'ANTHROPIC_MODEL=custom\nANTHROPIC_DEFAULT_SONNET_MODEL=sibling',
      scope: 'provider:claude',
      contextLimits: { sibling: 128000 },
      modelAliases: {},
    }),
  ]);
  expect(persistedSettings.envSnippets[0].id).toBe('snippet');
  expect(coordinator.getCommittedSettings().envSnippets).toHaveLength(1);
  expect(coordinator.getCommittedSettings().envSnippets[0]).toEqual(expect.objectContaining({ name: 'Renamed snippet name' }));
  expect(coordinator.getCommittedSettings().envSnippets).toEqual(persistedSettings.envSnippets);
  expect(within(document.body).queryByRole('dialog', { name: 'Edit snippet' })).toBeNull();
  expect(notifyCalls(notice)).toEqual(['Environment snippet "Renamed snippet name" updated']);
  expect(within(container).getByText('Renamed snippet name')).toBeTruthy();
  expect(within(container).queryByText('Existing snippet name')).toBeNull();
  expect(notifyCalls(notice)).not.toContain('Could not complete environment snippet update');
});


it('saves, reloads and inserts snippet overrides for prototype-named custom models', async () => {
  const settings = structuredClone(DEFAULT_CLAUDIAN_SETTINGS);
  settings.envSnippets = [];
  const envVars = 'ANTHROPIC_MODEL=__proto__\nANTHROPIC_DEFAULT_SONNET_MODEL=constructor';
  let persisted = '';
  const adapter = {
    exists: async () => persisted !== '',
    read: async () => persisted,
    write: async (_path: string, content: string) => { persisted = content; },
  } as unknown as VaultFileAdapter;
  const storage = new ClaudianSettingsStorage(adapter, DEFAULT_CLAUDIAN_SETTINGS);
  const coordinator = new SettingsCoordinator(settings, value => storage.save(value));
  const onChanged = vi.fn();
  const host = {
    notifyProviderChatOptionsChanged: vi.fn(),
    settings, mutateSettings: coordinator.mutate.bind(coordinator),
    app: { workspace: { getLeavesOfType: () => [] } },
    getEnvironmentVariablesForScope: () => envVars,
    applyEnvironmentVariables: async () => undefined,
  } as unknown as ProviderHost;
  const container = document.body.createEl('main');
  new EnvSnippetManager(container, host, 'provider:claude', onChanged);
  const joinFocusTimers = captureModalFocusTimers(() => {
    fireEvent.click(within(container).getByRole('button', { name: 'Save current environment as a snippet' }));
  });
  await joinFocusTimers();
  const dialog = within(document.body).getByRole('dialog', { name: 'Save snippet' });
  const fields = within(dialog);
  const name = within(fields.getByText('Name').parentElement!).getByRole('textbox');
  fireEvent.input(name, { target: { value: 'Special model endpoint' } });
  for (const [modelId, alias, limit] of [
    ['__proto__', 'Prototype model', '200k'],
    ['constructor', 'Constructor model', '100k'],
  ]) {
    const aliasInput = fields.getByRole<HTMLInputElement>('textbox', { name: `Alias for ${modelId}` });
    const limitInput = fields.getByRole<HTMLInputElement>('textbox', { name: `Context window for ${modelId}` });
    expect(aliasInput.value).toBe('');
    expect(limitInput.value).toBe('');
    fireEvent.input(aliasInput, { target: { value: alias } });
    fireEvent.input(limitInput, { target: { value: limit } });
  }
  const overrideRow = fields.getByRole('textbox', { name: 'Alias for __proto__' }).parentElement!;
  expect(await axe(overrideRow)).toHaveNoViolations();
  fireEvent.click(fields.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(within(container).getByText('Special model endpoint')).toBeTruthy());
  const expectedAliases = Object.fromEntries([['__proto__', 'Prototype model'], ['constructor', 'Constructor model']]);
  const expectedLimits = Object.fromEntries([['__proto__', 200000], ['constructor', 100000]]);
  expect(settings.envSnippets[0]).toMatchObject({ modelAliases: expectedAliases, contextLimits: expectedLimits });
  const reloaded = await storage.load();
  expect(reloaded.envSnippets[0]).toMatchObject({ modelAliases: expectedAliases, contextLimits: expectedLimits });
  // Rebuild the real manager against decoded data, then run its Insert action.
  Object.assign(settings, reloaded);
  container.replaceChildren();
  new EnvSnippetManager(container, host, 'provider:claude', onChanged);
  fireEvent.click(within(container).getByRole('button', { name: 'Insert' }));
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
  expect(getClaudeProviderSettings(settings).modelAliases).toEqual(expectedAliases);

  const joinEditFocus = captureModalFocusTimers(() => {
    fireEvent.click(within(container).getByRole('button', { name: 'Edit' }));
  });
  await joinEditFocus();
  const edit = within(within(document.body).getByRole('dialog', { name: 'Edit snippet' }));
  for (const [modelId, alias] of Object.entries(expectedAliases)) {
    const input = edit.getByRole<HTMLInputElement>('textbox', { name: `Alias for ${modelId}` });
    expect(input.value).toBe(alias);
    fireEvent.input(input, { target: { value: '' } });
  }
  fireEvent.click(edit.getByRole('button', { name: 'Update' }));
  await waitFor(() => expect(settings.envSnippets[0].modelAliases).toEqual({}));
  onChanged.mockClear();
  fireEvent.click(within(container).getByRole('button', { name: 'Insert' }));
  await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  expect(getClaudeProviderSettings(settings).modelAliases).toEqual({});
});


it('publishes inserted aliases to every mounted model selector', async () => {
  const settings = structuredClone(DEFAULT_CLAUDIAN_SETTINGS);
  settings.model = 'claude-code/custom';
  updateClaudeProviderSettings(settings, {
    discoveredModels: [{ value: 'custom', label: 'Native custom', description: '' }],
    visibleModels: ['custom'], modelAliases: { custom: 'Old alias' },
    environmentVariables: 'ANTHROPIC_MODEL=custom',
  });
  settings.envSnippets = [{ id: 'snippet', name: 'Alias only', description: '', scope: 'provider:claude',
    envVars: 'ANTHROPIC_MODEL=custom', modelAliases: { custom: 'New alias' } }];
  const containers = [document.body.createDiv(), document.body.createDiv()];
  const selectors = containers.map(container => new ModelSelector(container, {
    getSettings: () => getChatSettingsSnapshot(settings, 'claude', settings.model),
    getUIConfig: () => claudeChatUIConfig,
    onModelChange: async () => undefined,
    onEffortLevelChange: async () => undefined,
    getCapabilities: () => ProviderRegistry.getCapabilities('claude'),
  }));
  const views = selectors.map(selector => ({ refreshModelSelector() { selector.updateDisplay(); selector.renderOptions(); } }));
  const publisher = new ChatViewPublisher({
    views: { getAllViews: () => views as never }, zenMode: { reconcile() {} }, inactiveSessions: { request() {} },
    hasLoadedAllSessionMetadata: () => true,
  });
  let saved = '';
  const coordinator = new SettingsCoordinator(settings, async draft => { saved = JSON.stringify(draft); },
    (current, previous) => publisher.publishSettings(current, previous));
  const reconciler = new ProviderChatOptionsReconciler({
    settings: coordinator,
    providers: { getProviderDisplayName: () => 'Claude' }, providerSettings: ProviderSettingsCoordinator,
    reconcileConversationModels: async () => [], onSettingsReconciled() {}, onConversationsChanged() {},
    onReconciled: providerId => publisher.refreshModelSelector(providerId),
  });
  const host = {
    settings, app: { workspace: { getLeavesOfType: () => views.map(view => ({ view })) } },
    // The snippet uses the already-applied environment; this boundary has no runtime changes to publish.
    applyEnvironmentVariables: async () => undefined,
    mutateSettings: coordinator.mutate.bind(coordinator),
    notifyProviderChatOptionsChanged: (providerId: string) => { void reconciler.notifyChanged(providerId); },
  } as unknown as ProviderHost;
  for (const container of containers) expect(within(container).getByRole('button', { name: 'Model: Old alias' })).toBeTruthy();
  const manager = document.body.createDiv();
  new EnvSnippetManager(manager, host, 'provider:claude');

  fireEvent.click(within(manager).getByRole('button', { name: 'Insert' }));

  for (const container of containers) {
    await waitFor(() => expect(within(container).getByRole('button', { name: 'Model: New alias' })).toBeTruthy());
  }
  expect(getClaudeProviderSettings(JSON.parse(saved)).modelAliases).toMatchObject({ custom: 'New alias' });
  expect(await axe(manager)).toHaveNoViolations();
});
