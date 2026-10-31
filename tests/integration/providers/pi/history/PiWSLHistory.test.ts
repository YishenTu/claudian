import * as nodeFS from 'node:fs';
import * as nodeFSPromises from 'node:fs/promises';

import { testDate } from '@test/helpers/testClock';
import { createWindowsHostFS } from '@test/helpers/WindowsHostFS';
import { WSLProcessFixture } from '@test/helpers/WSLProcessFixture';
import spawn from 'cross-spawn';

import { PiConversationHistoryService } from '@/providers/pi/history/PiConversationHistoryService';
import type { PiHistoryPathContext } from '@/providers/pi/history/PiHistoryPathResolver';

vi.mock('node:fs', async () => ({ ...(await vi.importActual<typeof import('node:fs')>('node:fs')) }));
vi.mock('node:fs/promises', async () => ({ ...(await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')) }));

// Windows hosts have real drive paths and distro shares, so the modeled host only runs elsewhere.
const onWindows = process.platform === 'win32';
vi.mock('cross-spawn', () => ({ default: vi.fn() }));

const context: PiHistoryPathContext = {
  executionTarget: { method: 'wsl', distroName: 'Ubuntu', platformOs: 'linux', platformFamily: 'unix' },
  environment: { HOME: String.raw`C:\Users\host` }, environmentText: '', hostPlatform: 'win32',
};
// Each test owns its session identity, so shuffled runs cannot share discovery or store state.
const conversation = (sessionId: string) => ({ sessionId, providerState: { sessionId }, messages: [] });
const transcript = (sessionId: string, text = 'Linux history', header: Record<string, unknown> = {}) => [
  { type: 'session', id: sessionId, ...header },
  { type: 'message', id: `${sessionId}-answer`, timestamp: testDate().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text }] } },
].map(entry => JSON.stringify(entry)).join('\n') + '\n';

let native: WSLProcessFixture;
const environmentProbes = () => native.requests.filter(request => request.executable === '/usr/bin/awk');
beforeEach(() => { native = new WSLProcessFixture(); vi.mocked(spawn).mockReset().mockImplementation(native.spawn); });

it.skipIf(onWindows)('discovers the Linux home for ID-only reads and shares an in-flight probe across reads', async () => {
  const files = createWindowsHostFS({ fs: nodeFS, fsPromises: nodeFSPromises });
  await files.write(files.fromLinux('/home/alice/.pi/agent/sessions/session-shared.jsonl'), transcript('session-shared'));
  native.environment = { HOME: '/home/alice' };
  const service = new PiConversationHistoryService();
  const input = conversation('session-shared');
  const results = await Promise.all([service.hydrateConversationHistory(input, 'C:\\Vault', context), service.hydrateConversationHistory(input, 'C:\\Vault', context)]);
  for (const result of results) expect(result.messages).toMatchObject([{ content: 'Linux history' }]);
  expect(environmentProbes()).toHaveLength(1);
  expect(input.providerState).toEqual({ sessionId: 'session-shared' });
  service.resolveSessionIdForConversation(input);
  service.hasConversationModelRecoverySource(input);
  expect(environmentProbes()).toHaveLength(1);
  // Concurrent probes share identical launch inputs regardless of object key order.
  const reordered = { ...context, environment: { OTHER: '1', ...context.environment } };
  await Promise.all([
    service.hydrateConversationHistory(input, 'C:\\Vault', { ...context, environment: { ...context.environment, OTHER: '1' } }),
    service.hydrateConversationHistory(input, 'C:\\Vault', reordered),
  ]);
  expect(environmentProbes()).toHaveLength(2);
});

it.skipIf(onWindows)('reads the store under a configured Linux HOME that WSL forwards over the account home', async () => {
  const files = createWindowsHostFS({ fs: nodeFS, fsPromises: nodeFSPromises });
  await files.write(files.fromLinux('/home/bob/.pi/agent/sessions/session-forwarded.jsonl'), transcript('session-forwarded'));
  native.environment = { HOME: '/home/alice' };
  const forwarded = { ...context, environment: { HOME: '/home/bob' }, environmentText: 'HOME=/home/bob' };
  expect((await new PiConversationHistoryService().hydrateConversationHistory(conversation('session-forwarded'), 'C:\\Vault', forwarded)).messages)
    .toMatchObject([{ content: 'Linux history' }]);
});

it.skipIf(onWindows)('refreshes shell-only store variables without changing forwarded inputs', async () => {
  const files = createWindowsHostFS({ fs: nodeFS, fsPromises: nodeFSPromises });
  const service = new PiConversationHistoryService();
  const input = conversation('session-store');
  native.environment = { HOME: '/home/alice', PI_CODING_AGENT_SESSION_DIR: '/srv/shell-sessions' };
  await files.write(files.fromLinux('/srv/shell-sessions/session-store.jsonl'), transcript('session-store'));
  expect((await service.hydrateConversationHistory(input, 'C:\\Vault', context)).messages).toMatchObject([{ content: 'Linux history' }]);
  await files.remove(files.fromLinux('/srv/shell-sessions'));
  native.environment = { HOME: '/home/bob', PI_CODING_AGENT_DIR: '~/work' };
  await files.write(files.fromLinux('/home/bob/work/sessions/session-store.jsonl'), transcript('session-store'));
  expect((await service.hydrateConversationHistory(input, 'C:\\Vault', context)).messages).toMatchObject([{ content: 'Linux history' }]);
  expect(environmentProbes()).toHaveLength(2);
});

it.skipIf(onWindows)('preserves bindings on probe failure and retries discovery on the next read', async () => {
  const files = createWindowsHostFS({ fs: nodeFS, fsPromises: nodeFSPromises });
  const service = new PiConversationHistoryService();
  const input = conversation('session-retry');
  await files.write(files.fromLinux('/home/alice/.pi/agent/sessions/session-retry.jsonl'), transcript('session-retry'));
  native.reply = () => ({ code: 1 });
  await expect(service.hydrateConversationHistory(input, 'C:\\Vault', context)).rejects.toThrow('Pi WSL environment');
  expect(input.providerState).toEqual({ sessionId: 'session-retry' });
  native.reply = undefined;
  native.environment = { HOME: '/home/alice' };
  expect((await service.hydrateConversationHistory(input, 'C:\\Vault', context)).messages).toMatchObject([{ content: 'Linux history' }]);
  expect(environmentProbes()).toHaveLength(2);
});

it.skipIf(onWindows)('retires a pending fork whose source belongs to another distro during hydration', async () => {
  const files = createWindowsHostFS({ fs: nodeFS, fsPromises: nodeFSPromises });
  native.environment = { HOME: '/home/alice' };
  await files.write(files.fromLinux('/home/alice/.pi/agent/sessions/source.jsonl', 'Debian'), transcript('other-distro-source'));
  const source = String.raw`\\wsl$\Debian\home\alice\.pi\agent\sessions\source.jsonl`;
  const pending = {
    messages: [], sessionId: null,
    providerState: { customState: 'keep', forkSource: { sessionId: 'other-distro-source', resumeAt: 'assistant-1' }, forkSourceSessionFile: source },
  };
  const result = await new PiConversationHistoryService().hydrateConversationHistory(pending, 'C:\\Vault', context);
  expect(result.sessionId).toBeNull();
  expect(result.providerState).toEqual({ customState: 'keep', bindingRetired: true,
    previousSessions: [{ sessionFile: source, sessionId: 'other-distro-source', leafEntryId: 'assistant-1' }],
  });
});

it.skipIf(onWindows)('rejects WSL fork construction when the source locator cannot establish a trusted file', async () => {
  const files = createWindowsHostFS({ fs: nodeFS, fsPromises: nodeFSPromises });
  await files.write(files.fromLinux('/srv/sessions/source.jsonl', 'Debian'), transcript('untrusted-source'));
  const sessionFile = String.raw`\\wsl$\Debian\srv\sessions\source.jsonl`;
  await expect(new PiConversationHistoryService().buildForkProviderState('untrusted-source', 'assistant-1', {
    sessionFile, sessionId: 'untrusted-source',
  }, 'C:\\Vault', { ...context, environment: { PI_CODING_AGENT_SESSION_DIR: '/srv/sessions' } })).rejects.toThrow('Cannot fork Pi session');
});

it.skipIf(onWindows)('replays an ID-only archived WSL session whose header records the vault through its Linux mount', async () => {
  const files = createWindowsHostFS({ fs: nodeFS, fsPromises: nodeFSPromises });
  native.environment = { HOME: '/home/alice' };
  await files.write(String.raw`C:\Vault\note.md`, '');
  await files.write(files.fromLinux('/home/alice/.pi/agent/sessions/session-archived.jsonl'), transcript('session-archived', 'Archived answer', { cwd: '/mnt/c/Vault' }));
  await files.write(files.fromLinux('/home/alice/.pi/agent/sessions/session-current.jsonl'), transcript('session-current', 'Current answer'));
  const result = await new PiConversationHistoryService().hydrateConversationHistory({
    ...conversation('session-current'),
    providerState: { sessionId: 'session-current', previousSessions: [{ sessionId: 'session-archived' }] },
  }, 'C:\\Vault', context);
  expect(result.messages?.map(message => message.content)).toEqual(['Archived answer', 'Current answer']);
});
