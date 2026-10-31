/** @vitest-environment jsdom */
import { createObsidianWorkspace } from '@test/helpers/ObsidianWorkspace';
import { App } from 'obsidian';

it('runs ready callbacks immediately but drains startup callbacks one timer turn at a time', async () => {
  vi.useFakeTimers();
  onTestFinished(() => { vi.useRealTimers(); });
  const ready = new App().workspace;
  const immediate = vi.fn();
  ready.onLayoutReady(immediate);
  expect(ready.layoutReady).toBe(true);
  expect(immediate).toHaveBeenCalledTimes(1);

  const workspace = createObsidianWorkspace(document.body, { layoutReady: false });
  const calls: string[] = [];
  workspace.on('layout-ready', () => { calls.push('event'); });
  workspace.onLayoutReady(() => { calls.push('first'); });
  workspace.onLayoutReady(() => { calls.push('second'); });
  expect(calls).toEqual([]);
  workspace.trigger('layout-ready');
  workspace.onLayoutReady(() => { calls.push('after-ready'); });
  expect(calls).toEqual(['event', 'after-ready']);
  await vi.advanceTimersToNextTimerAsync();
  expect(calls).toEqual(['event', 'after-ready', 'first']);
  await vi.advanceTimersToNextTimerAsync();
  expect(calls).toEqual(['event', 'after-ready', 'first', 'second']);
  expect(workspace.layoutReady).toBe(true);
});

it('debounces layout saves and returns the pending save from run while preserving cancellation', async () => {
  vi.useFakeTimers();
  onTestFinished(() => { vi.useRealTimers(); });
  const workspace = createObsidianWorkspace(document.body);
  workspace.requestSaveLayout();
  vi.advanceTimersByTime(800);
  workspace.requestSaveLayout();
  vi.advanceTimersByTime(199);
  expect(workspace.saveLayout).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(workspace.saveLayout).toHaveBeenCalledTimes(1);
  expect(workspace.requestSaveLayout.run()).toBeUndefined();
  expect(workspace.saveLayout).toHaveBeenCalledTimes(1);
  let release!: () => void;
  const heldSave = new Promise<void>(resolve => { release = resolve; });
  workspace.saveLayout.mockImplementationOnce(() => heldSave);
  workspace.requestSaveLayout();
  const saving = workspace.requestSaveLayout.run();
  try {
    expect(workspace.saveLayout).toHaveBeenCalledTimes(2);
    expect(saving).toBe(heldSave);
    let completed = false;
    const completion = Promise.resolve(saving).then(() => { completed = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(completed).toBe(false);
    release();
    await completion;
    expect(completed).toBe(true);
  } finally { release(); }
  workspace.requestSaveLayout();
  workspace.requestSaveLayout.cancel();
  vi.advanceTimersByTime(1000);
  expect(workspace.saveLayout).toHaveBeenCalledTimes(2);
});
