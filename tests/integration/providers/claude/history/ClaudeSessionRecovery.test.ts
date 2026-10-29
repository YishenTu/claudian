const actualModule0 = await vi.importActual<typeof fs>('node:fs/promises');
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { testDate, testTime } from '@test/helpers/testClock';

import { encodeVaultPathForSDK } from '@/providers/claude/history/ClaudeHistoryPathResolver';
import { recoverSDKSessionIdByTime } from '@/providers/claude/history/ClaudeSessionRecovery';


vi.mock('node:fs/promises', async () => {
  const actual = (await vi.importActual<typeof fs>('node:fs/promises'));
  return { ...actual, open: vi.fn(actual.open) };
});

let root: string;
let project: string;
let handles: fs.FileHandle[];
const vault = '/recovery-vault';
const sessionId = 'native-session';
const start = testDate().getTime();
const end = testDate({ seconds: 30 }).getTime();

beforeEach(async () => {
  handles = [];
  vi.mocked(fs.open).mockImplementation(async (file, flags, mode) => {
    const actual = actualModule0;
    const handle = await actual.open(file, flags, mode);
    vi.spyOn(handle, 'read');
    handles.push(handle);
    return handle;
  });
  root = await fs.mkdtemp(path.join(tmpdir(), 'claudian-recovery-lines-'));
  project = path.join(root, 'projects', encodeVaultPathForSDK(vault));
  await fs.mkdir(project, { recursive: true });
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

function record(type: string, timestamp: string, size = 0): string {
  return JSON.stringify({ sessionId, type, timestamp, message: { content: 'x'.repeat(size) } });
}

async function recover(lines: string[]): Promise<string | null> {
  await fs.writeFile(path.join(project, `${sessionId}.jsonl`), lines.join('\n') + '\n');
  return recoverSDKSessionIdByTime(vault, { createdAt: start, lastActivityAt: end }, {
    environment: { CLAUDE_CONFIG_DIR: root },
  });
}

async function bytesRead(): Promise<number> {
  const results = await Promise.all(handles.flatMap(handle => vi.mocked(handle.read).mock.results
    .map(result => result.value as Promise<{ bytesRead: number }>)));
  return results.reduce((total, result) => total + result.bytesRead, 0);
}

it.each(['first', 'last'])('recovers a native transcript with a large %s record crossing the sample boundary', async edge => {
  const first = record('user', testTime(), edge === 'first' ? 240 * 1024 : 0);
  const last = record('assistant', testTime({ seconds: 30 }), edge === 'last' ? 240 * 1024 : 0);
  await expect(recover([first, last])).resolves.toBe(sessionId);
});

it('retains complete small edge records when a huge middle record exceeds the completion budget', async () => {
  await expect(recover([
    record('user', testTime()),
    record('progress', testTime({ seconds: 15 }), 4 * 1024 * 1024),
    record('assistant', testTime({ seconds: 30 })),
  ])).resolves.toBe(sessionId);
  expect(await bytesRead()).toBeLessThanOrEqual(2 * 1024 * 1024);
});

it('bounds actual reads for a giant native record with no newline', async () => {
  await fs.writeFile(path.join(project, `${sessionId}.jsonl`), record('assistant', testTime({ seconds: 30 }), 4 * 1024 * 1024));
  await expect(recoverSDKSessionIdByTime(vault, { createdAt: start, lastActivityAt: end }, {
    environment: { CLAUDE_CONFIG_DIR: root },
  })).resolves.toBeNull();
  const count = await bytesRead();
  expect(count).toBeGreaterThanOrEqual(128 * 1024);
  expect(count).toBeLessThanOrEqual(2 * 1024 * 1024);
});

it('reads only the edges of an ordinary multi-megabyte transcript', async () => {
  await expect(recover([
    record('user', testTime()),
    ...Array.from({ length: 20_000 }, () => record('progress', testTime({ seconds: 15 }))),
    record('assistant', testTime({ seconds: 30 })),
  ])).resolves.toBe(sessionId);
  expect(await bytesRead()).toBeLessThanOrEqual(256 * 1024);
});
