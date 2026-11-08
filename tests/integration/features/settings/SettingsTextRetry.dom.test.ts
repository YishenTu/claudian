/** @vitest-environment jsdom */
import '@/providers';

import { deserialize, serialize } from 'node:v8';

import { axe } from '@test/helpers/accessibility';
import { beginExecution, createHarness, createSubmission, requestedScope } from '@test/helpers/ChatExecutionHarness';
import { createFeatureHostFixture } from '@test/helpers/FeatureHostFixture';
import { createObsidianPlugin, mountSettingTab } from '@test/helpers/ObsidianSettingsHost';
import { testDate } from '@test/helpers/testClock';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import { Notice } from 'obsidian';

import type { ClaudianSettings } from '@/core/types';
import { ClaudianSettingTab } from '@/features/settings/ClaudianSettings';
import { setLocale, t } from '@/i18n/i18n';

afterEach(() => { setLocale('en'); document.body.replaceChildren(); vi.restoreAllMocks(); vi.clearAllMocks(); });

it.each([
  { locale: 'en' as const, label: 'What should Claudian call you?', notice: 'Failed to save settings' },
  { locale: 'zh-CN' as const, label: 'Claudian 应该如何称呼你？', notice: '保存设置失败' },
])('retries an unchanged user-name draft after a rejected save in $locale', async ({ locale, label, notice }) => {
  globalThis.structuredClone ??= value => deserialize(serialize(value));
  const persist = vi.fn<(draft: ClaudianSettings) => Promise<void>>().mockResolvedValue(undefined);
  const fixture = await createFeatureHostFixture({
    settings: { locale, userName: 'Before', enableAutoTitleGeneration: false },
    beforePersist: persist,
  });
  const { settings, host, coordinator, settingsStorage: storage } = fixture;
  await storage.save(settings);
  const runProviderExecutionTransition = vi.spyOn(host.providerHost, 'runProviderExecutionTransition');
  const tab = new ClaudianSettingTab(host.app, createObsidianPlugin(host.app), host);
  const container = document.body.createDiv();
  const cleanup = mountSettingTab(tab, container);
  try {
    const input = within(container).getByRole<HTMLInputElement>('textbox', { name: label });
    const row = input.closest<HTMLElement>('.setting-item')!;
    persist.mockRejectedValueOnce(new Error('Disk unavailable'));
    fireEvent.input(input, { target: { value: 'After' } });
    fireEvent.blur(input);
    await waitFor(() => expect(Notice).toHaveBeenCalledWith(notice));
    expect(settings.userName).toBe('Before');
    expect((await storage.load()).userName).toBe('Before');
    expect(input.value).toBe('After');
    expect(runProviderExecutionTransition).not.toHaveBeenCalled();

    fireEvent.focus(input);
    fireEvent.blur(input);
    await waitFor(() => expect(settings.userName).toBe('After'));
    await coordinator.mutateConditionally(() => false);
    expect((await storage.load()).userName).toBe('After');
    expect(input.value).toBe('After');
    expect(persist).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(runProviderExecutionTransition).toHaveBeenCalledTimes(1));
    expect((await axe(row, { runOnly: ['aria-valid-attr', 'aria-valid-attr-value'] })).violations).toEqual([]);
  } finally {
    persist.mockResolvedValue(undefined);
    cleanup();
    await coordinator.mutateConditionally(() => false);
    await fixture.dispose();
  }
});

it.each([false, true])('shows the newest text draft when settings reopen before a successful save finishes (newer edit: %s)', async newerEdit => {
  let started!: () => void;
  let finish!: () => void;
  const writing = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { finish = resolve; });
  let writes = 0;
  const { settings, coordinator, settingsStorage: storage, host } = await createFeatureHostFixture({
    settings: { userName: 'Before', enableAutoTitleGeneration: false },
    beforePersist: async () => { if (++writes === 1) { started(); await gate; } },
  });
  await storage.save(settings);
  const tab = new ClaudianSettingTab(host.app, createObsidianPlugin(host.app), host);
  const first = document.body.createDiv();
  let cleanup = tab['renderSettings'](first);
  const userName = (container: HTMLElement) => within(container).getByRole<HTMLInputElement>('textbox', { name: t('settings.userName.name') });
  try {
    fireEvent.input(userName(first), { target: { value: 'After' } });
    fireEvent.blur(userName(first));
    await writing;
    // Obsidian disposes a setting section, removes its DOM, then renders it again on reopening.
    cleanup();
    first.remove();
    let reopened = document.body.createDiv();
    cleanup = tab['renderSettings'](reopened);
    expect(settings.userName).toBe('Before');
    expect(writes).toBe(1);
    if (newerEdit) {
      fireEvent.input(userName(reopened), { target: { value: 'Newest' } });
      cleanup();
      reopened.remove();
      reopened = document.body.createDiv();
      cleanup = tab['renderSettings'](reopened);
    }
    const expected = newerEdit ? 'Newest' : 'After';
    finish();
    await waitFor(() => expect(settings.userName).toBe(expected));
    await coordinator.persistCurrent();
    expect((await storage.load()).userName).toBe(expected);
    expect(userName(reopened).value).toBe(expected);
    fireEvent.input(userName(reopened), { target: { value: `${userName(reopened).value} Smith` } });
    fireEvent.blur(userName(reopened));
    await waitFor(() => expect(settings.userName).toBe(`${expected} Smith`));
    await coordinator.persistCurrent();
    expect((await storage.load()).userName).toBe(`${expected} Smith`);
  } finally { finish(); cleanup(); await coordinator.persistCurrent(); }
});

it.each([
  { key: 'userName' as const, label: 'settings.userName.name' as const, next: 'After' },
  { key: 'systemPrompt' as const, label: 'settings.systemPrompt.name' as const, next: 'Updated instructions' },
  { key: 'mediaFolder' as const, label: 'settings.mediaFolder.name' as const, next: 'New Attachments' },
])('keeps a running reply when unchanged $key loses focus and restarts only after a real edit', async ({ key, label, next }) => {
  let saved = JSON.stringify({ userName: 'Before' });
  const execution = createHarness();
  const transition = vi.spyOn(execution.registry, 'runTransition');
  const { settings, host } = await createFeatureHostFixture({
    settings: { userName: 'Before', systemPrompt: 'Initial instructions', mediaFolder: 'Attachments', enableAutoTitleGeneration: false },
    beforePersist: draft => { saved = JSON.stringify(draft); },
    providerOverrides: { runProviderExecutionTransition: execution.registry.runTransition.bind(execution.registry) },
  });
  const tab = new ClaudianSettingTab(host.app, createObsidianPlugin(host.app), host);
  const container = document.body.createDiv();
  tab['renderGeneralTab'](container);
  const row = within(container).getByRole('textbox', { name: t(label) }).closest<HTMLElement>('.setting-item')!;
  const input = within(row).getByRole<HTMLInputElement | HTMLTextAreaElement>('textbox');
  const active = await beginExecution(execution, createSubmission({ timestamp: testDate().getTime() }));
  active.run.events.push({ type: 'turn_started', accepted: true, scope: requestedScope(active.session, active.run, 1) });
  await waitFor(() => expect(execution.repository.recordConversationActivity).toHaveBeenCalled());
  try {
    input.focus();
    input.blur();
    await tab['textEdits'].flush();
    // Join any actual registry transition admitted by the DOM handler; the spy delegates to the real registry.
    await Promise.all(transition.mock.results.map(result => result.value));
    expect(active.session.disposeCalls).toBe(0);
    expect(active.run.cancelCalls).toBe(0);
    expect(active.session.requests[0].signal.aborted).toBe(false);
    const original = input.value;
    fireEvent.input(input, { target: { value: next } });
    fireEvent.input(input, { target: { value: original } });
    fireEvent.blur(input);
    await tab['textEdits'].flush();
    await Promise.all(transition.mock.results.map(result => result.value));
    expect(active.session.disposeCalls).toBe(0);
    expect(active.run.cancelCalls).toBe(0);
    const tags = within(container).getByRole('textbox', { name: t('settings.excludedTags.name') });
    fireEvent.input(tags, { target: { value: 'excluded' } });
    fireEvent.blur(tags);
    await tab['textEdits'].flush();
    expect(transition).not.toHaveBeenCalled();
    active.run.events.push({ type: 'turn_completed', reason: 'completed', scope: requestedScope(active.session, active.run, 2) });
    active.run.events.end();
    await expect(active.resultPromise).resolves.toMatchObject({ status: 'completed', accepted: true });
    expect(transition).not.toHaveBeenCalled();

    fireEvent.input(input, { target: { value: next } });
    fireEvent.blur(input);
    await tab['textEdits'].flush();
    await Promise.all(transition.mock.results.map(result => result.value));
    expect(settings[key]).toBe(next);
    expect(JSON.parse(saved)[key]).toBe(next);
    expect(transition).toHaveBeenCalledTimes(1);
    expect(transition).toHaveBeenCalledWith(
      expect.arrayContaining(['claude', 'codex', 'grok', 'opencode', 'pi']),
      expect.any(Function),
    );
    expect(active.session.disposeCalls).toBe(1);

    input.focus();
    input.blur();
    await tab['textEdits'].flush();
    await Promise.all(transition.mock.results.map(result => result.value));
    expect(transition).toHaveBeenCalledTimes(1);
    expect(settings[key]).toBe(next);

    vi.useFakeTimers();
    fireEvent.input(input, { target: { value: `${next} timer` } });
    await vi.advanceTimersByTimeAsync(500);
    await tab['textEdits'].flush();
    expect(settings[key]).toBe(`${next} timer`);
    expect(transition).toHaveBeenCalledTimes(2);
    fireEvent.blur(input);
    await tab['textEdits'].flush();
    expect(transition).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
    await tab['textEdits'].flush();
    await execution.coordinator.dispose();
    await execution.registry.dispose();
  }
});

it('does not restart or replay a prompt edit after publication of its durable commit fails', async () => {
  let saved = '';
  const persist = vi.fn(async (draft: ClaudianSettings) => { saved = JSON.stringify(draft); });
  const execution = createHarness();
  const transition = vi.spyOn(execution.registry, 'runTransition');
  const { settings, host } = await createFeatureHostFixture({
    settings: { userName: 'Before', enableAutoTitleGeneration: false },
    beforePersist: persist, afterPublish: () => { throw new Error('View unavailable'); },
    providerOverrides: { runProviderExecutionTransition: execution.registry.runTransition.bind(execution.registry) },
  });
  const tab = new ClaudianSettingTab(host.app, createObsidianPlugin(host.app), host);
  const container = document.body.createDiv();
  tab['renderGeneralTab'](container);
  const input = within(container).getByRole('textbox', { name: t('settings.userName.name') });
  try {
    fireEvent.input(input, { target: { value: 'After' } });
    fireEvent.blur(input);
    await waitFor(() => expect(Notice).toHaveBeenCalledWith('Failed to save settings'));
    expect(await tab['textEdits'].flush()).toBe(false);
    expect(settings.userName).toBe('After');
    expect(JSON.parse(saved).userName).toBe('After');
    expect(transition).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(await tab['textEdits'].flush()).toBe(false);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(transition).not.toHaveBeenCalled();
  } finally { await execution.coordinator.dispose(); await execution.registry.dispose(); }
});
