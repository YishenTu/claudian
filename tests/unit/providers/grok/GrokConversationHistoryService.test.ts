import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Conversation } from '../../../../src/core/types';
import {
  GrokConversationHistoryService,
  loadGrokHistoryMessages,
  shouldSkipGrokHistoryUser,
} from '../../../../src/providers/grok/history/GrokConversationHistoryService';

describe('GrokConversationHistoryService', () => {
  let tmpRoot: string;
  let vaultPath: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claudian-grok-history-'));
    vaultPath = path.join(tmpRoot, 'vault');
    fs.mkdirSync(vaultPath, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { force: true, recursive: true });
  });

  it('skips synthetic system reminders and hydrates user/assistant turns', () => {
    expect(shouldSkipGrokHistoryUser({ synthetic_reason: 'bootstrap' }, 'x')).toBe(true);
    expect(shouldSkipGrokHistoryUser({}, '<user_info>\nos')).toBe(true);
    expect(shouldSkipGrokHistoryUser({}, 'hello')).toBe(false);

    const sessionId = 'session-1';
    const historyPath = path.join(
      tmpRoot,
      'sessions',
      encodeURIComponent(vaultPath),
      sessionId,
      'chat_history.jsonl',
    );
    fs.mkdirSync(path.dirname(historyPath), { recursive: true });
    fs.writeFileSync(historyPath, [
      JSON.stringify({ type: 'system', content: 'system prompt' }),
      JSON.stringify({
        type: 'user',
        synthetic_reason: 'bootstrap',
        content: [{ type: 'text', text: '<user_info>os</user_info>' }],
      }),
      JSON.stringify({
        type: 'user',
        content: [{ type: 'text', text: '<user_query>\nFix the bug\n</user_query>' }],
      }),
      JSON.stringify({
        type: 'assistant',
        content: [{ type: 'text', text: 'Done.' }],
      }),
    ].join('\n'), 'utf-8');

    const messages = loadGrokHistoryMessages(historyPath, sessionId, 1000);
    expect(messages).toEqual([
      expect.objectContaining({
        role: 'user',
        content: 'Fix the bug',
      }),
      expect.objectContaining({
        role: 'assistant',
        content: 'Done.',
      }),
    ]);
  });

  it('hydrates conversation from GROK_HOME session files without mutating them', async () => {
    const sessionId = 'session-hydrate';
    const historyPath = path.join(
      tmpRoot,
      'sessions',
      encodeURIComponent(vaultPath),
      sessionId,
      'chat_history.jsonl',
    );
    fs.mkdirSync(path.dirname(historyPath), { recursive: true });
    const original = JSON.stringify({
      type: 'user',
      content: 'Hello Grok',
    }) + '\n' + JSON.stringify({
      type: 'assistant',
      content: 'Hi there',
    }) + '\n';
    fs.writeFileSync(historyPath, original, 'utf-8');

    const conversation: Conversation = {
      id: 'conv-1',
      providerId: 'grok',
      title: 'Test',
      createdAt: 1_000,
      updatedAt: 1_000,
      messages: [],
      sessionId,
      providerState: { sessionId },
    };

    const previousHome = process.env.GROK_HOME;
    process.env.GROK_HOME = tmpRoot;
    try {
      const service = new GrokConversationHistoryService();
      await service.hydrateConversationHistory(conversation, vaultPath);

      expect(conversation.messages.map((message) => message.content)).toEqual([
        'Hello Grok',
        'Hi there',
      ]);
      expect(fs.readFileSync(historyPath, 'utf-8')).toBe(original);

      await service.deleteConversationSession(conversation, vaultPath);
      expect(fs.existsSync(historyPath)).toBe(true);
    } finally {
      if (previousHome === undefined) {
        delete process.env.GROK_HOME;
      } else {
        process.env.GROK_HOME = previousHome;
      }
    }
  });

  it('hydrates from providerState.grokHome even when process.env.GROK_HOME differs', async () => {
    const sessionId = 'session-state-home';
    const stateHome = path.join(tmpRoot, 'state-home');
    const processHome = path.join(tmpRoot, 'process-home');
    const historyPath = path.join(
      stateHome,
      'sessions',
      encodeURIComponent(vaultPath),
      sessionId,
      'chat_history.jsonl',
    );
    const wrongHistoryPath = path.join(
      processHome,
      'sessions',
      encodeURIComponent(vaultPath),
      sessionId,
      'chat_history.jsonl',
    );
    fs.mkdirSync(path.dirname(historyPath), { recursive: true });
    fs.mkdirSync(path.dirname(wrongHistoryPath), { recursive: true });
    fs.writeFileSync(historyPath, `${JSON.stringify({ type: 'user', content: 'From state home' })}\n`, 'utf-8');
    fs.writeFileSync(wrongHistoryPath, `${JSON.stringify({ type: 'user', content: 'From process home' })}\n`, 'utf-8');

    const conversation: Conversation = {
      id: 'conv-state',
      providerId: 'grok',
      title: 'Test',
      createdAt: 1_000,
      updatedAt: 1_000,
      messages: [],
      sessionId,
      providerState: { sessionId, grokHome: stateHome },
    };

    const previousHome = process.env.GROK_HOME;
    process.env.GROK_HOME = processHome;
    try {
      const service = new GrokConversationHistoryService();
      await service.hydrateConversationHistory(conversation, vaultPath);
      expect(conversation.messages.map((message) => message.content)).toEqual([
        'From state home',
      ]);
      expect(fs.readFileSync(historyPath, 'utf-8')).toContain('From state home');
    } finally {
      if (previousHome === undefined) {
        delete process.env.GROK_HOME;
      } else {
        process.env.GROK_HOME = previousHome;
      }
    }
  });

  it('falls back to settings GROK_HOME via pathContext when providerState has no grokHome', async () => {
    const sessionId = 'session-settings-home';
    const settingsHome = path.join(tmpRoot, 'settings-home');
    const historyPath = path.join(
      settingsHome,
      'sessions',
      encodeURIComponent(vaultPath),
      sessionId,
      'chat_history.jsonl',
    );
    fs.mkdirSync(path.dirname(historyPath), { recursive: true });
    fs.writeFileSync(historyPath, `${JSON.stringify({ type: 'user', content: 'From settings home' })}\n`, 'utf-8');

    const conversation: Conversation = {
      id: 'conv-settings',
      providerId: 'grok',
      title: 'Test',
      createdAt: 1_000,
      updatedAt: 1_000,
      messages: [],
      sessionId,
      providerState: { sessionId },
    };

    const previousHome = process.env.GROK_HOME;
    delete process.env.GROK_HOME;
    try {
      const service = new GrokConversationHistoryService();
      await service.hydrateConversationHistory(conversation, vaultPath, {
        environment: {},
        settings: {
          providerConfigs: {
            grok: {
              environmentVariables: `GROK_HOME=${settingsHome}`,
            },
          },
        },
      });
      expect(conversation.messages.map((message) => message.content)).toEqual([
        'From settings home',
      ]);
    } finally {
      if (previousHome === undefined) {
        delete process.env.GROK_HOME;
      } else {
        process.env.GROK_HOME = previousHome;
      }
    }
  });
});
