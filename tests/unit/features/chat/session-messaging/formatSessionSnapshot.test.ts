import { testDate } from '@test/helpers/testClock';

import type { ChatMessage } from '@/core/types';
import { formatSessionSnapshot } from '@/features/chat/session-messaging/formatSessionSnapshot';

const time = testDate().getTime();
const metadata = { id: 'conv-1-abc', title: 'Review', providerId: 'codex' as const, createdAt: time, lastActivityAt: time };
const header = `# Review\n\nID: conv-1-abc\nProvider: codex\nCreated: ${new Date(time).toISOString()}\nUpdated: ${new Date(time).toISOString()}`;
const user = (content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id: 'u', role: 'user', content, timestamp: time, ...extra });
const assistant = (extra: Partial<ChatMessage> = {}): ChatMessage => ({ id: 'a', role: 'assistant', content: '', timestamp: time, ...extra });

it.each([
  ['tool only', [user('go'), assistant({ contentBlocks: [{ type: 'tool_use', toolId: 't' }] })], false, '## T1 user\ngo\n\n## T1 assistant\n(no reply)'],
  ['interrupt', [user('go'), assistant({ isInterrupt: true })], false, '## T1 user\ngo\n\n## T1 assistant\n(interrupted)'],
  ['error', [user('go'), assistant({ toolCalls: [{ id: 't', name: 'Read', input: {}, status: 'error' }] })], false, '## T1 user\ngo\n\n## T1 assistant\n(error)'],
  ['automatic response', [user('go'), assistant({ content: 'first' }), assistant({ content: 'later', isAutomaticResponse: true })], false, '## T1 user\ngo\n\n## T1 assistant\nfirst\n\nlater'],
  ['compacted context', [user('hidden', { isRebuiltContext: true }), user('go'), assistant({ contentBlocks: [{ type: 'context_compacted' }, { type: 'text', content: 'final' }] })], false, '## T1 user\ngo\n\n## T1 assistant\nfinal'],
  ['verbatim nested prompt', [user('transport', { displayContent: '  ref @"Nested"\n```x```  ' }), assistant({ content: 'done' })], false, '## T1 user\n  ref @"Nested"\n```x```  \n\n## T1 assistant\ndone'],
  ['preparing after completed turn', [user('go'), assistant({ content: 'done', completedAt: time })], true, '## T1 user\ngo\n\n## T1 assistant\ndone'],
  ['running tail', [user('go'), assistant({ content: 'done' }), user('pending'), assistant({ content: 'partial' })], true, '## T1 user\ngo\n\n## T1 assistant\ndone'],
] as const)('formats %s', (_label, messages, running, expected) => {
  const result = formatSessionSnapshot(metadata, [...messages], running);
  expect(result).toEqual({ content: `${header}\n\n${expected}\n`, fromTurn: 1, toTurn: 1, totalTurns: 1 });
});

describe('paging', () => {
  const turn = (n: number) => `## T${n} user\nq${n}\n\n## T${n} assistant\na${n}`;
  const messages = [1, 2, 3].flatMap(n => [user(`q${n}`), assistant({ content: `a${n}` })]);
  const budget = turn(2).length + turn(3).length + 2;

  it('returns the latest turns that fit the budget, keeping their session numbers', () => {
    expect(formatSessionSnapshot(metadata, messages, false, { maxChars: budget })).toEqual({
      content: `${header}\n\n${turn(2)}\n\n${turn(3)}\n`, fromTurn: 2, toTurn: 3, totalTurns: 3,
    });
  });

  it('pages back before a turn', () => {
    expect(formatSessionSnapshot(metadata, messages, false, { maxChars: budget, beforeTurn: 2 })).toEqual({
      content: `${header}\n\n${turn(1)}\n`, fromTurn: 1, toTurn: 1, totalTurns: 3,
    });
  });

  it('truncates a single turn that alone exceeds the budget', () => {
    const long = [user('q1'), assistant({ content: 'x'.repeat(100) })];
    const result = formatSessionSnapshot(metadata, long, false, { maxChars: 40 });
    expect(result).toMatchObject({ fromTurn: 1, toTurn: 1, totalTurns: 1 });
    expect(result.content).toBe(`${header}\n\n${'## T1 user\nq1\n\n## T1 assistant\nxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'.slice(0, 40)}\n(truncated)\n`);
  });

  it.each([
    ['an empty session', [] as ChatMessage[], undefined],
    ['nothing before the first turn', messages, 1],
  ])('returns only the header for %s', (_label, source, beforeTurn) => {
    expect(formatSessionSnapshot(metadata, source, false, { beforeTurn })).toEqual({
      content: `${header}\n`, fromTurn: 0, toTurn: 0, totalTurns: source.length / 2,
    });
  });
});
