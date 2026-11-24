// @test-ci {"native":true,"inputs":["tests/helpers/providers/opencode/OpencodeNativePeer.cjs"]}
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { seedFakeOpencodeSession, writeFakeOpencodeHistoryCLI } from '@test/helpers/providers/opencode/FakeOpencodeHistoryServer';
import { testDate } from '@test/helpers/testClock';

import { createProviderHistoryPathContext } from '@/core/providers/historyPathContext';
import type { ProviderHistoryPathContext } from '@/core/providers/types';
import type { Conversation } from '@/core/types';
import { OpencodeConversationHistoryService } from '@/providers/opencode/history/OpencodeConversationHistoryService';
import { OpencodeServerService } from '@/providers/opencode/http/OpencodeServerService';

describe('OpencodeConversationHistoryService', () => {
  const originalPlatform = process.platform;
  let tmpRoot: string;
  let settings: Record<string, unknown>;

  beforeEach(() => {
    tmpRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'claudian-opencode-conversation-history-')));
    settings = { providerConfigs: { opencode: { cliPath: writeFakeOpencodeHistoryCLI(tmpRoot) } } };
  });

  function context(environment: NodeJS.ProcessEnv): ProviderHistoryPathContext {
    return { ...createProviderHistoryPathContext(settings, 'opencode', tmpRoot), environment };
  }

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    rmSync(tmpRoot, { force: true, recursive: true });
  });

  it('retries after a session-level hydration diagnostic', async () => {
    const dbPath = path.join(tmpRoot, 'opencode.db');
    const sessionId = 'session-retry';
    const conversation = createConversation(sessionId, dbPath);
    const service = new OpencodeConversationHistoryService();
    const historyContext = context({ HOME: tmpRoot, OPENCODE_DB: dbPath });
    // The native database does not hold the session yet.
    writeFileSync(dbPath, '{}');

    Object.assign(conversation, await service.hydrateConversationHistory(conversation, tmpRoot, historyContext));

    expect(conversation.messages).toEqual([expect.objectContaining({
      id: 'opencode-hydration-error-session-session-retry',
      role: 'assistant',
      content: expect.stringContaining('Session not found: session-retry'),
    })]);
    // A failed read proves no native context.
    expect(conversation.providerState).toEqual({ databasePath: dbPath });

    seedDatabase(dbPath, sessionId, 'Recovered prompt');
    Object.assign(conversation, await service.hydrateConversationHistory(conversation, tmpRoot, historyContext));

    expect(conversation.messages).toEqual([
      {
        assistantMessageId: undefined,
        content: 'Recovered prompt',
        id: `message-${sessionId}`,
        role: 'user',
        timestamp: 1_000,
        userMessageId: `message-${sessionId}`,
      },
    ]);
  }, 15_000);

  it('recovers an unstamped binding model from its native session', async () => {
    const dbPath = path.join(tmpRoot, 'model-history.db');
    const sessionId = 'session-model';
    seedFakeOpencodeSession(dbPath, sessionId, { model: { id: 'gemini-3.5-flash', providerID: 'google' }, messages: [] });
    const conversation = createConversation(sessionId, dbPath);

    await expect(new OpencodeConversationHistoryService()
      .recoverConversationModelSelection?.(conversation, tmpRoot, context({ HOME: tmpRoot, OPENCODE_DB: dbPath })))
      .resolves.toBe('opencode:google/gemini-3.5-flash');
  });

  it.each([
    ['an out-of-root database', 'linux'],
    ['a Windows AppData database', 'win32'],
  ] as const)('never opens %s or moves the binding off it', async (_, platform) => {
    Object.defineProperty(process, 'platform', { value: platform });
    const sessionId = 'session-untrusted-path';
    const home = path.join(tmpRoot, 'home');
    const xdgDataHome = path.join(tmpRoot, 'xdg');
    const currentPath = platform === 'win32'
      ? path.join(home, '.local', 'share', 'opencode', 'opencode.db')
      : path.join(xdgDataHome, 'opencode', 'opencode.db');
    const recordedPath = platform === 'win32'
      ? path.join(home, 'AppData', 'Roaming', 'opencode', 'opencode.db')
      : path.join(tmpRoot, 'synced-device', 'opencode.db');
    seedDatabase(currentPath, sessionId, 'Current prompt');
    seedDatabase(recordedPath, sessionId, 'Recorded prompt');
    const conversation = createConversation(sessionId, recordedPath);
    conversation.providerState!.futureResumeCursor = { token: 'cursor-1' };

    Object.assign(conversation, await new OpencodeConversationHistoryService().hydrateConversationHistory(
      conversation,
      tmpRoot,
      context(platform === 'win32'
        ? { APPDATA: path.join(home, 'AppData', 'Roaming'), HOME: home }
        : { HOME: home, XDG_DATA_HOME: xdgDataHome }),
    ));

    // Neither database is read; the recorded locator survives for a later trusted read.
    expect(conversation.messages).toEqual([expect.objectContaining({
      id: `opencode-hydration-error-session-${sessionId}`,
      content: expect.stringContaining(recordedPath),
    })]);
    expect(conversation.providerState).toEqual({
      databasePath: recordedPath,
      futureResumeCursor: { token: 'cursor-1' },
    });
  });

  describe('readNativeHistoryRevision', () => {
    let servers: OpencodeServerService;
    let service: OpencodeConversationHistoryService;
    let dbPath: string;
    let processLog: string;
    const sessionId = 'session-live';
    const at = (offset: number) => testDate().getTime() + offset;
    const user = { id: 'msg-user', type: 'user', text: 'Prompt', time: { created: at(0) } };
    const reply = { id: 'msg-reply', type: 'assistant', time: { created: at(100) }, content: [{ type: 'text', text: 'Partial' }] };

    beforeEach(() => {
      servers = new OpencodeServerService();
      service = new OpencodeConversationHistoryService({ getServerService: async () => servers });
      dbPath = path.join(tmpRoot, 'opencode.db');
      processLog = path.join(tmpRoot, 'processes');
      seedFakeOpencodeSession(dbPath, sessionId, { time: { created: at(0), updated: at(100) }, messages: [user, reply] });
    });

    afterEach(async () => { await servers.dispose(); });

    const historyContext = () => context({ HOME: tmpRoot, OPENCODE_DB: dbPath, PROCESS_LOG: processLog });
    const launches = () => existsSync(processLog) ? readFileSync(processLog, 'utf8').trim().split('\n').length : 0;
    const startServer = async () => {
      await service.hydrateConversationHistory(createConversation(sessionId, dbPath), tmpRoot, historyContext());
      expect(launches()).toBe(1);
    };
    const revision = (conversation = createConversation(sessionId, dbPath)) => (
      service.readNativeHistoryRevision(conversation, tmpRoot, historyContext()));

    it('changes on every external write to the live session through the running server', async () => {
      await startServer();
      const initial = await revision();
      expect(initial).toEqual(expect.any(String));
      await expect(revision()).resolves.toBe(initial);

      // The newest reply streams in place, then completes; another client then appends a turn.
      const streamed = { ...reply, content: [{ type: 'text', text: 'Partial and more' }] };
      seedFakeOpencodeSession(dbPath, sessionId, { time: { created: at(0), updated: at(100) }, messages: [user, streamed] });
      const afterStream = await revision();
      const completed = { ...streamed, time: { created: at(100), completed: at(200) } };
      seedFakeOpencodeSession(dbPath, sessionId, { time: { created: at(0), updated: at(100) }, messages: [user, completed] });
      const afterCompletion = await revision();
      seedFakeOpencodeSession(dbPath, sessionId, { time: { created: at(0), updated: at(100) }, messages: [user, completed, { ...user, id: 'msg-next' }] });
      const afterAppend = await revision();
      seedFakeOpencodeSession(dbPath, sessionId, { time: { created: at(0), updated: at(100), idle: at(300) }, messages: [user, completed, { ...user, id: 'msg-next' }] });
      const afterIdle = await revision();

      const tokens = [initial, afterStream, afterCompletion, afterAppend, afterIdle];
      expect(tokens.every(token => typeof token === 'string')).toBe(true);
      expect(new Set(tokens).size).toBe(tokens.length);
      await expect(revision()).resolves.toBe(afterIdle);
      expect(launches()).toBe(1);
    });

    it('never starts a server to answer', async () => {
      await expect(revision()).resolves.toBeNull();
      expect(launches()).toBe(0);

      // A server for another database does not observe this binding.
      const otherPath = path.join(tmpRoot, 'other', 'opencode.db');
      seedFakeOpencodeSession(otherPath, sessionId, { messages: [user] });
      await startServer();
      await expect(revision(createConversation(sessionId, otherPath))).resolves.toBeNull();
      expect(launches()).toBe(1);
    });

    it('is null without a live native session or an accessible database', async () => {
      await startServer();
      const unbound = { ...createConversation(sessionId, dbPath), sessionId: null };
      // Retired sessions are not live history.
      unbound.providerState = { databasePath: dbPath, previousSessions: [{ sessionId, databasePath: dbPath }] };
      await expect(revision(unbound)).resolves.toBeNull();
      // A pending fork has no native session of its own yet.
      const fork = { ...unbound, providerState: { databasePath: dbPath, forkSource: { sessionId, resumeAt: reply.id } } };
      await expect(revision(fork)).resolves.toBeNull();
      // The recorded database is gone.
      rmSync(dbPath);
      await expect(revision()).resolves.toBeNull();
      expect(launches()).toBe(1);
    });
  });

  it('sanitizes known fields while preserving unknown provider state', () => {
    const conversation = createConversation('session-1', '/tmp/opencode.db');
    conversation.providerState!.futureResumeCursor = { token: 'cursor-1' };

    expect(
      new OpencodeConversationHistoryService().buildPersistedProviderState(conversation),
    ).toEqual({
      databasePath: '/tmp/opencode.db',
      futureResumeCursor: { token: 'cursor-1' },
    });
  });

  it('marks native context established when read-only hydration proves history exists', async () => {
    const dbPath = path.join(tmpRoot, 'opencode.db');
    seedDatabase(dbPath, 'session-established', 'Accepted prompt');
    const conversation = createConversation('session-established', dbPath);
    conversation.providerState = {
      ...conversation.providerState,
      futureResumeCursor: { token: 'cursor-1' },
      nativeConversationContextEstablished: false,
    };

    Object.assign(conversation, await new OpencodeConversationHistoryService().hydrateConversationHistory(
      conversation,
      tmpRoot,
      context({ HOME: tmpRoot, OPENCODE_DB: dbPath }),
    ));

    expect(conversation.providerState).toEqual({
      databasePath: dbPath,
      futureResumeCursor: { token: 'cursor-1' },
      nativeConversationContextEstablished: true,
    });
  });

  describe('restores background subagent cards', () => {
    const created = testDate().getTime();
    const launch = 'The subagent is working in the background (sessionID: ses_child). You will receive a <subagent> message when it goes idle.';
    const spawn = (id: string, at: number, prompt: string, extra: Record<string, unknown> = {}) => ({
      id: `a-${id}`, type: 'assistant', time: { created: created + at }, content: [{ id, type: 'tool', name: 'subagent', state: {
        status: 'completed', input: { agent: 'general', description: 'Survey', prompt, ...extra }, output: launch, metadata: { sessionID: 'ses_child', status: 'running' },
      } }],
    });
    // 2.3 reports `running` in the envelope while the child's own work continues; metadata says completed.
    const report = (state: string, at: number, body = 'Waiting on the indexer.') => ({
      id: `report-${at}`, type: 'synthetic', time: { created: created + at }, description: 'Survey',
      text: `<subagent sessionID="ses_child" state="${state}" description="Survey">\n${body}\n</subagent>`,
      metadata: { source: 'subagent', childID: 'ses_child', state: state === 'running' ? 'completed' : state },
    });
    const child = [
      { id: 'c-user', type: 'user', time: { created: created + 1 }, text: 'Survey the vault' },
      { id: 'c-answer', type: 'assistant', time: { created: created + 2 }, content: [{ type: 'text', text: 'Vault surveyed.' }] },
      { id: 'c-user-2', type: 'user', time: { created: created + 11 }, text: 'Check again' },
      { id: 'c-wait', type: 'assistant', time: { created: created + 12 }, content: [{ type: 'text', text: 'Still checking.' }] },
    ];
    const user = (id: string, at: number, text: string) => ({ id, type: 'user', time: { created: created + at }, text });
    const answer = (id: string, at: number, text: string) => ({ id, type: 'assistant', time: { created: created + at }, content: [{ type: 'text', text }] });
    /** A spawn whose tool part records when it started and when its launch ended. */
    const timedSpawn = (rowId: string, id: string, at: number, prompt: string, launchedAt: number) => {
      const row = spawn(id, at, prompt);
      return { ...row, id: rowId, content: [{ ...row.content[0], time: { created: created + launchedAt - 1, ran: created + launchedAt - 1, completed: created + launchedAt } }] };
    };
    const idle = (id: string, at: number) => ({ id, type: 'idle', time: { created: created + at }, outcome: 'succeeded' });
    const queuedChild = [
      user('c-1', 2, 'Survey the vault'), answer('c-survey', 3, 'Vault surveyed.'), idle('c-idle-1', 4),
      user('c-2', 22, 'Check again'), answer('c-check', 23, 'Checked again.'), idle('c-idle-2', 24),
    ];
    const card = (id: string, status: string, result: string) => expect.objectContaining({ id, mode: 'async', agentId: 'ses_child', status, asyncStatus: status, result });

    it.each([
      { name: 'an interim report while its own work runs', parent: [spawn('first', 0, 'Survey the vault'), report('running', 3)], cards: [card('first', 'running', launch)] },
      { name: 'a final report', parent: [spawn('first', 0, 'Survey the vault'), report('running', 3), report('completed', 4, 'Vault surveyed.')], cards: [card('first', 'completed', 'Vault surveyed.')] },
      { name: 'no report', parent: [spawn('first', 0, 'Survey the vault')], cards: [card('first', 'completed', 'Vault surveyed.')] },
      {
        name: 'a follow-up still running after an earlier spawn finished',
        parent: [spawn('first', 0, 'Survey the vault'), report('completed', 3, 'Vault surveyed.'), spawn('second', 10, 'Check again'), report('running', 13)],
        cards: [card('first', 'completed', 'Vault surveyed.'), card('second', 'running', launch)],
      },
      {
        name: 'a failure report',
        parent: [spawn('first', 0, 'Survey the vault'), report('error', 3, 'Rate limit exhausted')],
        cards: [card('first', 'error', 'Rate limit exhausted')],
      },
      {
        name: 'a foreground spawn that OpenCode moved to the background',
        parent: [spawn('first', 0, 'Survey the vault', { background: false }), report('completed', 3, 'Vault surveyed.')],
        cards: [card('first', 'completed', 'Vault surveyed.')],
      },
      {
        name: 'follow-ups that joined before the first prompt had an answer',
        parent: [spawn('first', 0, 'Survey the vault'), spawn('second', 0.1, 'Check again'), spawn('third', 0.2, 'List links'), report('completed', 9, 'Links answer')],
        child: [
          user('c-1', 1, 'Survey the vault'),
          { id: 'c-read', type: 'assistant', time: { created: created + 2 }, content: [{ type: 'tool', id: 'read', name: 'read', state: { status: 'completed', input: { path: 'notes.md' }, output: 'notes' } }] },
          user('c-2', 5, 'Check again'), answer('c-both', 6, 'Vault and check answer'),
          user('c-3', 7, 'List links'), answer('c-links', 8, 'Links answer'),
        ],
        cards: [card('first', 'completed', 'Vault and check answer'), card('second', 'completed', 'Vault and check answer'), card('third', 'completed', 'Links answer')],
      },
      {
        name: 'a completed report that OpenCode 2.2 sent before its shell woke the child again',
        parent: [spawn('first', 0, 'Survey the vault'), report('completed', 3, 'Child waiting on shell.')],
        child: [
          user('c-1', 1, 'Survey the vault'), answer('c-wait', 2, 'Child waiting on shell.'),
          { id: 'c-idle', type: 'idle', time: { created: created + 2.5 }, outcome: 'succeeded' },
          // The shell's exit report wakes the child for another run.
          { id: 'c-shell', type: 'synthetic', time: { created: created + 3.5 }, description: 'sleep 30', text: '<shell id="sh_1" state="completed" command="sleep 30">\nbg-done\n</shell>', metadata: { source: 'shell', shellID: 'sh_1', state: 'completed' } },
          answer('c-final', 4, 'Child final.'),
        ],
        cards: [card('first', 'completed', 'Child waiting on shell.')],
      },
      {
        name: 'an earlier joined round that answered over several steps',
        parent: [spawn('first', 0, 'Survey the vault'), spawn('second', 0.1, 'Check again'), report('completed', 9, 'Check answer')],
        child: [
          user('c-1', 1, 'Survey the vault'),
          { id: 'c-plan', type: 'assistant', time: { created: created + 2 }, content: [{ type: 'text', text: 'I will inspect the folder.' }, { type: 'tool', id: 'read', name: 'read', state: { status: 'completed', input: { path: '.' }, output: 'db' } }] },
          answer('c-folder', 3, 'The folder contains only the database.'),
          user('c-2', 5, 'Check again'), answer('c-check', 6, 'Check answer'),
        ],
        cards: [card('first', 'completed', 'The folder contains only the database.'), card('second', 'completed', 'Check answer')],
      },
      {
        name: 'a follow-up that repeats the first prompt',
        parent: [spawn('first', 0, 'Check status'), report('completed', 3, 'First answer.'), spawn('second', 10, 'Check status'), report('completed', 13, 'Updated status.')],
        // OpenCode prefixes only the child's first prompt.
        child: [
          user('c-1', 1, 'You are a subagent spawned by another session.\nCheck status'), answer('c-first', 2, 'First answer.'),
          user('c-2', 11, 'Check status'), answer('c-updated', 12, 'Updated status.'),
        ],
        cards: [card('first', 'completed', 'First answer.'), card('second', 'completed', 'Updated status.')],
      },
      {
        // OpenCode mints a report's ID at the spawn it answers, queues it as the child goes idle, and
        // delivers it once the spawner's step ends, here after a follow-up launched.
        name: 'a report OpenCode queued before a follow-up launched but delivered after it',
        parent: [
          timedSpawn('a-first', 'first', 0, 'Survey the vault', 1),
          timedSpawn('a-second', 'second', 3, 'Check again', 21),
          { ...report('completed', 30, 'Vault surveyed.'), id: nativeID(created + 1) },
          { ...report('completed', 31, 'Checked again.'), id: nativeID(created + 21) },
        ],
        child: queuedChild,
        cards: [card('first', 'completed', 'Vault surveyed.'), card('second', 'completed', 'Checked again.')],
      },
      {
        // After an interim report, OpenCode mints the next report as it queues it, just after the
        // child's idle, and delivers it once a follow-up launched in the same step.
        name: 'a terminal report OpenCode queued after an interim one but delivered after a follow-up',
        parent: [
          timedSpawn('a-first', 'first', 0, 'Survey the vault', 1),
          { ...report('running', 6, 'Child waiting'), id: nativeID(created + 1) },
          timedSpawn('a-second', 'second', 15, 'Check again', 16),
          { ...report('completed', 30, 'Child final.'), id: nativeID(created + 11) },
          { ...report('completed', 31, 'Follow-up answer.'), id: nativeID(created + 16) },
        ],
        child: [
          user('c-1', 2, 'Survey the vault'), answer('c-wait', 3, 'Child waiting'), idle('c-idle-1', 5),
          answer('c-final', 9, 'Child final.'), idle('c-idle-2', 10),
          user('c-2', 17, 'Check again'), answer('c-follow', 18, 'Follow-up answer.'), idle('c-idle-3', 19),
        ],
        cards: [card('first', 'completed', 'Child final.'), card('second', 'completed', 'Follow-up answer.')],
      },
      {
        name: 'a follow-up in the next native message that reuses the tool call ID',
        parent: [
          timedSpawn('a-first', 'call', 0, 'Survey the vault', 1),
          timedSpawn('a-second', 'call', 3, 'Check again', 21),
          { ...report('completed', 30, 'Vault surveyed.'), id: nativeID(created + 1) },
          { ...report('completed', 31, 'Checked again.'), id: nativeID(created + 21) },
        ],
        child: queuedChild,
        cards: [card('call', 'completed', 'Vault surveyed.'), card('call', 'completed', 'Checked again.')],
      },
      {
        name: 'a follow-up that reuses another tool\'s call ID',
        parent: [
          timedSpawn('a-first', 'first', 0, 'Survey the vault', 1),
          { id: 'a-read', type: 'assistant', time: { created: created + 2 }, content: [{ id: 'call', type: 'tool', name: 'read', time: { created: created + 2, completed: created + 2 }, state: { status: 'completed', input: { path: 'notes.md' }, output: 'notes' } }] },
          timedSpawn('a-second', 'call', 3, 'Check again', 21),
          { ...report('completed', 30, 'Vault surveyed.'), id: nativeID(created + 1) },
          { ...report('completed', 31, 'Checked again.'), id: nativeID(created + 21) },
        ],
        child: queuedChild,
        cards: [card('first', 'completed', 'Vault surveyed.'), undefined, card('call', 'completed', 'Checked again.')],
      },
      {
        // The follow-up's prompt waits in the child's inbox while its run is cancelled.
        name: 'a follow-up launched just before its child was cancelled',
        parent: [
          timedSpawn('a-first', 'first', 0, 'Survey the vault', 1),
          timedSpawn('a-second', 'second', 3, 'Check again', 5),
          { ...report('cancelled', 30, 'Subagent cancelled'), id: nativeID(created + 1) },
          { ...report('completed', 31, 'Checked again.'), id: nativeID(created + 7) },
        ],
        child: [
          user('c-1', 2, 'Survey the vault'), { ...idle('c-idle-1', 6), outcome: 'failed' },
          user('c-2', 8, 'Check again'), answer('c-check', 9, 'Checked again.'), idle('c-idle-2', 10),
        ],
        cards: [card('first', 'error', 'Subagent cancelled'), card('second', 'completed', 'Checked again.')],
      },
      {
        name: 'a child cancelled before it took its prompt',
        parent: [spawn('first', 0, 'Survey the vault'), report('cancelled', 3, 'Subagent cancelled')],
        child: [{ ...idle('c-idle', 2), outcome: 'failed' }],
        cards: [card('first', 'error', 'Subagent cancelled')],
      },
      {
        name: 'a child that ended without final text after progress',
        parent: [spawn('first', 0, 'Survey the vault'), report('completed', 4, 'Subagent completed without a text response.')],
        child: [user('c-1', 1, 'Survey the vault'), answer('c-progress', 2, 'Still reading.'), { id: 'c-empty', type: 'assistant', time: { created: created + 3 }, content: [] }],
        cards: [card('first', 'completed', 'Subagent completed without a text response.')],
      },
    ])('after $name', async ({ parent, child: childRows = child, cards }) => {
      const dbPath = path.join(tmpRoot, 'subagent-history.db');
      seedFakeOpencodeSession(dbPath, 'ses_parent', { messages: parent });
      seedFakeOpencodeSession(dbPath, 'ses_child', { messages: childRows });
      const conversation = createConversation('ses_parent', dbPath);

      Object.assign(conversation, await new OpencodeConversationHistoryService().hydrateConversationHistory(
        conversation, tmpRoot, context({ HOME: tmpRoot, OPENCODE_DB: dbPath }),
      ));

      expect(conversation.messages.flatMap(message => message.toolCalls ?? []).map(tool => tool.subagent)).toEqual(cards);
    });

    it('keeps a failed follow-up launch failed when the child later reports success', async () => {
      const dbPath = path.join(tmpRoot, 'subagent-history.db');
      seedFakeOpencodeSession(dbPath, 'ses_parent', { messages: [
        spawn('first', 0, 'Survey the vault'),
        { id: 'a-second', type: 'assistant', time: { created: created + 1 }, content: [{ id: 'second', type: 'tool', name: 'subagent', state: {
          status: 'error', input: { agent: 'general', description: 'Survey', prompt: 'Check again', sessionID: 'ses_child', background: true }, error: 'Launch interrupted', metadata: { sessionID: 'ses_child' },
        } }] },
        report('completed', 4, 'Child finished'),
      ] });
      seedFakeOpencodeSession(dbPath, 'ses_child', { messages: [user('c-1', 1, 'Survey the vault'), user('c-2', 2, 'Check again'), answer('c-done', 3, 'Child finished')] });
      const conversation = createConversation('ses_parent', dbPath);

      Object.assign(conversation, await new OpencodeConversationHistoryService().hydrateConversationHistory(
        conversation, tmpRoot, context({ HOME: tmpRoot, OPENCODE_DB: dbPath }),
      ));

      expect(conversation.messages.flatMap(message => message.toolCalls ?? []).map(tool => tool.subagent)).toEqual([
        card('first', 'completed', 'Child finished'),
        expect.objectContaining({ id: 'second', mode: 'async', status: 'error', asyncStatus: 'error', result: expect.stringContaining('Launch interrupted') }),
      ]);
    });

    it('keeps a failed background launch failed when no report follows', async () => {
      const dbPath = path.join(tmpRoot, 'subagent-history.db');
      seedFakeOpencodeSession(dbPath, 'ses_parent', { messages: [
        { id: 'a-first', type: 'assistant', time: { created }, content: [{ id: 'first', type: 'tool', name: 'subagent', state: {
          status: 'error', input: { agent: 'general', description: 'Survey', prompt: 'Survey the vault', background: true }, error: 'Launch interrupted', metadata: { sessionID: 'ses_child' },
        } }] },
      ] });
      seedFakeOpencodeSession(dbPath, 'ses_child', { messages: [user('c-1', 1, 'Survey the vault'), answer('c-wait', 2, 'Working.')] });
      const conversation = createConversation('ses_parent', dbPath);

      Object.assign(conversation, await new OpencodeConversationHistoryService().hydrateConversationHistory(
        conversation, tmpRoot, context({ HOME: tmpRoot, OPENCODE_DB: dbPath }),
      ));

      expect(conversation.messages.flatMap(message => message.toolCalls ?? []).map(tool => tool.subagent)).toEqual([
        expect.objectContaining({ id: 'first', mode: 'async', status: 'error', asyncStatus: 'error', result: expect.stringContaining('Launch interrupted') }),
      ]);
    });

    it('settles a requested background spawn whose stored result has no launch status', async () => {
      const dbPath = path.join(tmpRoot, 'subagent-history.db');
      seedFakeOpencodeSession(dbPath, 'ses_parent', { messages: [
        { id: 'a-first', type: 'assistant', time: { created }, content: [{ id: 'first', type: 'tool', name: 'subagent', state: {
          status: 'completed', input: { agent: 'general', description: 'Survey', prompt: 'Survey the vault', background: true }, output: 'Task started.', metadata: { sessionID: 'ses_child' },
        } }] },
        report('error', 3, 'Worker failed.'),
      ] });
      seedFakeOpencodeSession(dbPath, 'ses_child', { messages: [user('c-1', 1, 'Survey the vault'), answer('c-wait', 2, 'Working.')] });
      const conversation = createConversation('ses_parent', dbPath);

      Object.assign(conversation, await new OpencodeConversationHistoryService().hydrateConversationHistory(
        conversation, tmpRoot, context({ HOME: tmpRoot, OPENCODE_DB: dbPath }),
      ));

      expect(conversation.messages.flatMap(message => message.toolCalls ?? []).map(tool => tool.subagent)).toEqual([card('first', 'error', 'Worker failed.')]);
    });

    it('restores a foreground spawn still running, whose progress also reports running, as a sync card', async () => {
      const dbPath = path.join(tmpRoot, 'subagent-history.db');
      seedFakeOpencodeSession(dbPath, 'ses_parent', { messages: [{
        id: 'a-first', type: 'assistant', time: { created }, content: [{ id: 'first', type: 'tool', name: 'subagent', state: {
          status: 'running', input: { agent: 'general', description: 'Survey', prompt: 'Survey the vault' }, metadata: { sessionID: 'ses_child', status: 'running' },
        } }],
      }] });
      seedFakeOpencodeSession(dbPath, 'ses_child', { messages: [
        user('c-1', 1, 'Survey the vault'),
        { id: 'c-read', type: 'assistant', time: { created: created + 2 }, content: [{ type: 'tool', id: 'read', name: 'read', state: { status: 'completed', input: { path: 'notes.md' }, output: 'notes' } }] },
      ] });
      const conversation = createConversation('ses_parent', dbPath);

      Object.assign(conversation, await new OpencodeConversationHistoryService().hydrateConversationHistory(
        conversation, tmpRoot, context({ HOME: tmpRoot, OPENCODE_DB: dbPath }),
      ));

      expect(conversation.messages.flatMap(message => message.toolCalls ?? []).map(tool => tool.subagent)).toEqual([
        expect.objectContaining({ id: 'first', mode: 'sync', status: 'running', agentId: 'ses_child', toolCalls: [expect.objectContaining({ id: 'read' })] }),
      ]);
    });
  });

  it('accepts an explicitly configured local database path', async () => {
    const sessionId = 'session-configured-path';
    const configuredPath = path.join(tmpRoot, 'custom', 'opencode-custom.db');
    seedDatabase(configuredPath, sessionId, 'Configured prompt');
    const conversation = createConversation(sessionId, configuredPath);

    Object.assign(conversation, await new OpencodeConversationHistoryService().hydrateConversationHistory(
      conversation,
      tmpRoot,
      context({ HOME: tmpRoot, OPENCODE_DB: configuredPath }),
    ));

    expect(conversation.messages.map(message => message.content)).toEqual(['Configured prompt']);
  });

  it('defers an ephemeral fork of an unstamped legacy binding to its first v2 send', async () => {
    const configuredPath = path.join(tmpRoot, 'custom', 'opencode.db');
    seedDatabase(configuredPath, 'legacy-source', 'Legacy prompt');

    await expect(new OpencodeConversationHistoryService().buildForkProviderState(
      'legacy-source',
      'msg-reply',
      { databasePath: configuredPath, sessionId: 'legacy-source' },
      tmpRoot,
      context({ HOME: tmpRoot, OPENCODE_DB: configuredPath }),
      { lifecycle: 'ephemeral' },
    )).resolves.toEqual({
      databasePath: configuredPath,
      forkSource: { sessionId: 'legacy-source', resumeAt: 'msg-reply' },
      nativeConversationContextEstablished: true,
    });
  });
});

function seedDatabase(databasePath: string, sessionId: string, text: string): void {
  seedFakeOpencodeSession(databasePath, sessionId, {
    messages: [{ id: `message-${sessionId}`, type: 'user', text, time: { created: 1_000 } }],
  });
}

function createConversation(sessionId: string, databasePath: string): Conversation {
  return {
    createdAt: 1,
    id: 'conv-opencode',
    messages: [],
    providerId: 'opencode',
    providerState: { databasePath },
    sessionId,
    title: 'OpenCode conversation',
    lastActivityAt: 1,
  };
}

/** OpenCode's ascending message ID, which encodes when it was minted. */
function nativeID(mintedAt: number): string {
  const time = (mintedAt * 0x1000 + 1) % 2 ** 48;
  return `msg_${time.toString(16).padStart(12, '0')}Ab3dEf6hIj9kLm`;
}
