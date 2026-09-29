import { SettingsCoordinator, SettingsPostCommitError } from '@/app/settings/SettingsCoordinator';
import { DebouncedSettingsWriter } from '@/shared/settings/DebouncedSettingsWriter';

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

it('commits the last draft of each field together without overwriting unrelated settings', async () => {
  const settings = { text: '', other: false };
  const persist = jest.fn().mockResolvedValue(undefined);
  const coordinator = new SettingsCoordinator(settings, persist);
  const writer = new DebouncedSettingsWriter(coordinator.mutate.bind(coordinator), jest.fn());
  for (let index = 0; index < 20; index++) writer.schedule('text', draft => { draft.text = String(index); });
  await coordinator.mutate(draft => { draft.other = true; });
  await writer.flush();
  expect(settings).toEqual({ text: '19', other: true });
  expect(persist).toHaveBeenCalledTimes(2);
  await jest.advanceTimersByTimeAsync(1000);
  expect(persist).toHaveBeenCalledTimes(2);
});

it('keeps rollback and post-commit publication semantics owned by the coordinator', async () => {
  const settings = { text: 'old' };
  const error = jest.fn();
  const persist = jest.fn().mockRejectedValueOnce(new Error('disk')).mockResolvedValue(undefined);
  const publish = jest.fn().mockRejectedValueOnce(new Error('view'));
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
