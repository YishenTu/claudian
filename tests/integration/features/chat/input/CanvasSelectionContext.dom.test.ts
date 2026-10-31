/** @vitest-environment jsdom */

import '@/providers';

import { axe } from '@test/helpers/accessibility';
import { createHarness, FakeSession, requestedScope } from '@test/helpers/ChatExecutionHarness';
import { createFixture } from '@test/helpers/ChatInputHarness';
import { within } from '@testing-library/dom';
import type { App } from 'obsidian';

import { ComposerContextTray } from '@/features/chat/composer/ComposerContextTray';
import { CanvasSelectionController } from '@/features/chat/input/CanvasSelectionController';
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
  'active canvas', 'own composer', 'background canvas', 'ordinary editor', 'source closed', 'source navigated',
  'own composer unfocused', 'other composer', 'other canvas',
] as const)('attaches only the selected canvas source: %s', async action => {
  const sourceView = { containerEl: document.body.createDiv(), getViewType: () => 'canvas',
    file: { path: 'Selected.canvas' }, canvas: { selection: new Set([{ id: 'chosen-node' }]) } };
  const sourceLeaf = { view: sourceView };
  const composer = document.body.createDiv();
  const input = composer.createEl('textarea', { attr: { 'aria-label': 'Message' } });
  const ownLeaf = { view: { containerEl: composer, getViewType: () => 'claudian-view' } };
  const editorLeaf = { view: { containerEl: document.body.createDiv(), getViewType: () => 'markdown' } };
  let activeLeaf: { view: { containerEl: HTMLElement; getViewType(): string } } = action === 'background canvas' ? editorLeaf : sourceLeaf;
  let sourceOpen = true;
  const app = { workspace: { getMostRecentLeaf: () => activeLeaf,
    getLeavesOfType: () => sourceOpen ? [sourceLeaf] : [] } } as unknown as App;
  const tray = new ComposerContextTray(composer.createDiv());
  const canvas = new CanvasSelectionController(app, tray, input);
  const idle = { start() {}, stop() {}, async poll() {}, clear() {}, getContext: () => null };
  const selections = new ComposerSelections({ canvas, editor: idle, browser: idle });
  const native = createHarness();
  const fixture = (await createFixture({ selections, getInputEl: () => input, getExecutionCoordinator: () => native.coordinator }));
  try {
    await native.coordinator.bindConversation({ conversationId: 'conversation-1', providerId: 'claude' });
    canvas.poll();
    if (action === 'ordinary editor') activeLeaf = editorLeaf;
    if (['own composer', 'source closed', 'source navigated', 'own composer unfocused', 'other composer'].includes(action)) {
      activeLeaf = ownLeaf;
      input.focus();
      sourceView.canvas.selection.clear();
    }
    if (action === 'own composer unfocused') input.blur();
    if (action === 'other composer') activeLeaf = { view: { containerEl: document.body.createDiv(), getViewType: () => 'claudian-view' } };
    if (action === 'other canvas') activeLeaf = { view: { containerEl: document.body.createDiv(), getViewType: () => 'canvas', file: { path: 'Empty.canvas' }, canvas: { selection: new Set() } } } as typeof sourceLeaf;
    if (action === 'source closed') sourceOpen = false;
    if (action === 'source navigated') sourceView.file.path = 'Other.canvas';
    canvas.poll();

    input.value = 'Explain these nodes';
    await fixture.controller.sendMessage();
    const requests = native.backends.get('claude')!.sessions.flatMap(session => session.requests);
    expect(requests).toHaveLength(1);
    const attached = action === 'active canvas' || action === 'own composer';
    expect(requests[0].context?.selections ?? []).toEqual(attached ? [{
      kind: 'canvas', selection: { canvasPath: 'Selected.canvas', nodeIds: ['chosen-node'] },
    }] : []);
    expect(within(composer).queryAllByRole('button', { name: 'Remove 1 node selected' })).toHaveLength(attached ? 1 : 0);
    expect(await axe(composer)).toHaveNoViolations();
  } finally {
    selections.stop(); tray.destroy();
    await native.coordinator.dispose(); await native.registry.dispose();
  }
});
