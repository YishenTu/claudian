import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Conversation } from '@/core/types';
import { KimiConversationHistoryService } from '@/providers/kimi/history/KimiConversationHistoryService';
import { encodeKimiWorkDirKey } from '@/providers/kimi/history/KimiHistoryPathResolver';

describe('KimiConversationHistoryService', () => {
  let tempRoot: string;
  let vaultPath: string;
  let sessionDirectory: string;
  let wirePath: string;
  let fixture: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kimi-history-service-'));
    vaultPath = path.join(tempRoot, 'vault');
    sessionDirectory = path.join(
      tempRoot,
      '.kimi-code',
      'sessions',
      encodeKimiWorkDirKey(vaultPath),
      'session_00000000-0000-0000-0000-000000000001',
    );
    wirePath = path.join(sessionDirectory, 'agents', 'main', 'wire.jsonl');
    fixture = await fs.readFile(path.join(
      process.cwd(),
      'tests/unit/providers/kimi/fixtures/wire.jsonl',
    ), 'utf8');
    await fs.mkdir(path.dirname(wirePath), { recursive: true });
    await fs.writeFile(wirePath, fixture, 'utf8');
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { force: true, recursive: true });
  });

  const SESSION_ID = 'session_00000000-0000-0000-0000-000000000001';

  function createConversation(): Conversation {
    return {
      createdAt: 1,
      id: 'conversation-1',
      messages: [],
      providerId: 'kimi',
      providerState: { sessionDirectory: path.join(tempRoot, 'outside', SESSION_ID) },
      sessionId: SESSION_ID,
      title: 'Fixture',
      updatedAt: 1,
    };
  }

  it('hydrates idempotently, repairs path hints, and never mutates native history', async () => {
    const service = new KimiConversationHistoryService();
    const conversation = createConversation();
    const context = { environment: { HOME: tempRoot } };

    await service.hydrateConversationHistory(conversation, vaultPath, context);
    expect(conversation.messages).toHaveLength(6);
    expect(conversation.messages[0]).toMatchObject({
      content: 'Inspect the sample file.',
      role: 'user',
    });
    expect(conversation.providerState).toEqual({ sessionDirectory });

    await fs.writeFile(wirePath, '', 'utf8');
    await service.hydrateConversationHistory(conversation, vaultPath, context);
    expect(conversation.messages).toHaveLength(6);

    await service.deleteConversationSession(conversation, vaultPath, context);
    expect(await fs.readFile(wirePath, 'utf8')).toBe('');
    expect(await fs.stat(sessionDirectory)).toBeTruthy();
  });

  it('adopts the state.json title only when the conversation has none', async () => {
    const service = new KimiConversationHistoryService();
    const context = { environment: { HOME: tempRoot } };
    await fs.writeFile(path.join(sessionDirectory, 'state.json'), JSON.stringify({
      title: 'Native session title',
    }), 'utf8');

    const untitled = createConversation();
    untitled.title = '';
    await service.hydrateConversationHistory(untitled, vaultPath, context);
    expect(untitled.title).toBe('Native session title');

    const titled = createConversation();
    (titled as { id: string }).id = 'conversation-2';
    await service.hydrateConversationHistory(titled, vaultPath, context);
    expect(titled.title).toBe('Fixture');
  });

  it('rehydrates when the session binding changes even if messages exist', async () => {
    const service = new KimiConversationHistoryService();
    const conversation = createConversation();
    const context = { environment: { HOME: tempRoot } };

    await service.hydrateConversationHistory(conversation, vaultPath, context);
    expect(conversation.messages).toHaveLength(6);

    await fs.writeFile(wirePath, [
      JSON.stringify({
        input: [{ type: 'text', text: 'Only question' }],
        origin: { kind: 'user' },
        time: 1_700_000_000_000,
        type: 'turn.prompt',
      }),
    ].join('\n'), 'utf8');
    conversation.sessionId = SESSION_ID;
    conversation.providerState = { sessionDirectory };
    (conversation as { id: string }).id = 'conversation-2';

    await service.hydrateConversationHistory(conversation, vaultPath, context);
    expect(conversation.messages.map(message => message.content)).toEqual(['Only question']);
  });

  it('leaves messages unchanged and discards untrusted hints when history is unavailable', async () => {
    const service = new KimiConversationHistoryService();
    const conversation = createConversation();
    conversation.sessionId = 'missing-session';

    await service.hydrateConversationHistory(conversation, vaultPath, {
      environment: { HOME: tempRoot },
    });

    expect(conversation.messages).toEqual([]);
    expect(conversation.providerState).toBeUndefined();
  });

  it('does nothing without a session id or path context', async () => {
    const service = new KimiConversationHistoryService();
    const conversation = createConversation();
    conversation.sessionId = null;

    await service.hydrateConversationHistory(conversation, vaultPath, {
      environment: { HOME: tempRoot } });
    expect(conversation.messages).toEqual([]);

    conversation.sessionId = SESSION_ID;
    await service.hydrateConversationHistory(conversation, vaultPath);
    expect(conversation.messages).toEqual([]);
  });

  it('does not support forking and resolves session ids from the conversation', () => {
    const service = new KimiConversationHistoryService();
    const conversation = createConversation();

    expect(service.isPendingForkConversation(conversation)).toBe(false);
    expect(service.buildForkProviderState(SESSION_ID, 'assistant-1', {
      sessionDirectory,
    })).toEqual({});
    expect(service.resolveSessionIdForConversation(conversation)).toBe(SESSION_ID);
    expect(service.resolveSessionIdForConversation(null)).toBeNull();
    expect(service.buildPersistedProviderState(conversation)).toEqual({
      sessionDirectory: path.join(tempRoot, 'outside', SESSION_ID),
    });
    conversation.providerState = undefined;
    expect(service.buildPersistedProviderState(conversation)).toBeUndefined();
  });
});
