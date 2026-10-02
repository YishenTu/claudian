import { testDate } from '@test/helpers/testClock';

import type { ChatMessage } from '@/core/types';
import { formatSessionSnapshot } from '@/features/chat/session-mentions/formatSessionSnapshot';

const time = testDate().getTime();
const metadata = { id: 'conv-1-abc', title: 'Review', providerId: 'codex' as const, createdAt: time, lastActivityAt: time };
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
  expect(result).toBe(`# Review\n\nID: conv-1-abc\nProvider: codex\nCreated: ${new Date(time).toISOString()}\nUpdated: ${new Date(time).toISOString()}\n\n${expected}\n`);
});
