import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  KimiConversationHistoryService,
  loadKimiHistoryMessages,
} from '@/providers/kimi/history/KimiConversationHistoryService';

describe('KimiConversationHistoryService', () => {
  it('preserves session state and never deletes native data', async () => {
    const service = new KimiConversationHistoryService();
    const conversation = {
      id: 'c1',
      providerId: 'kimi',
      sessionId: 'sess-1',
      providerState: { sessionId: 'sess-1', kimiCodeHome: '/tmp/kimi-home' },
      messages: [],
    } as any;

    await service.deleteConversationSession(conversation, '/vault');
    expect(conversation.sessionId).toBe('sess-1');

    const persisted = service.buildPersistedProviderState(conversation);
    expect(persisted).toEqual({
      sessionId: 'sess-1',
      kimiCodeHome: '/tmp/kimi-home',
    });
    expect(service.resolveSessionIdForConversation(conversation)).toBe('sess-1');
  });

  it('loads user and streamed assistant messages from Kimi AgentRecord wire lines', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hist-'));
    const file = path.join(dir, 'wire.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify({
        type: 'context.append_message',
        time: 1100,
        message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      }),
      JSON.stringify({
        type: 'context.append_loop_event',
        time: 1200,
        event: { type: 'step.begin', uuid: 'step-1' },
      }),
      JSON.stringify({
        type: 'context.append_loop_event',
        time: 1201,
        event: {
          type: 'content.part',
          stepUuid: 'step-1',
          part: { type: 'text', text: 'hel' },
        },
      }),
      JSON.stringify({
        type: 'context.append_loop_event',
        time: 1202,
        event: {
          type: 'content.part',
          stepUuid: 'step-1',
          part: { type: 'text', text: 'lo' },
        },
      }),
      JSON.stringify({
        type: 'context.append_loop_event',
        time: 1203,
        event: { type: 'step.end', stepUuid: 'step-1' },
      }),
      JSON.stringify({ type: 'noise' }),
    ].join('\n'), 'utf-8');

    const messages = loadKimiHistoryMessages(file, 'sess-1', 1000);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toBe('hi');
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].content).toBe('hello');
    expect(messages[0].timestamp).toBe(1100);
    expect(messages[1].timestamp).toBe(1200);
  });

  it('ignores compaction summaries, injections, and tool messages', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hist-filter-'));
    const file = path.join(dir, 'wire.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify({
        type: 'context.append_message',
        message: {
          role: 'user',
          origin: { kind: 'compaction_summary' },
          content: [{ type: 'text', text: 'summary' }],
        },
      }),
      JSON.stringify({
        type: 'context.append_message',
        message: {
          role: 'user',
          origin: { kind: 'injection' },
          content: [{ type: 'text', text: 'injected' }],
        },
      }),
      JSON.stringify({
        type: 'context.append_message',
        message: { role: 'tool', content: [{ type: 'text', text: 'tool output' }] },
      }),
    ].join('\n'), 'utf-8');

    expect(loadKimiHistoryMessages(file, 'sess-1', 1000)).toEqual([]);
  });
});
