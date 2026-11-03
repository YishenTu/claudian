import { SettingsCoordinator, SettingsPostCommitError } from '@/app/settings/SettingsCoordinator';
import { DebouncedSettingsWriter } from '@/shared/settings/DebouncedSettingsWriter';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('commits the last draft of each field together without overwriting unrelated settings', async () => {
  const settings = { text: '', other: false };
  const persist = vi.fn().mockResolvedValue(undefined);
  const coordinator = new SettingsCoordinator(settings, persist);
  const writer = new DebouncedSettingsWriter(coordinator.mutate.bind(coordinator), vi.fn());
  for (let index = 0; index < 20; index++) writer.schedule('text', draft => { draft.text = String(index); });
  await coordinator.mutate(draft => { draft.other = true; });
  await writer.flush();
  expect(settings).toEqual({ text: '19', other: true });
  expect(persist).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1000);
  expect(persist).toHaveBeenCalledTimes(2);
});

it('keeps rollback and post-commit publication semantics owned by the coordinator', async () => {
  const settings = { text: 'old' };
  const error = vi.fn();
  const persist = vi.fn().mockRejectedValueOnce(new Error('disk')).mockResolvedValue(undefined);
  const publish = vi.fn().mockRejectedValueOnce(new Error('view'));
  const coordinator = new SettingsCoordinator(settings, persist, publish);
  const writer = new DebouncedSettingsWriter(coordinator.mutate.bind(coordinator), error);
  writer.schedule('text', draft => { draft.text = 'failed'; });
  expect(await writer.flush()).toBe(false);
  expect(settings.text).toBe('old');
  writer.schedule('text', draft => { draft.text = 'committed'; });
  expect(await writer.flush()).toBe(false);
  expect(settings.text).toBe('committed');
  expect(error.mock.calls[1][0]).toBeInstanceOf(SettingsPostCommitError);
});

it('retries a failed draft without requiring another text edit', async () => {
  const settings = { text: 'old' };
  const persist = vi.fn().mockRejectedValueOnce(new Error('disk')).mockResolvedValue(undefined);
  const coordinator = new SettingsCoordinator(settings, persist);
  const writer = new DebouncedSettingsWriter(coordinator.mutate.bind(coordinator), vi.fn());
  writer.schedule('text', draft => { draft.text = 'retained'; });
  expect(await writer.flush()).toBe(false);
  expect(settings.text).toBe('old');
  expect(await writer.flush()).toBe(true);
  expect(settings.text).toBe('retained');
  expect(persist).toHaveBeenCalledTimes(2);
});

it('saves a newer draft after an in-flight failure without later retrying stale text', async () => {
  const settings = { text: 'old', other: '' };
  let rejectWrite!: (error: Error) => void;
  let started!: () => void;
  const start = new Promise<void>(resolve => { started = resolve; });
  const writes: string[] = [];
  const coordinator = new SettingsCoordinator(settings, draft => {
    writes.push(draft.text);
    if (writes.length > 1) return Promise.resolve();
    started();
    return new Promise<void>((_resolve, reject) => { rejectWrite = reject; });
  });
  const writer = new DebouncedSettingsWriter(coordinator.mutate.bind(coordinator), vi.fn());
  writer.schedule('text', draft => { draft.text = 'stale'; });
  writer.schedule('other', draft => { draft.other = 'retained'; });
  const first = writer.flush();
  await start;
  writer.schedule('text', draft => { draft.text = 'latest'; });
  const next = writer.flush();
  rejectWrite(new Error('disk'));
  expect(await first).toBe(false);
  expect(await next).toBe(true);
  expect(await writer.flush()).toBe(true);
  expect(settings).toEqual({ text: 'latest', other: 'retained' });
  expect(writes).toEqual(['stale', 'latest']);
});

it('does not retry a durable mutation when only publication failed', async () => {
  const settings = { text: 'old' };
  const persist = vi.fn().mockResolvedValue(undefined);
  const coordinator = new SettingsCoordinator(settings, persist, () => { throw new Error('view'); });
  const writer = new DebouncedSettingsWriter(coordinator.mutate.bind(coordinator), vi.fn());
  writer.schedule('text', draft => { draft.text = 'durable'; });
  expect(await writer.flush()).toBe(false);
  expect(settings.text).toBe('durable');
  await writer.flush();
  expect(persist).toHaveBeenCalledTimes(1);
});
