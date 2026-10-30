/** @vitest-environment jsdom */
import { createPopoutDocument } from '@test/helpers/dom/popoutDocument';
import { setObsidianActiveDocument } from '@test/helpers/ObsidianHost';
import { resetObsidianKeymaps } from '@test/helpers/ObsidianKeymap';
import { App, type KeymapContext, Modal, Scope } from 'obsidian';

afterEach(() => { setObsidianActiveDocument(); document.body.replaceChildren(); });

function inputIn(doc: Document = document): HTMLInputElement {
  const input = doc.createElement('input');
  doc.body.append(input);
  return input;
}

it('routes the original event in capture to the top scope and removes scopes in host stack order', () => {
  const app = new App();
  const input = inputIn();
  const calls: Array<[string, KeyboardEvent]> = [];
  const lower = new Scope();
  const upper = new Scope();
  lower.register([], 'Escape', event => { calls.push(['lower', event]); });
  upper.register([], 'Escape', event => { calls.push(['upper', event]); return false; });
  input.addEventListener('keydown', event => { calls.push(['target', event]); });
  const dispatch = () => {
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    input.dispatchEvent(event);
    return event;
  };
  app.keymap.pushScope(lower);
  app.keymap.pushScope(upper);
  const consumed = dispatch();
  expect(calls).toEqual([['upper', consumed]]);
  expect(consumed.defaultPrevented).toBe(true);
  app.keymap.popScope(upper);
  const passed = dispatch();
  expect(calls.slice(1)).toEqual([['lower', passed], ['target', passed]]);
  expect(passed.defaultPrevented).toBe(false);
  // Re-pushing the active scope is a no-op. Removing a buried scope must not reactivate it later.
  app.keymap.pushScope(lower);
  app.keymap.pushScope(upper);
  app.keymap.popScope(lower);
  app.keymap.popScope(upper);
  const popped = dispatch();
  expect(calls.slice(3)).toEqual([['target', popped]]);
});

it('matches modifiers and parent scopes, while a matched undefined result reaches the DOM target', () => {
  const app = new App();
  const input = inputIn();
  const parent = new Scope();
  const child = new Scope(parent);
  const parentCalls = vi.fn((_event: KeyboardEvent, _context: KeymapContext) => false);
  parent.register(['Mod'], 'k', parentCalls);
  const observer = vi.fn();
  child.register(null, null, observer);
  const target = vi.fn();
  input.addEventListener('keydown', target);
  app.keymap.pushScope(child);
  const matching = new KeyboardEvent('keydown', { key: 'K', metaKey: true, bubbles: true, cancelable: true });
  input.dispatchEvent(matching);
  expect(observer.mock.calls[0][0]).toBe(matching);
  expect(parentCalls.mock.calls[0][0]).toBe(matching);
  expect(parentCalls.mock.calls[0][1]).toMatchObject({ modifiers: 'Meta', key: 'K' });
  expect(target).not.toHaveBeenCalled();
  const wrongModifiers = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true });
  input.dispatchEvent(wrongModifiers);
  expect(parentCalls).toHaveBeenCalledOnce();
  expect(target).toHaveBeenCalledOnce();
  const specific = vi.fn();
  child.register(['Mod'], 'k', specific);
  const unconsumed = new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true });
  input.dispatchEvent(unconsumed);
  expect(specific.mock.calls[0][0]).toBe(unconsumed);
  expect(parentCalls).toHaveBeenCalledOnce();
  expect(target).toHaveBeenCalledTimes(2);
  expect(unconsumed.defaultPrevented).toBe(false);
});

it('keeps modal Escape undefined so the same event reaches its detached input, including a popout', () => {
  const app = new App();
  const popout = createPopoutDocument();
  setObsidianActiveDocument(popout);
  const modal = new Modal(app);
  const input = popout.createElement('input');
  modal.contentEl.append(input);
  const close = vi.spyOn(modal, 'onClose');
  const target = vi.fn();
  input.addEventListener('keydown', target);
  modal.open();
  const mainEvent = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  document.body.dispatchEvent(mainEvent);
  expect(close).not.toHaveBeenCalled();
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  input.dispatchEvent(event);
  expect(close).toHaveBeenCalledOnce();
  expect(input.isConnected).toBe(false);
  expect(event.defaultPrevented).toBe(true);
  expect(target).toHaveBeenCalledOnce();
  expect(target.mock.calls[0][0]).toBe(event);
  popout.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  expect(close).toHaveBeenCalledOnce();
});

it('unregisters popout capture and releases every App listener during shared test cleanup', async () => {
  const { App: HostApp, Scope: HostScope } = await vi.importActual<typeof import('../../__mocks__/obsidian')>('obsidian');
  const app = new HostApp();
  const popout = createPopoutDocument();
  const input = inputIn(popout);
  const rootHandler = vi.fn(() => false);
  const popoutHandler = vi.fn(() => false);
  app.keymap.getRootScope().register([], 'Escape', rootHandler);
  const popoutScope = new HostScope();
  popoutScope.register([], 'Escape', popoutHandler);
  const unregister = app.keymap.registerWindow(popout.defaultView!);
  setObsidianActiveDocument(popout);
  app.keymap.pushScope(popoutScope);
  const press = (target: HTMLElement) => {
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  };
  expect(press(input).defaultPrevented).toBe(true);
  expect(popoutHandler).toHaveBeenCalledOnce();
  unregister();
  expect(press(input).defaultPrevented).toBe(false);
  expect(popoutHandler).toHaveBeenCalledOnce();
  app.keymap.registerWindow(popout.defaultView!);
  expect(press(input).defaultPrevented).toBe(true);
  expect(popoutHandler).toHaveBeenCalledTimes(2);
  expect(rootHandler).not.toHaveBeenCalled();
  resetObsidianKeymaps();
  expect(press(input).defaultPrevented).toBe(false);
  expect(press(inputIn()).defaultPrevented).toBe(false);
  expect(rootHandler).not.toHaveBeenCalled();
  // Reacquire a live listener, then verify setup's afterEach actually calls the shared cleanup.
  app.keymap.registerWindow(window);
  onTestFinished(() => {
    const nextTarget = inputIn();
    expect(press(nextTarget).defaultPrevented).toBe(false);
    expect(rootHandler).not.toHaveBeenCalled();
    nextTarget.remove();
  });
});
