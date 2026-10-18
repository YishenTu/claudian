import type * as childProcessType from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type * as environmentModule from '@/core/process/env';
import type { Conversation } from '@/core/types';
import { OpencodeConversationHistoryService } from '@/providers/opencode/history/OpencodeConversationHistoryService';

// Exercise real SQLite subprocesses without discovering the runner's other Node installations.
jest.mock('@/core/process/env', () => ({
  ...jest.requireActual<typeof environmentModule>('@/core/process/env'),
  findNodeExecutables: () => [process.execPath],
}));

describe('OpencodeConversationHistoryService', () => {
  const originalPlatform = process.platform;
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'claudian-opencode-conversation-history-'));
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    rmSync(tmpRoot, { force: true, recursive: true });
  });

  // This case loads an isolated provider graph and runs a native child with a 10-second deadline.
  it('passes the configured environment to the external history reader', async () => {
    const dbPath = path.join(tmpRoot, 'opencode.db');
    seedDatabase(dbPath, 'session-env', 'Configured history');
    const conversation = createConversation('session-env', dbPath);
    const childProcess = jest.requireActual<typeof childProcessType>('node:child_process');
    const realSpawn = childProcess.spawn;
    const environmentMarkers: Array<string | undefined> = [];
    jest.spyOn(childProcess, 'spawn').mockImplementation((command, args, options) => {
      environmentMarkers.push(options?.env?.CLAUDIAN_HISTORY_TEST);
      return realSpawn(command, args, options!);
    });
    jest.doMock('node:sqlite', () => ({}));
    try {
      await jest.isolateModulesAsync(async () => {
        const { OpencodeConversationHistoryService: HistoryService } = await import(
          '@/providers/opencode/history/OpencodeConversationHistoryService'
        );
        Object.assign(conversation, await new HistoryService().hydrateConversationHistory(conversation, null, {
          environment: {
            ...process.env,
            OPENCODE_DB: dbPath,
            CLAUDIAN_HISTORY_TEST: 'configured',
            PATH: path.dirname(process.execPath),
          },
        }));
      });
      expect(conversation.messages.map(message => message.content)).toEqual(['Configured history']);
      expect(environmentMarkers).toContain('configured');
    } finally {
      jest.dontMock('node:sqlite');
      jest.restoreAllMocks();
    }
  }, 20_000);

  it('retries after a session-level hydration diagnostic', async () => {
    const dbPath = path.join(tmpRoot, 'opencode.db');
    const sessionId = 'session-retry';
    const conversation = createConversation(sessionId, dbPath);
    const service = new OpencodeConversationHistoryService();

    // A database v2 has not opened yet lacks the native message table.
    new DatabaseSync(dbPath).close();

    Object.assign(conversation, await service.hydrateConversationHistory(conversation, null));

    expect(conversation.messages).toHaveLength(1);
    expect(conversation.messages[0]).toMatchObject({
      id: 'opencode-hydration-error-session-session-retry',
      role: 'assistant',
    });

    const repairedDb = new DatabaseSync(dbPath);
    try {
      repairedDb.exec('CREATE TABLE session_message(id TEXT, session_id TEXT, seq INTEGER, type TEXT, time_created INTEGER, data TEXT)');
      repairedDb.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)').run(
        'msg-user',
        sessionId,
        1,
        'user',
        1_000,
        JSON.stringify({ text: 'Recovered prompt', time: { created: 1_000 } }),
      );
    } finally {
      repairedDb.close();
    }

    Object.assign(conversation, await service.hydrateConversationHistory(conversation, null));

    expect(conversation.messages).toEqual([
      {
        assistantMessageId: undefined,
        content: 'Recovered prompt',
        id: 'msg-user',
        role: 'user',
        timestamp: 1_000,
        userMessageId: 'msg-user',
      },
    ]);
  }, 15_000);

  it('recovers the last OpenCode model from native message metadata', async () => {
    const dbPath = path.join(tmpRoot, 'model-history.db');
    const sessionId = 'session-model';
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('CREATE TABLE session_message(id TEXT, session_id TEXT, seq INTEGER, type TEXT, time_created INTEGER, data TEXT)');
      db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)').run(
        'assistant-1',
        sessionId,
        1,
        'assistant',
        1_000,
        JSON.stringify({ model: { id: 'gemini-3.5-flash', providerID: 'google' }, content: [] }),
      );
    } finally {
      db.close();
    }
    const conversation = createConversation(sessionId, dbPath);

    await expect(new OpencodeConversationHistoryService()
      .recoverConversationModelSelection?.(conversation, null))
      .resolves.toBe('opencode:google/gemini-3.5-flash');
  });

  it('does not open an out-of-root metadata database and uses the current local database', async () => {
    const sessionId = 'session-trusted-path';
    const xdgDataHome = path.join(tmpRoot, 'xdg');
    const trustedPath = path.join(xdgDataHome, 'opencode', 'opencode.db');
    const outsidePath = path.join(tmpRoot, 'synced-device', 'opencode.db');
    seedDatabase(trustedPath, sessionId, 'Trusted prompt');
    seedDatabase(outsidePath, sessionId, 'Outside prompt');
    const conversation = createConversation(sessionId, outsidePath);
    conversation.providerState!.futureResumeCursor = { token: 'cursor-1' };

    Object.assign(conversation, await new OpencodeConversationHistoryService().hydrateConversationHistory(
      conversation,
      null,
      { environment: { HOME: tmpRoot, XDG_DATA_HOME: xdgDataHome } },
    ));

    expect(conversation.messages.map(message => message.content)).toEqual(['Trusted prompt']);
    expect(conversation.providerState).toEqual({
      databasePath: trustedPath,
      futureResumeCursor: { token: 'cursor-1' },
    });
  });

  it('replaces a legacy Windows AppData database hint with the home database', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const sessionId = 'session-windows-home';
    const home = path.join(tmpRoot, 'home');
    const appData = path.join(home, 'AppData', 'Roaming');
    const legacyPath = path.join(appData, 'opencode', 'opencode.db');
    const homePath = path.join(home, '.local', 'share', 'opencode', 'opencode.db');
    seedDatabase(legacyPath, sessionId, 'Legacy AppData prompt');
    seedDatabase(homePath, sessionId, 'Current home prompt');
    const conversation = createConversation(sessionId, legacyPath);
    conversation.providerState!.futureResumeCursor = { token: 'cursor-1' };

    Object.assign(conversation, await new OpencodeConversationHistoryService().hydrateConversationHistory(
      conversation,
      null,
      {
        environment: {
          APPDATA: appData,
          HOME: home,
          LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
        },
      },
    ));

    expect(conversation.messages.map(message => message.content)).toEqual(['Current home prompt']);
    expect(conversation.providerState).toEqual({
      databasePath: homePath,
      futureResumeCursor: { token: 'cursor-1' },
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

  describe('resolveMissingConversationSession', () => {
    it('retires a confirmed stale resume ID to history while preserving provider-owned state', async () => {
      const conversation = createConversation('missing-session', '/tmp/opencode.db');
      conversation.providerState!.futureResumeCursor = { token: 'cursor-1' };
      const service = new OpencodeConversationHistoryService();

      const update1 = await service.resolveMissingConversationSession(
        conversation,
        null,
        'missing-session',
      );
      expect(update1.outcome).toBe('reset');
      Object.assign(conversation, update1.changes);

      expect(conversation.sessionId).toBeNull();
      expect(conversation.providerState).toEqual({
        databasePath: '/tmp/opencode.db',
        futureResumeCursor: { token: 'cursor-1' },
        nativeConversationContextEstablished: false,
        previousSessions: [{ sessionId: 'missing-session', databasePath: '/tmp/opencode.db' }],
      });
      expect(service.resolveSessionIdForConversation(conversation)).toBeNull();
    });

    it('preserves a newer resume ID when the failure identifies another session', async () => {
      const conversation = createConversation('current-session', '/tmp/opencode.db');
      conversation.providerState!.futureResumeCursor = { token: 'cursor-1' };
      const service = new OpencodeConversationHistoryService();

      const update2 = await service.resolveMissingConversationSession(
        conversation,
        null,
        'stale-session',
      );
      expect(update2.outcome).toBe('preserve');
      Object.assign(conversation, update2.changes);

      expect(conversation.sessionId).toBe('current-session');
      expect(conversation.providerState).toEqual({
        databasePath: '/tmp/opencode.db',
        futureResumeCursor: { token: 'cursor-1' },
      });
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
      null,
    ));

    expect(conversation.providerState).toEqual({
      databasePath: dbPath,
      futureResumeCursor: { token: 'cursor-1' },
      nativeConversationContextEstablished: true,
    });
  });

  it('accepts an explicitly configured local database path', async () => {
    const sessionId = 'session-configured-path';
    const configuredPath = path.join(tmpRoot, 'custom', 'opencode-custom.db');
    seedDatabase(configuredPath, sessionId, 'Configured prompt');
    const conversation = createConversation(sessionId, configuredPath);

    Object.assign(conversation, await new OpencodeConversationHistoryService().hydrateConversationHistory(
      conversation,
      null,
      { environment: { HOME: tmpRoot, OPENCODE_DB: configuredPath } },
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
      { environment: { HOME: tmpRoot, OPENCODE_DB: configuredPath } },
      { lifecycle: 'ephemeral' },
    )).resolves.toEqual({
      databasePath: configuredPath,
      forkSource: { sessionId: 'legacy-source', resumeAt: 'msg-reply' },
      nativeConversationContextEstablished: true,
      nativeVersion: 2,
    });
  });

  it('sanitizes an untrusted database path before a session is assigned', async () => {
    const xdgDataHome = path.join(tmpRoot, 'xdg');
    const trustedPath = path.join(xdgDataHome, 'opencode', 'opencode.db');
    const outsidePath = path.join(tmpRoot, 'synced-device', 'opencode.db');
    seedDatabase(trustedPath, 'local-session', 'Trusted prompt');
    seedDatabase(outsidePath, 'remote-session', 'Outside prompt');
    const conversation = createConversation('remote-session', outsidePath);
    conversation.sessionId = null;

    Object.assign(conversation, await new OpencodeConversationHistoryService().hydrateConversationHistory(
      conversation,
      null,
      { environment: { HOME: tmpRoot, XDG_DATA_HOME: xdgDataHome } },
    ));

    expect(conversation.providerState).toEqual({ databasePath: trustedPath });
  });
});

function seedDatabase(databasePath: string, sessionId: string, text: string): void {
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  try {
    db.exec('CREATE TABLE session_message(id TEXT, session_id TEXT, seq INTEGER, type TEXT, time_created INTEGER, data TEXT)');
    db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)').run(
      `message-${sessionId}`,
      sessionId,
      1,
      'user',
      1_000,
      JSON.stringify({ text, time: { created: 1_000 } }),
    );
  } finally {
    db.close();
  }
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
