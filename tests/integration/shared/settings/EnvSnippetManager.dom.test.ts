/** @vitest-environment jsdom */

import '@/providers';

import { axe } from '@test/helpers/accessibility';
import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import { Notice } from 'obsidian';
import type { Mock } from 'vitest';

import { ProviderChatOptionsReconciler } from '@/app/settings/ProviderChatOptionsReconciler';
import { getProviderEnvironmentVariables, getRuntimeEnvironmentVariables } from '@/core/providers/providerEnvironment';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import { getChatSettingsSnapshot } from '@/features/chat/ChatSettings';
import { ChatViewPublisher } from '@/features/chat/workspace/ChatViewPublisher';
import { setLocale } from '@/i18n/i18n';
import { getClaudeProviderSettings, updateClaudeProviderSettings } from '@/providers/claude/settings';
import { claudeChatUIConfig } from '@/providers/claude/ui/ClaudeChatUIConfig';
import { EnvSnippetManager, EnvSnippetModal } from '@/shared/settings/EnvSnippetManager';
import { ModelSelector } from '@/shared/toolbar/ModelSelector';

type ModalTimerJoin = () => Promise<void>;

const timerSpyCleanups: Array<() => void> = [];

afterEach(() => {
  setLocale('en');
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

it.each(['Name', 'Description'])('closes once when host Escape reaches the %s field', async fieldName => {
  const { host } = await createProviderHostFixture();
  const save = vi.fn();
  const modal = new EnvSnippetModal(host.app, host, null, 'provider:claude', save);
  onTestFinished(() => {
    if (modal.containerEl.isConnected) modal.close();
  });
  const close = vi.spyOn(modal, 'onClose');
  const release = vi.spyOn(host.app.keymap, 'popScope');
  const joinFocusTimers = captureModalFocusTimers(() => { modal.open(); });
  await joinFocusTimers();
  const dialog = within(document.body).getByRole('dialog', { name: 'Save snippet' });
  const field = within(dialog).getByRole<HTMLInputElement>('textbox', { name: fieldName });
  field.focus();
  const received: KeyboardEvent[] = [];
  field.addEventListener('keydown', event => { received.push(event); });
  const beforeTarget: Array<{ released: number; connected: boolean; prevented: boolean }> = [];
  const observeCapture = (event: KeyboardEvent) => {
    beforeTarget.push({
      released: release.mock.calls.length,
      connected: field.isConnected,
      prevented: event.defaultPrevented,
    });
  };
  document.addEventListener('keydown', observeCapture, true);
  onTestFinished(() => document.removeEventListener('keydown', observeCapture, true));
  const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });

  field.dispatchEvent(escape);

  // The host closes in window capture; the original event still reaches its detached input.
  expect(beforeTarget).toEqual([{ released: 1, connected: false, prevented: true }]);
  expect(received).toEqual([escape]);
  expect(escape.defaultPrevented).toBe(true);
  expect(escape.target).toBe(field);
  expect(within(document.body).queryByRole('dialog', { name: 'Save snippet' })).toBeNull();
  expect(close).toHaveBeenCalledTimes(1);
  expect(release).toHaveBeenCalledExactlyOnceWith(modal.scope);
  expect(save).not.toHaveBeenCalled();
});

it('preserves own context-limit keys when inserting a snippet with production object-spread semantics', async () => {
  const { host, settings } = await createProviderHostFixture({
    overrides: {
      notifyProviderChatOptionsChanged: vi.fn(),
      applyEnvironmentVariables: async () => undefined,
    },
  });
  settings.customContextLimits = { sibling: 256000 };
  settings.envSnippets = [{
    id: 'snippet', name: 'Custom limits', description: '', scope: 'provider:claude',
    envVars: 'ANTHROPIC_MODEL=custom',
    contextLimits: JSON.parse('{"__proto__":64000,"custom":128000}') as Record<string, number>,
  }];

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

it.each([
  { envVars: 'ANTHROPIC_MODEL=custom\n# Claude trailing', model: 'custom' },
  { envVars: '# Claude only', model: undefined },
])('preserves shared settings when inserting the scoped snippet $envVars', async ({ envVars, model }) => {
  const shared = 'PATH=/generated/bin\nHTTPS_PROXY=http://proxy.example.test:8080\n# shared keep';
  const { host, settings, settingsStorage } = await createProviderHostFixture({ settings: {
    sharedEnvironmentVariables: shared,
    providerConfigs: {
      claude: { environmentVariables: 'ANTHROPIC_MODEL=old' },
      codex: { environmentVariables: 'OPENAI_MODEL=codex-keep' },
    },
    envSnippets: [{ id: 'commented', name: 'Commented Claude', description: '', scope: 'provider:claude', envVars }],
  } });
  const container = document.body.createEl('main');
  const completed = vi.fn();
  new EnvSnippetManager(container, host, 'provider:claude', completed);

  fireEvent.click(within(container).getByRole('button', { name: 'Insert' }));
  await waitFor(() => expect(completed).toHaveBeenCalledTimes(1));

  expect(settings.sharedEnvironmentVariables).toBe(shared);
  expect(getProviderEnvironmentVariables(settings, 'claude')).toBe(envVars);
  expect(getProviderEnvironmentVariables(settings, 'codex')).toBe('OPENAI_MODEL=codex-keep');
  expect(getRuntimeEnvironmentVariables(settings, 'claude')).toEqual({
    PATH: '/generated/bin', HTTPS_PROXY: 'http://proxy.example.test:8080',
    ...(model ? { ANTHROPIC_MODEL: model } : {}),
  });
  expect(getRuntimeEnvironmentVariables(settings, 'codex')).toEqual({
    PATH: '/generated/bin', HTTPS_PROXY: 'http://proxy.example.test:8080', OPENAI_MODEL: 'codex-keep',
  });
  const reloaded = await settingsStorage.load();
  expect(reloaded.sharedEnvironmentVariables).toBe(shared);
  expect(getProviderEnvironmentVariables(reloaded, 'claude')).toBe(envVars);
  expect(getProviderEnvironmentVariables(reloaded, 'codex')).toBe('OPENAI_MODEL=codex-keep');
});

it.each(aliasCases)('applies snippet aliases through provider settings while preserving unrelated aliases (%o)', async modelAliases => {
  const { host, settings } = await createProviderHostFixture({
    overrides: {
      notifyProviderChatOptionsChanged: vi.fn(),
      applyEnvironmentVariables: (...args) => applyEnvironmentVariables(...args),
    },
  });
  updateClaudeProviderSettings(settings, { modelAliases: { custom: 'Old name', other: 'Keep name' }, loadUserSettings: false });
  settings.envSnippets = [{
    id: 'snippet', name: 'Custom endpoint', description: '', scope: 'provider:claude',
    envVars: 'ANTHROPIC_MODEL=custom', modelAliases,
  }];
  const applyEnvironmentVariables = vi.fn().mockResolvedValue(undefined);

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
  const { host, settings } = await createProviderHostFixture({
    overrides: {
      notifyProviderChatOptionsChanged: vi.fn(),
      getEnvironmentVariablesForScope: () => 'ANTHROPIC_MODEL=custom',
    },
  });
  settings.envSnippets = [];

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
  const { host } = await createProviderHostFixture();
  const snippet = {
    id: 'snippet', name: 'Custom endpoint', description: '', scope: 'provider:claude' as const,
    envVars: 'ANTHROPIC_MODEL=custom', modelAliases: { custom: 'Old alias' }, contextLimits: { custom: 200000 },
  };
  const save = vi.fn();

  const modal = new EnvSnippetModal(host.app, host, snippet, 'provider:claude', save);
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
      const { host } = await createProviderHostFixture();
      const snippet = {
        id: 'snippet', name: 'Custom endpoint', description: '', scope: 'provider:claude' as const,
        envVars: 'ANTHROPIC_MODEL=custom',
        modelAliases: { custom: 'Old alias' },
        contextLimits: { custom: 256500 },
      };
      const save = vi.fn();

      const modal = new EnvSnippetModal(host.app, host, snippet, 'provider:claude', save);
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
    const { host, settings, coordinator } = await createProviderHostFixture({
    beforePersist: draft => persist(draft),
    overrides: { getEnvironmentVariablesForScope: () => envVars }
  });
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

    const mutateSettings = vi.spyOn(host, 'mutateSettings');

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
    const nameField = fields.getByRole<HTMLInputElement>('textbox', { name: 'Name' });
    const descriptionField = fields.getByRole<HTMLInputElement>('textbox', { name: 'Description' });
    fireEvent.input(nameField, { target: { value: 'Renamed snippet name' } });
    fireEvent.input(descriptionField, { target: { value: 'Draft description' } });
    fireEvent.input(fields.getByRole('textbox', { name: 'Context window for custom' }), { target: { value: invalidContext } });
    fireEvent.input(fields.getByRole('textbox', { name: 'Context window for sibling' }), { target: { value: '128k' } });
    fireEvent.input(fields.getByRole('textbox', { name: 'Alias for custom' }), { target: { value: ' Custom draft ' } });
    fireEvent.input(fields.getByRole('textbox', { name: 'Alias for sibling' }), { target: { value: ' Sibling draft ' } });
    const environment = fields.getByRole<HTMLTextAreaElement>('textbox', { name: 'Environment variables' });
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
    await coordinator.mutateConditionally(() => false);
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
  const { host, settings, coordinator } = await createProviderHostFixture({
    beforePersist: draft => persist(draft),
    overrides: {
      notifyProviderChatOptionsChanged: vi.fn(),
      getEnvironmentVariablesForScope: () => 'ANTHROPIC_MODEL=custom',
    },
  });
  settings.envSnippets = action === 'Save' ? [] : [{
    id: 'snippet', name: 'Existing snippet name', description: '', scope: 'provider:claude',
    envVars: 'ANTHROPIC_MODEL=custom',
  }];
  const originalSnippets = structuredClone(settings.envSnippets);
  const persist = vi.fn<(...args: [typeof settings]) => Promise<void>>()
    .mockRejectedValueOnce(new Error('storage unavailable')).mockResolvedValue(undefined);

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
  const field = (name: string) => fields.getByRole<HTMLInputElement>('textbox', { name });
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
  const { host, settings } = await createProviderHostFixture({
    beforePersist: draft => persist(draft),
    afterPublish: () => publish(),
    overrides: { getEnvironmentVariablesForScope: () => 'ANTHROPIC_MODEL=custom' }
  });
  settings.envSnippets = action === 'Save' ? [] : [{
    id: 'snippet', name: 'Existing snippet name', description: '', scope: 'provider:claude',
    envVars: 'ANTHROPIC_MODEL=custom',
  }];
  const persist = vi.fn<(...args: [typeof settings]) => Promise<void>>().mockResolvedValue(undefined);
  const publish = vi.fn(() => { throw new Error('view refresh failed'); });

  const container = document.body.createEl('main');
  new EnvSnippetManager(container, host, 'provider:claude');
  await captureModalFocusTimers(() => {
    fireEvent.click(within(container).getByRole('button', {
      name: action === 'Save' ? 'Save current environment as a snippet' : 'Edit',
    }));
  })();
  const title = action === 'Save' ? 'Save snippet' : 'Edit snippet';
  const dialog = within(document.body).getByRole('dialog', { name: title });
  const name = within(dialog).getByRole('textbox', { name: 'Name' });
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
  const { host, settings, coordinator } = await createProviderHostFixture({
    beforePersist: draft => persist(draft),
    overrides: {
      notifyProviderChatOptionsChanged: vi.fn(),
      getEnvironmentVariablesForScope: () => 'ANTHROPIC_MODEL=custom',
    },
  });
  settings.envSnippets = [];
  const persist = vi.fn<(...args: [typeof settings]) => Promise<void>>().mockResolvedValue(undefined);

  const container = document.body.createEl('main');
  new EnvSnippetManager(container, host, 'provider:claude');

  const joinFocusTimers = captureModalFocusTimers(() => {
    fireEvent.click(within(container).getByRole('button', { name: 'Save current environment as a snippet' }));
  });
  const dialog = within(document.body).getByRole('dialog', { name: 'Save snippet' });
  const nameField = within(dialog).getByRole('textbox', { name: 'Name' });
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
  const { host, settings, coordinator } = await createProviderHostFixture({
    beforePersist: draft => persist(draft),
    overrides: {
      notifyProviderChatOptionsChanged: vi.fn(),
      getEnvironmentVariablesForScope: () => 'ANTHROPIC_MODEL=custom',
    },
  });
  settings.envSnippets = [{
    id: 'snippet', name: 'Existing snippet name', description: '', scope: 'provider:claude',
    envVars: 'ANTHROPIC_MODEL=custom\nANTHROPIC_DEFAULT_SONNET_MODEL=sibling',
    contextLimits: { custom: 200000, sibling: 100000 },
    modelAliases: { custom: 'Old alias' },
  }];
  const persist = vi.fn<(...args: [typeof settings]) => Promise<void>>().mockResolvedValue(undefined);

  const container = document.body.createEl('main');
  new EnvSnippetManager(container, host, 'provider:claude');

  const joinFocusTimers = captureModalFocusTimers(() => {
    fireEvent.click(within(container).getByRole('button', { name: 'Edit' }));
  });
  await joinFocusTimers();
  const dialog = within(document.body).getByRole('dialog', { name: 'Edit snippet' });
  const nameField = within(dialog).getByRole('textbox', { name: 'Name' });
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
  const { host, settings, settingsStorage: storage } = await createProviderHostFixture({
    overrides: { notifyProviderChatOptionsChanged: vi.fn(),
      getEnvironmentVariablesForScope: () => envVars,
      applyEnvironmentVariables: async () => undefined }
  });
  settings.envSnippets = [];
  const envVars = 'ANTHROPIC_MODEL=__proto__\nANTHROPIC_DEFAULT_SONNET_MODEL=constructor';

  const onChanged = vi.fn();

  const container = document.body.createEl('main');
  new EnvSnippetManager(container, host, 'provider:claude', onChanged);
  const joinFocusTimers = captureModalFocusTimers(() => {
    fireEvent.click(within(container).getByRole('button', { name: 'Save current environment as a snippet' }));
  });
  await joinFocusTimers();
  const dialog = within(document.body).getByRole('dialog', { name: 'Save snippet' });
  const fields = within(dialog);
  const name = fields.getByRole('textbox', { name: 'Name' });
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
  const { host, settings, coordinator } = await createProviderHostFixture({
    beforePersist: async draft => { saved = JSON.stringify(draft); },
    afterPublish: (current, previous) => publisher.publishSettings(current, previous),
    overrides: {
      applyEnvironmentVariables: async () => undefined,
      notifyProviderChatOptionsChanged: (providerId: string) => { void reconciler.notifyChanged(providerId); },
    },
  });
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

  const reconciler = new ProviderChatOptionsReconciler({
    settings: coordinator,
    providers: { getProviderDisplayName: () => 'Claude' }, providerSettings: ProviderSettingsCoordinator,
    reconcileConversationModels: async () => [], onSettingsReconciled() {}, onConversationsChanged() {},
    onReconciled: providerId => publisher.refreshModelSelector(providerId),
  });

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

it.each([
  { action: 'Save', phase: 'beforePersist', title: '保存片段', button: '保存', failure: '无法完成环境片段保存', success: '环境片段“Save”已保存' },
  { action: 'Update', phase: 'beforePersist', title: '编辑片段', button: '更新', failure: '无法完成环境片段更新', success: '环境片段“Save”已更新' },
  { action: 'Save', phase: 'afterPublish', title: '保存片段', button: '保存', failure: '环境片段已保存，但设置刷新失败。', success: '环境片段“Save”已保存' },
  { action: 'Update', phase: 'afterPublish', title: '编辑片段', button: '更新', failure: '环境片段已保存，但设置刷新失败。', success: '环境片段“Save”已更新' },
])('localizes $action $phase feedback and preserves native snippet drafts and commit policy', async ({ action, phase, title, button, failure, success }) => {
  setLocale('zh-CN');
  vi.mocked(Notice).mockClear();
  let armed = false;
  const envVars = 'ANTHROPIC_MODEL=Save\nANTHROPIC_BASE_URL=https://example.invalid/Environment';
  const fixture = await createProviderHostFixture({
    settings: { locale: 'zh-CN', providerConfigs: { claude: { environmentVariables: envVars } },
      envSnippets: action === 'Save' ? [] : [{ id: 'snippet-Save', name: 'Archive', description: '', envVars, scope: 'provider:claude' }],
    },
    beforePersist: () => { if (armed && phase === 'beforePersist') throw new Error('storage unavailable'); },
    afterPublish: () => { if (armed && phase === 'afterPublish') throw new Error('refresh unavailable'); },
  });
  await fixture.coordinator.persistCurrent();
  const original = structuredClone(fixture.settings.envSnippets);
  const container = document.body.createEl('main');
  new EnvSnippetManager(container, fixture.host, 'provider:claude');
  let closeDialog = () => undefined as void;
  try {
    await captureModalFocusTimers(() => {
      fireEvent.click(within(container).getByRole('button', { name: action === 'Save' ? '将当前环境保存为片段' : '编辑' }));
    })();
    const dialog = within(document.body).getByRole('dialog', { name: title });
    closeDialog = () => { if (dialog.isConnected) fireEvent.click(within(dialog).getByRole('button', { name: '取消' })); };
    const fields = within(dialog);
    const name = fields.getByRole<HTMLInputElement>('textbox', { name: '名称' });
    const description = fields.getByRole<HTMLInputElement>('textbox', { name: '描述' });
    const environment = fields.getByRole<HTMLTextAreaElement>('textbox', { name: '环境变量' });
    const alias = fields.getByRole<HTMLInputElement>('textbox', { name: /^(Alias for Save|Save 的别名)$/ });
    const context = fields.getByRole<HTMLInputElement>('textbox', { name: /^(Context window for Save|Save 的上下文窗口)$/ });
    expect.soft(alias.getAttribute('aria-label')).toBe('Save 的别名');
    expect.soft(context.getAttribute('aria-label')).toBe('Save 的上下文窗口');
    fireEvent.input(name, { target: { value: '  Save  ' } });
    fireEvent.input(description, { target: { value: '  Environment variables  ' } });
    fireEvent.input(alias, { target: { value: '  Context window  ' } });
    fireEvent.input(context, { target: { value: '64k' } });
    expect(environment.value).toBe(envVars);
    const save = fields.getByRole<HTMLButtonElement>('button', { name: button });
    armed = true;
    fireEvent.click(save);
    await waitFor(() => expect(Notice).toHaveBeenCalledWith(failure));
    const retryRetainedDraft = async () => {
      expect(within(document.body).getByRole('dialog', { name: title })).toBe(dialog);
      expect(name.value).toBe('  Save  ');
      expect(description.value).toBe('  Environment variables  ');
      expect(alias.value).toBe('  Context window  ');
      expect(context.value).toBe('64k');
      expect(environment.value).toBe(envVars);
      expect(save.disabled).toBe(false);
      expect(fixture.coordinator.getCommittedSettings().envSnippets).toEqual(original);
      expect((await fixture.settingsStorage.load()).envSnippets).toEqual(original);
      armed = false;
      fireEvent.click(save);
      await waitFor(() => expect(Notice).toHaveBeenCalledWith(success));
    };
    if (phase === 'beforePersist') await retryRetainedDraft();
    expect(within(document.body).queryByRole('dialog', { name: title })).toBeNull();
    const saved = fixture.settings.envSnippets[0];
    expect(saved).toMatchObject({ name: 'Save', description: 'Environment variables', envVars, scope: 'provider:claude',
      modelAliases: { Save: 'Context window' }, contextLimits: { Save: 64000 } });
    expect(saved.id).toMatch(action === 'Update' ? /^snippet-Save$/ : /^snippet-/);
    expect((await fixture.settingsStorage.load()).envSnippets).toEqual([saved]);
    expect(within(container).getByText('Save')).toBeTruthy();
    expect(await axe(container)).toHaveNoViolations();
    const deleteSavedSnippet = async () => {
      fireEvent.click(within(container).getByRole('button', { name: '删除' }));
      const confirm = within(document.body).getByRole('dialog', { name: '确认' });
      expect(within(confirm).getByText('删除环境变量片段“Save”？')).toBeTruthy();
      fireEvent.click(within(confirm).getByRole('button', { name: '删除' }));
      await waitFor(() => expect(Notice).toHaveBeenCalledWith('环境片段“Save”已删除'));
      expect(fixture.settings.envSnippets).toEqual([]);
      expect((await fixture.settingsStorage.load()).envSnippets).toEqual([]);
    };
    if (action === 'Save' && phase === 'beforePersist') await deleteSavedSnippet();
  } finally { armed = false; closeDialog(); await fixture.dispose(); container.remove(); }
});
