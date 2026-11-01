// @test-ci {"native":true}
const actualModule0 = await vi.importActual<typeof fs>('node:fs/promises');
const actualModule1 = await vi.importActual<typeof fs>('node:fs/promises');
import '@/providers';

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { DesktopVault } from '@test/helpers/core/DesktopVault';
import { DEFAULT_CLAUDIAN_SETTINGS } from '@test/helpers/defaultSettings';
import { testDate } from '@test/helpers/testClock';

import { ClaudianSettingsStorage } from '@/app/settings/ClaudianSettingsStorage';
import { SettingsCoordinator, SettingsPostCommitError } from '@/app/settings/SettingsCoordinator';
import { ConversationPersistenceStore } from '@/app/storage/ConversationPersistenceStore';
import { CLAUDIAN_SETTINGS_PATH, getDeviceSessionsPath } from '@/core/bootstrap/storagePaths';
import type { SessionMetadata } from '@/core/types';


vi.mock('node:fs/promises', async () => {
  const actual = (await vi.importActual<typeof fs>('node:fs/promises'));
  return { ...actual, chmod: vi.fn(actual.chmod), rename: vi.fn(actual.rename), writeFile: vi.fn(actual.writeFile) };
});

const DEVICE_KEY = `device-${'a'.repeat(64)}`;
let vault: DesktopVault;
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;

beforeEach(async () => { vault = await DesktopVault.create(); });
afterEach(async () => {
  vi.mocked(fs.writeFile).mockReset().mockImplementation(actualModule0.writeFile);
  vi.mocked(fs.rename).mockReset().mockImplementation(actualModule0.rename);
  vi.mocked(fs.chmod).mockReset().mockImplementation(actualModule0.chmod);
  Object.defineProperty(process, 'platform', platformDescriptor);
  vi.useRealTimers();
  await vault.dispose();
});

function failPartialWrite(): void {
  vi.mocked(fs.writeFile).mockImplementationOnce(async file => {
    await actualModule1.writeFile(file, '{"trunca');
    throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  });
}

function observeReplacement(target: string, errors: Error[], windowsPolicy = true) {
  if (windowsPolicy && process.platform !== 'win32') Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const timeouts = Array.from({ length: 5 }, () => {
    let resolve!: (delay: number) => void;
    const promise = new Promise<number>(ready => { resolve = ready; });
    return { promise, resolve };
  });
  const delays: number[] = [];
  const fakeTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation((...args) => {
    const timer = Reflect.apply(fakeTimeout, globalThis, args);
    delays.push(args[1] ?? 0);
    timeouts[delays.length - 1]?.resolve(args[1] ?? 0);
    return timer;
  });
  const attempts: Array<{ from: string; to: string; staged: string; committed: string }> = [];
  vi.mocked(fs.rename).mockImplementation(async (from, to) => {
    if (String(to) !== target) return actualModule0.rename(from, to);
    attempts.push({ from: String(from), to: String(to),
      staged: await actualModule0.readFile(from, 'utf8'), committed: await actualModule0.readFile(to, 'utf8') });
    const error = errors[attempts.length - 1];
    if (error) throw error;
    return actualModule0.rename(from, to);
  });
  return { attempts, delays, timeouts };
}

function handled<T>(operation: Promise<T>) {
  return operation.then(value => ({ value }), error => ({ error }));
}

async function finishReplacement(outcome: Promise<unknown>): Promise<void> {
  vi.mocked(fs.rename).mockImplementation(actualModule0.rename);
  vi.mocked(fs.chmod).mockImplementation(actualModule0.chmod);
  try {
    await vi.runAllTimersAsync();
    await outcome;
  } finally {
    vi.restoreAllMocks();
    vi.useRealTimers();
    Object.defineProperty(process, 'platform', platformDescriptor);
  }
}

it.each([['EPERM', 4], ['EACCES', 1], ['EBUSY', 1]] as const)(
  'commits settings after transient Windows %s refusals (%s denials)', async (code, denials) => {
    const storage = new ClaudianSettingsStorage(vault.files, DEFAULT_CLAUDIAN_SETTINGS);
    const settings = { ...structuredClone(DEFAULT_CLAUDIAN_SETTINGS), userName: 'Committed' };
    await storage.save(settings);
    const committed = await vault.read(CLAUDIAN_SETTINGS_PATH);
    const expected = committed.replace('"userName": "Committed"', '"userName": "Updated"');
    const publish = vi.fn();
    const coordinator = new SettingsCoordinator(settings, draft => storage.save(draft), publish);
    vi.mocked(fs.writeFile).mockClear();
    const target = vault.resolve(CLAUDIAN_SETTINGS_PATH);
    const probe = observeReplacement(target, Array.from({ length: denials }, () => Object.assign(new Error('in use'), { code })));
    const outcome = handled(coordinator.mutate(draft => { draft.userName = 'Updated'; }));
    try {
      for (const [index, delay] of [20, 40, 60, 80].slice(0, denials).entries()) {
        const next = await Promise.race([probe.timeouts[index].promise.then(delay => ({ delay })), outcome]);
        expect(next).toEqual({ delay });
        expect(settings.userName).toBe('Committed');
        expect(coordinator.getCommittedSettings().userName).toBe('Committed');
        expect(publish).not.toHaveBeenCalled();
        expect(await vault.read(CLAUDIAN_SETTINGS_PATH)).toBe(committed);
        expect(await actualModule0.readFile(probe.attempts[0].from, 'utf8')).toBe(expected);
        await vi.advanceTimersByTimeAsync(delay);
      }
      expect(await outcome).toEqual({ value: undefined });
      expect(probe.delays).toEqual([20, 40, 60, 80].slice(0, denials));
      expect(probe.attempts).toHaveLength(denials + 1);
      expect(probe.attempts).toEqual(Array.from({ length: denials + 1 }, () => ({
        from: probe.attempts[0].from, to: target, staged: expected, committed,
      })));
      expect(path.dirname(probe.attempts[0].from)).toBe(path.dirname(target));
      expect(path.basename(probe.attempts[0].from)).toMatch(/^\.claudian-.*\.tmp$/);
      expect(fs.writeFile).toHaveBeenCalledTimes(1);
      expect(settings.userName).toBe('Updated');
      expect(publish).toHaveBeenCalledTimes(1);
      expect(await vault.read(CLAUDIAN_SETTINGS_PATH)).toBe(expected);
    } finally {
      await finishReplacement(outcome);
    }
    expect(await new ClaudianSettingsStorage(vault.files, DEFAULT_CLAUDIAN_SETTINGS).load()).toMatchObject({ userName: 'Updated' });
    expect(await fs.readdir(path.dirname(target))).not.toEqual(expect.arrayContaining([expect.stringMatching(/\.tmp$/)]));
  },
);

it('exhausts Windows replacement retries without publishing and propagates the last refusal', async () => {
  const storage = new ClaudianSettingsStorage(vault.files, DEFAULT_CLAUDIAN_SETTINGS);
  const settings = { ...structuredClone(DEFAULT_CLAUDIAN_SETTINGS), userName: 'Committed' };
  await storage.save(settings);
  const committed = await vault.read(CLAUDIAN_SETTINGS_PATH);
  const expected = committed.replace('"userName": "Committed"', '"userName": "Updated"');
  const target = vault.resolve(CLAUDIAN_SETTINGS_PATH);
  const publish = vi.fn();
  const coordinator = new SettingsCoordinator(settings, draft => storage.save(draft), publish);
  const errors = ['EPERM', 'EBUSY', 'EACCES', 'EPERM', 'EBUSY'].map((code, index) => Object.assign(new Error(`locked-${index}`), { code }));
  const probe = observeReplacement(target, errors);
  const outcome = handled(coordinator.mutate(draft => { draft.userName = 'Updated'; }));
  try {
    for (const [index, delay] of [20, 40, 60, 80].entries()) {
      expect(await Promise.race([probe.timeouts[index].promise.then(delay => ({ delay })), outcome])).toEqual({ delay });
      expect(settings.userName).toBe('Committed');
      expect(publish).not.toHaveBeenCalled();
      expect(await vault.read(CLAUDIAN_SETTINGS_PATH)).toBe(committed);
      await vi.advanceTimersByTimeAsync(delay);
    }
    const result = await Promise.race([outcome, probe.timeouts[4].promise.then(delay => ({ delay }))]);
    expect('error' in result ? result.error : undefined).toBe(errors[4]);
    expect(probe.delays).toEqual([20, 40, 60, 80]);
    expect(probe.attempts).toEqual(Array.from({ length: 5 }, () => ({
      from: probe.attempts[0].from, to: target, staged: expected, committed,
    })));
    expect(settings.userName).toBe('Committed');
    expect(publish).not.toHaveBeenCalled();
    expect(await vault.read(CLAUDIAN_SETTINGS_PATH)).toBe(committed);
    expect(await fs.readdir(path.dirname(target))).not.toEqual(expect.arrayContaining([expect.stringMatching(/\.tmp$/)]));
  } finally {
    await finishReplacement(outcome);
  }
  expect(await new ClaudianSettingsStorage(vault.files, DEFAULT_CLAUDIAN_SETTINGS).load()).toMatchObject({ userName: 'Committed' });
});

it.each(['ENOSPC', 'ENOENT'])('does not retry nontransient Windows replacement failure %s', async code => {
  const storage = new ClaudianSettingsStorage(vault.files, DEFAULT_CLAUDIAN_SETTINGS);
  const settings = { ...structuredClone(DEFAULT_CLAUDIAN_SETTINGS), userName: 'Committed' };
  await storage.save(settings);
  const committed = await vault.read(CLAUDIAN_SETTINGS_PATH);
  const target = vault.resolve(CLAUDIAN_SETTINGS_PATH);
  const publish = vi.fn();
  const coordinator = new SettingsCoordinator(settings, draft => storage.save(draft), publish);
  const error = Object.assign(new Error('terminal replacement failure'), { code });
  const probe = observeReplacement(target, [error]);
  const outcome = handled(coordinator.mutate(draft => { draft.userName = 'Updated'; }));
  try {
    expect(await Promise.race([outcome, probe.timeouts[0].promise.then(delay => ({ delay }))])).toEqual({ error });
    expect(probe.delays).toEqual([]);
    expect(probe.attempts).toHaveLength(1);
    expect(settings.userName).toBe('Committed');
    expect(publish).not.toHaveBeenCalled();
    expect(await vault.read(CLAUDIAN_SETTINGS_PATH)).toBe(committed);
    expect(await fs.readdir(path.dirname(target))).not.toEqual(expect.arrayContaining([expect.stringMatching(/\.tmp$/)]));
  } finally {
    await finishReplacement(outcome);
  }
});

it('recovers a transient metadata replacement through serialization and independent reload', async () => {
  const store = new ConversationPersistenceStore(vault.files, DEVICE_KEY);
  const metadata: SessionMetadata = {
    id: 'conversation-retry', providerId: 'claude', title: 'Committed',
    createdAt: testDate().getTime(), lastActivityAt: testDate().getTime(),
  };
  await store.saveMetadata(metadata);
  const file = `${getDeviceSessionsPath(DEVICE_KEY)}/${metadata.id}.meta.json`;
  const target = vault.resolve(file);
  const committed = await vault.read(file);
  const updated = { ...metadata, title: 'Updated' };
  const expected = JSON.stringify(updated);
  const probe = observeReplacement(target, [Object.assign(new Error('metadata busy'), { code: 'EBUSY' })]);
  const outcome = handled(store.saveMetadata(updated));
  try {
    expect(await Promise.race([probe.timeouts[0].promise.then(delay => ({ delay })), outcome])).toEqual({ delay: 20 });
    expect(await vault.read(file)).toBe(committed);
    expect(await actualModule0.readFile(probe.attempts[0].from, 'utf8')).toBe(expected);
    await vi.advanceTimersByTimeAsync(20);
    expect(await outcome).toEqual({ value: undefined });
    expect(probe.attempts).toEqual(Array.from({ length: 2 }, () => ({ from: probe.attempts[0].from, to: target, staged: expected, committed })));
    expect(await vault.read(file)).toBe(expected);
    expect(await fs.readdir(path.dirname(target))).not.toEqual(expect.arrayContaining([expect.stringMatching(/\.tmp$/)]));
  } finally {
    await finishReplacement(outcome);
  }
  expect(await new ConversationPersistenceStore(vault.files, DEVICE_KEY).metadataReader.loadMetadata(metadata.id)).toEqual(updated);
});

it('does not repeat a durable replacement after post-commit publication fails', async () => {
  const storage = new ClaudianSettingsStorage(vault.files, DEFAULT_CLAUDIAN_SETTINGS);
  const settings = { ...structuredClone(DEFAULT_CLAUDIAN_SETTINGS), userName: 'Committed' };
  await storage.save(settings);
  const committed = await vault.read(CLAUDIAN_SETTINGS_PATH);
  const publishError = new Error('publish failed');
  const coordinator = new SettingsCoordinator(settings, draft => storage.save(draft), () => { throw publishError; });
  const target = vault.resolve(CLAUDIAN_SETTINGS_PATH);
  const probe = observeReplacement(target, []);
  const outcome = handled(coordinator.mutate(draft => { draft.userName = 'Updated'; }));
  try {
    expect(await outcome).toEqual({ error: expect.any(SettingsPostCommitError) });
    expect(await outcome).toMatchObject({ error: { committed: true, cause: publishError } });
    expect(probe.attempts).toHaveLength(1);
    expect(probe.delays).toEqual([]);
    expect(settings.userName).toBe('Updated');
    expect(await vault.read(CLAUDIAN_SETTINGS_PATH)).toBe(committed.replace('"userName": "Committed"', '"userName": "Updated"'));
  } finally {
    await finishReplacement(outcome);
  }
  expect(await new ClaudianSettingsStorage(vault.files, DEFAULT_CLAUDIAN_SETTINGS).load()).toMatchObject({ userName: 'Updated' });
});

it('keeps committed settings reloadable when a transactional save writes only a prefix', async () => {
  const storage = new ClaudianSettingsStorage(vault.files, DEFAULT_CLAUDIAN_SETTINGS);
  const settings = { ...structuredClone(DEFAULT_CLAUDIAN_SETTINGS), userName: 'Committed' };
  await storage.save(settings);
  const committed = await vault.read(CLAUDIAN_SETTINGS_PATH);
  const coordinator = new SettingsCoordinator(settings, draft => storage.save(draft));

  vi.mocked(fs.rename).mockClear();
  failPartialWrite();
  await expect(coordinator.mutate(draft => { draft.userName = 'Uncommitted'; })).rejects.toThrow('disk full');

  expect(fs.rename).not.toHaveBeenCalled();
  expect(settings.userName).toBe('Committed');
  expect(await new ClaudianSettingsStorage(vault.files, DEFAULT_CLAUDIAN_SETTINGS).load())
    .toMatchObject({ userName: 'Committed' });
  expect(await vault.read(CLAUDIAN_SETTINGS_PATH)).toBe(committed);
  expect(await fs.readdir(path.dirname(vault.resolve(CLAUDIAN_SETTINGS_PATH))))
    .not.toEqual(expect.arrayContaining([expect.stringMatching(/\.tmp$/)]));
});

it('keeps committed conversation metadata available after a torn save', async () => {
  const store = new ConversationPersistenceStore(vault.files, DEVICE_KEY);
  const metadata: SessionMetadata = {
    id: 'conversation-durable', providerId: 'claude', title: 'Committed',
    createdAt: testDate().getTime(), lastActivityAt: testDate().getTime(),
  };
  await store.saveMetadata(metadata);
  const file = `${getDeviceSessionsPath(DEVICE_KEY)}/${metadata.id}.meta.json`;
  const committed = await vault.read(file);
  expect(await store.metadataReader.loadMetadata(metadata.id)).toEqual(metadata);

  failPartialWrite();
  await expect(store.saveMetadata({ ...metadata, title: 'Uncommitted' })).rejects.toThrow('disk full');

  const reopened = new ConversationPersistenceStore(vault.files, DEVICE_KEY);
  expect(await reopened.metadataReader.loadMetadata(metadata.id)).toEqual(metadata);
  expect(await vault.read(file)).toBe(committed);
  expect(await fs.readdir(path.dirname(vault.resolve(file))))
    .not.toEqual(expect.arrayContaining([expect.stringMatching(/\.tmp$/)]));
});

const describePosix = process.platform === 'win32' ? describe.skip : describe;
describePosix('ordinary-file compatibility on POSIX', () => {
  it('preserves restrictive modes when replacing committed settings', async () => {
    const storage = new ClaudianSettingsStorage(vault.files, DEFAULT_CLAUDIAN_SETTINGS);
    await storage.save(structuredClone(DEFAULT_CLAUDIAN_SETTINGS));
    await fs.chmod(vault.resolve(CLAUDIAN_SETTINGS_PATH), 0o600);

    await storage.save({ ...structuredClone(DEFAULT_CLAUDIAN_SETTINGS), userName: 'Updated' });

    expect((await fs.stat(vault.resolve(CLAUDIAN_SETTINGS_PATH))).mode & 0o777).toBe(0o600);
    expect(await storage.load()).toMatchObject({ userName: 'Updated' });
  });

  it('does not reach replacement or retry after a staged chmod failure', async () => {
    const storage = new ClaudianSettingsStorage(vault.files, DEFAULT_CLAUDIAN_SETTINGS);
    const settings = { ...structuredClone(DEFAULT_CLAUDIAN_SETTINGS), userName: 'Committed' };
    await storage.save(settings);
    const target = vault.resolve(CLAUDIAN_SETTINGS_PATH);
    await actualModule0.chmod(target, 0o600);
    const committed = await vault.read(CLAUDIAN_SETTINGS_PATH);
    const error = Object.assign(new Error('stage chmod denied'), { code: 'EACCES' });
    const probe = observeReplacement(target, []);
    vi.mocked(fs.chmod).mockImplementation(async (file, mode) => {
      if (path.dirname(String(file)) === path.dirname(target) && path.basename(String(file)).startsWith('.claudian-')) throw error;
      return actualModule0.chmod(file, mode);
    });
    const outcome = handled(storage.save({ ...settings, userName: 'Updated' }));
    try {
      expect(await Promise.race([outcome, probe.timeouts[0].promise.then(delay => ({ delay }))])).toEqual({ error });
      expect(probe.attempts).toEqual([]);
      expect(probe.delays).toEqual([]);
      expect(await vault.read(CLAUDIAN_SETTINGS_PATH)).toBe(committed);
      expect((await actualModule0.stat(target)).mode & 0o777).toBe(0o600);
      expect(await fs.readdir(path.dirname(target))).not.toEqual(expect.arrayContaining([expect.stringMatching(/\.tmp$/)]));
    } finally {
      await finishReplacement(outcome);
    }
  });

  it('keeps actual non-Windows transient replacement failures immediate', async () => {
    const storage = new ClaudianSettingsStorage(vault.files, DEFAULT_CLAUDIAN_SETTINGS);
    const settings = { ...structuredClone(DEFAULT_CLAUDIAN_SETTINGS), userName: 'Committed' };
    await storage.save(settings);
    const target = vault.resolve(CLAUDIAN_SETTINGS_PATH);
    const committed = await vault.read(CLAUDIAN_SETTINGS_PATH);
    const error = Object.assign(new Error('non-Windows refusal'), { code: 'EPERM' });
    const publish = vi.fn();
    const coordinator = new SettingsCoordinator(settings, draft => storage.save(draft), publish);
    const probe = observeReplacement(target, [error], false);
    const outcome = handled(coordinator.mutate(draft => { draft.userName = 'Updated'; }));
    try {
      expect(await Promise.race([outcome, probe.timeouts[0].promise.then(delay => ({ delay }))])).toEqual({ error });
      expect(probe.attempts).toHaveLength(1);
      expect(probe.delays).toEqual([]);
      expect(settings.userName).toBe('Committed');
      expect(publish).not.toHaveBeenCalled();
      expect(await vault.read(CLAUDIAN_SETTINGS_PATH)).toBe(committed);
      expect(await fs.readdir(path.dirname(target))).not.toEqual(expect.arrayContaining([expect.stringMatching(/\.tmp$/)]));
    } finally {
      await finishReplacement(outcome);
    }
  });

  it('preserves existing group permissions under a stricter creation umask', async () => {
    const storage = new ClaudianSettingsStorage(vault.files, DEFAULT_CLAUDIAN_SETTINGS);
    await storage.save(structuredClone(DEFAULT_CLAUDIAN_SETTINGS));
    await fs.chmod(vault.resolve(CLAUDIAN_SETTINGS_PATH), 0o660);
    const previousMask = process.umask(0o077);
    try {
      await storage.save({ ...structuredClone(DEFAULT_CLAUDIAN_SETTINGS), userName: 'Updated' });
    } finally {
      process.umask(previousMask);
    }
    expect((await fs.stat(vault.resolve(CLAUDIAN_SETTINGS_PATH))).mode & 0o777).toBe(0o660);
  });

  it('retains leaf symlink write-through behavior', async () => {
    await vault.write('original.json', '{}');
    await vault.mkdir('.claudian');
    await vault.symlink(CLAUDIAN_SETTINGS_PATH, vault.resolve('original.json'));

    await new ClaudianSettingsStorage(vault.files, DEFAULT_CLAUDIAN_SETTINGS)
      .save({ ...structuredClone(DEFAULT_CLAUDIAN_SETTINGS), userName: 'Linked' });

    expect(await fs.lstat(vault.resolve(CLAUDIAN_SETTINGS_PATH)).then(stat => stat.isSymbolicLink())).toBe(true);
    expect(JSON.parse(await vault.read('original.json'))).toMatchObject({ userName: 'Linked' });
  });

  it('retains hardlink write-through behavior', async () => {
    await vault.write('original.json', '{}');
    await vault.mkdir('.claudian');
    await fs.link(vault.resolve('original.json'), vault.resolve(CLAUDIAN_SETTINGS_PATH));

    await new ClaudianSettingsStorage(vault.files, DEFAULT_CLAUDIAN_SETTINGS)
      .save({ ...structuredClone(DEFAULT_CLAUDIAN_SETTINGS), userName: 'Linked' });

    expect((await fs.stat(vault.resolve(CLAUDIAN_SETTINGS_PATH))).nlink).toBe(2);
    expect(JSON.parse(await vault.read('original.json'))).toMatchObject({ userName: 'Linked' });
  });

  it('continues writing through a linked parent directory', async () => {
    await vault.mkdir('settings');
    await vault.symlink('.claudian', vault.resolve('settings'));

    await new ClaudianSettingsStorage(vault.files, DEFAULT_CLAUDIAN_SETTINGS)
      .save({ ...structuredClone(DEFAULT_CLAUDIAN_SETTINGS), userName: 'Linked parent' });

    expect(await fs.lstat(vault.resolve('.claudian')).then(stat => stat.isSymbolicLink())).toBe(true);
    expect(JSON.parse(await vault.read('settings/claudian-settings.json'))).toMatchObject({ userName: 'Linked parent' });
  });
});
