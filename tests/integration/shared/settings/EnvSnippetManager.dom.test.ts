/** @vitest-environment jsdom */

import '@/providers';

import { axe } from '@test/helpers/accessibility';
import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import { Notice } from 'obsidian';
import type { Mock } from 'vitest';

import { getProviderEnvironmentVariables, getRuntimeEnvironmentVariables } from '@/core/providers/providerEnvironment';
import { getClaudeProviderSettings, updateClaudeProviderSettings } from '@/providers/claude/settings';
import { EnvSnippetManager, EnvSnippetModal } from '@/shared/settings/EnvSnippetManager';

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

it.each<Record<string, string>>([{}, { custom: ' Snippet name ' }])('leaves provider aliases alone when inserting a snippet with aliases %o', async modelAliases => {
  const notifyProviderChatOptionsChanged = vi.fn();
  const { host, settings } = await createProviderHostFixture({
    overrides: {
      notifyProviderChatOptionsChanged,
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
  await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  expect(applyEnvironmentVariables).toHaveBeenCalledWith('provider:claude', 'ANTHROPIC_MODEL=custom');
  expect(getClaudeProviderSettings(settings).modelAliases).toEqual({ custom: 'Old name', other: 'Keep name' });
  expect(notifyProviderChatOptionsChanged).not.toHaveBeenCalled();
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
  // The editor offers no per-model alias or context-limit fields for environment-declared models.
  expect(within(dialog).getAllByRole('textbox')).toEqual([name, description, environment]);
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
  expect(settings.envSnippets[0]).not.toHaveProperty('contextLimits');
  expect(settings.envSnippets[0].modelAliases).toBeUndefined();
  await waitFor(() => expect(within(container).getByRole('button', { name: 'Insert' })).toBeTruthy());
});

it('keeps stored aliases when an edited snippet no longer declares their models', async () => {
  const { host } = await createProviderHostFixture();
  const snippet = {
    id: 'snippet', name: 'Custom endpoint', description: '', scope: 'provider:claude' as const,
    envVars: 'ANTHROPIC_MODEL=custom', modelAliases: { custom: 'Old alias' },
  };
  const save = vi.fn();

  const modal = new EnvSnippetModal(host.app, host, snippet, 'provider:claude', save);
  const joinFocusTimers = captureModalFocusTimers(() => { modal.open(); });
  const dialog = within(document.body).getByRole('dialog', { name: 'Edit snippet' });
  const environment = within(dialog).getByRole<HTMLTextAreaElement>('textbox', { name: 'Environment variables' });
  expect(environment.value).toBe(snippet.envVars);
  expect(within(dialog).getAllByRole('textbox')).toEqual([
    within(dialog).getByRole('textbox', { name: 'Name' }),
    within(dialog).getByRole('textbox', { name: 'Description' }),
    environment,
  ]);
  fireEvent.input(environment, { target: { value: 'ANTHROPIC_MODEL=other\nCUSTOM_FLAG=true' } });
  fireEvent.blur(environment);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Update' }));
  expect(save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    envVars: 'ANTHROPIC_MODEL=other\nCUSTOM_FLAG=true',
    modelAliases: { custom: 'Old alias' },
  }));
  await joinFocusTimers();
});

it.each(['Update', 'name Enter', 'Save'] as const)(
  'saves drafts once through %s and ignores repeated submits while persisting',
  async action => {
    const notice = Notice as unknown as Mock;
    notice.mockClear();
    const { host, settings, coordinator, settingsStorage } = await createProviderHostFixture({
      beforePersist: draft => persist(draft),
      overrides: { getEnvironmentVariablesForScope: () => envVars },
    });
    const envVars = 'ANTHROPIC_MODEL=sibling\nANTHROPIC_DEFAULT_SONNET_MODEL=custom';
    // Prototype-named keys must survive the edit and a storage round trip as own entries.
    const storedOverrides = {
      modelAliases: JSON.parse('{"__proto__":"Prototype model","constructor":"Constructor model"}') as Record<string, string>,
    };
    const originalSnippet = {
      id: 'snippet', name: 'Existing snippet name', description: 'Original description',
      scope: 'provider:claude' as const, envVars, ...storedOverrides,
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
    const environment = fields.getByRole<HTMLTextAreaElement>('textbox', { name: 'Environment variables' });
    expect(environment.value).toBe(envVars);
    const draftEnvironment = `${envVars}\nANTHROPIC_BASE_URL=https://example.invalid`;
    fireEvent.input(environment, { target: { value: draftEnvironment } });
    fireEvent.blur(environment);
    const submit = (): boolean => {
      if (action === 'name Enter') {
        return fireEvent.keyDown(nameField, { key: 'Enter' });
      }
      return fireEvent.click(fields.getByRole('button', { name: action }));
    };
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
      envVars: draftEnvironment, ...(action === 'Save' ? {} : storedOverrides),
    };
    const expectedSnippets = action === 'Save'
      ? [unrelatedSnippet, savedSnippet] : [savedSnippet, unrelatedSnippet];
    expect(persist.mock.calls[0][0]).toEqual({ ...originalSettings, envSnippets: expectedSnippets });
    completePersistence();
    const success = `Environment snippet "Renamed snippet name" ${action === 'Save' ? 'saved' : 'updated'}`;
    await waitFor(() => expect(notifyCalls(notice)).toContain(success));
    expect(within(document.body).queryByRole('dialog', { name: dialogName })).toBeNull();
    expect(notifyCalls(notice)).toEqual([success]);
    expect(mutateSettings).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(coordinator.getCommittedSettings()).toEqual({ ...originalSettings, envSnippets: expectedSnippets });
    expect(within(container).getByText('Renamed snippet name')).toBeTruthy();
    expect(within(container).queryByText('Existing snippet name')).toBeNull();
    const reloaded = (await settingsStorage.load()).envSnippets.find(snippet => snippet.name === 'Renamed snippet name')!;
    expect({
      modelAliases: reloaded.modelAliases && JSON.parse(JSON.stringify(reloaded.modelAliases)),
      ownPrototypeKey: reloaded.modelAliases !== undefined && Object.hasOwn(reloaded.modelAliases, '__proto__'),
    }).toEqual(action === 'Save'
      ? { modelAliases: undefined, ownPrototypeKey: false }
      : { ...storedOverrides, ownPrototypeKey: true });
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
    name, description, envVars,
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
