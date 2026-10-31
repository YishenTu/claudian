/** @vitest-environment jsdom */

import '@/providers';

import { axe } from '@test/helpers/accessibility';
import { createHarness, FakeSession, requestedScope } from '@test/helpers/ChatExecutionHarness';
import { createFixture, deferred } from '@test/helpers/ChatInputHarness';
import { within } from '@testing-library/dom';
import type { App } from 'obsidian';
import type { Mock } from 'vitest';

import { ComposerContextTray } from '@/features/chat/composer/ComposerContextTray';
import { BrowserSelectionController } from '@/features/chat/input/BrowserSelectionController';
import { ComposerSelections } from '@/features/chat/input/ComposerSelections';

let visibility: HTMLStyleElement;
beforeEach(() => {
  visibility = document.head.appendChild(document.createElement('style'));
  visibility.textContent = '.claudian-hidden { display: none; }';
  const execute = FakeSession.prototype.execute;
  vi.spyOn(FakeSession.prototype, 'execute').mockImplementation(function (this: FakeSession, request) {
    const result = execute.call(this, request);
    const run = this.runs.at(-1)!;
    run.events.push({ type: 'turn_started', accepted: true, scope: requestedScope(this, run, 1) });
    run.events.push({ type: 'turn_completed', scope: requestedScope(this, run, 2), reason: 'completed' });
    run.events.end();
    return result;
  });
});
afterEach(() => { visibility.remove(); vi.restoreAllMocks(); document.body.replaceChildren(); });

it.each([
  'own composer', 'own composer unfocused', 'other browser', 'ordinary editor', 'other composer',
  'source closed', 'source replaced', 'source navigated', 'clear', 'stop',
] as const)('hands pending browser context to its own input only: %s', async action => {
  const source = document.body.createDiv();
  const webview = document.createElement('webview') as HTMLElement & { executeJavaScript: Mock };
  source.appendChild(webview);
  const read = deferred<string>();
  webview.executeJavaScript = vi.fn(() => read.promise);
  const sourceView = { containerEl: source, getViewType: () => 'surfing-view', getDisplayText: () => 'Source page', currentUrl: 'https://source.example/' };
  const sourceLeaf = { view: sourceView };
  const composer = document.body.createDiv();
  const input = composer.createEl('textarea', { attr: { 'aria-label': 'Message' } });
  const ownLeaf = { view: { containerEl: composer, getViewType: () => 'claudian-view' } };
  let activeLeaf: { view: { containerEl: HTMLElement; getViewType: () => string } } = sourceLeaf;
  let sourceOpen = true;
  const app = { workspace: {
    getMostRecentLeaf: () => activeLeaf,
    getLeavesOfType: (type: string) => type === 'surfing-view' && sourceOpen ? [sourceLeaf] : [],
  } } as unknown as App;
  const tray = new ComposerContextTray(composer.createDiv());
  const browser = new BrowserSelectionController(app, tray, input);
  const idle = { start() {}, stop() {}, poll() {}, clear() {}, getContext: () => null };
  const selections = new ComposerSelections({ browser, editor: idle, canvas: idle });
  const native = createHarness();
  const fixture = (await createFixture({ selections, getInputEl: () => input, getExecutionCoordinator: () => native.coordinator }));
  try {
    await native.coordinator.bindConversation({ conversationId: 'conversation-1', providerId: 'claude' });
    const pending = browser.poll();
    expect(webview.executeJavaScript).toHaveBeenCalledTimes(1);
    activeLeaf = ownLeaf;
    input.focus();
    if (action === 'own composer unfocused') input.blur();
    if (action === 'other browser') activeLeaf = { view: { containerEl: document.body.createDiv(), getViewType: () => 'browser-view' } };
    if (action === 'ordinary editor') activeLeaf = { view: { containerEl: document.body.createDiv(), getViewType: () => 'markdown' } };
    if (action === 'other composer') {
      const otherComposer = document.body.createDiv();
      otherComposer.createEl('textarea').focus();
      activeLeaf = { view: { containerEl: otherComposer, getViewType: () => 'claudian-view' } };
    }
    if (action === 'source closed') { sourceOpen = false; source.remove(); }
    if (action === 'source replaced') sourceView.containerEl = document.body.createDiv();
    if (action === 'source navigated') sourceView.currentUrl = 'https://changed.example/';
    if (action === 'clear') browser.clear();
    if (action === 'stop') selections.stop();
    read.resolve('Selected source text');
    await pending;

    input.value = 'Explain this selection';
    await fixture.controller.sendMessage();
    const requests = native.backends.get('claude')!.sessions.flatMap(session => session.requests);
    expect(requests).toHaveLength(1);
    expect(requests[0].input).toEqual([{ type: 'text', text: 'Explain this selection' }]);
    expect(requests[0].context?.selections ?? []).toEqual(action === 'own composer' ? [{
      kind: 'browser', selection: {
        source: 'browser:https://source.example/', selectedText: 'Selected source text', title: 'Source page', url: 'https://source.example/',
      },
    }] : []);
    expect(within(composer).getByRole('textbox', { name: 'Message' })).toBe(input);
    expect(within(composer).queryAllByRole('button', { name: 'Remove 1 line selected' }))
      .toHaveLength(action === 'own composer' ? 1 : 0);
    expect(await axe(composer)).toHaveNoViolations();
  } finally {
    selections.stop(); tray.destroy();
    await native.coordinator.dispose(); await native.registry.dispose();
  }
});
