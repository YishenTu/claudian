/** @vitest-environment jsdom */
import { DesktopVault } from '@test/helpers/core/DesktopVault';
import { App, Component, ItemView, TFile, TFolder, WorkspaceLeaf } from 'obsidian';

class TestView extends ItemView {
  getViewType(): string { return 'test'; }
  getDisplayText(): string { return 'Test'; }
}

it('joins component child loading and releases host events, DOM listeners and intervals on unload', async () => {
  vi.useFakeTimers();
  onTestFinished(() => { vi.useRealTimers(); });
  const app = new App();
  const component = new Component();
  const calls: string[] = [];
  const child = component.addChild(new Component());
  let finish!: () => void;
  child.onload = () => new Promise<void>(resolve => { finish = resolve; });
  child.onunload = () => { calls.push('child'); };
  component.onunload = () => { calls.push('component'); };
  let loaded = false;
  const loading = Promise.resolve(component.load()).then(() => { loaded = true; });
  await Promise.resolve();
  expect(loaded).toBe(false);
  finish();
  await loading;

  const changed = vi.fn();
  const clicked = vi.fn();
  const ticked = vi.fn();
  const button = document.createElement('button');
  component.registerEvent(app.vault.on('modify', changed));
  component.registerDomEvent(button, 'click', clicked);
  component.registerInterval(window.setInterval(ticked, 10));
  component.register(() => { calls.push('cleanup'); });
  app.vault.trigger('modify');
  button.click();
  vi.advanceTimersByTime(10);
  expect(changed).toHaveBeenCalledTimes(1);
  expect(clicked).toHaveBeenCalledTimes(1);
  expect(ticked).toHaveBeenCalledTimes(1);
  component.unload();
  component.unload();
  app.vault.trigger('modify');
  button.click();
  vi.advanceTimersByTime(10);
  expect(changed).toHaveBeenCalledTimes(1);
  expect(clicked).toHaveBeenCalledTimes(1);
  expect(ticked).toHaveBeenCalledTimes(1);
  expect(calls).toEqual(['child', 'cleanup', 'component']);
});

it('starts ItemView child loading without returning a completion promise', async () => {
  const view = new TestView(new WorkspaceLeaf());
  let finish!: () => void;
  let childReady!: Promise<void>;
  let ready = false;
  view.addChild(new Component()).onload = () => {
    childReady = new Promise<void>(resolve => { finish = resolve; }).then(() => { ready = true; });
    return childReady;
  };
  const returned = view.load();
  expect(returned).toBeUndefined();
  expect(finish).toBeTypeOf('function');
  expect(ready).toBe(false);
  finish();
  await childReady;
  expect(ready).toBe(true);
  view.unload();
});

it('uses the same vault event and file-index model in desktop fixtures', async () => {
  const vault = await DesktopVault.create();
  onTestFinished(() => vault.dispose());
  const app = vault.app;
  const callback = vi.fn();
  const reference = app.vault.on('modify', callback);
  const metadataChanged = vi.fn();
  const metadataRef = app.metadataCache.on('changed', metadataChanged);
  app.metadataCache.trigger('changed', 'note.md');
  app.metadataCache.offref(metadataRef);
  app.metadataCache.trigger('changed', 'note.md');
  expect(metadataChanged.mock.calls).toEqual([['note.md']]);
  app.vault.trigger('modify', 'first');
  app.vault.offref(reference);
  app.vault.trigger('modify', 'second');
  app.vault.on('modify', callback);
  app.vault.off('modify', callback);
  app.vault.trigger('modify', 'third');
  expect(callback.mock.calls).toEqual([['first']]);
  expect(app.workspace.getActiveFile()).toBeNull();
  await vault.write('note.md', 'not yet indexed');
  expect(app.vault.getFiles()).toEqual([]);
  expect(app.vault.getMarkdownFiles()).toEqual([]);
  const note = Object.assign(new TFile(), { path: 'note.md', extension: 'md' });
  const image = Object.assign(new TFile(), { path: 'image.png', extension: 'png' });
  vi.spyOn(app.vault, 'getAllLoadedFiles').mockReturnValue([note, image, new TFolder()]);
  expect(app.vault.getFiles()).toEqual([note, image]);
  expect(app.vault.getMarkdownFiles()).toEqual([note]);
  expect(app.vault.getAbstractFileByPath('note.md')).toBe(note);
});
