import { testDate } from '@test/helpers/testClock';

import type { StreamChunk } from '@/core/types';
import { parseCodexSessionTurns } from '@/providers/codex/history/CodexHistoryStore';
import { CodexNotificationRouter } from '@/providers/codex/runtime/CodexNotificationRouter';

const examples = [
  { name: 'inline code', parts: ['Explain `<image></image>`; keep the literal tag.'],
    cold: 'Explain `<image></image>`; keep the literal tag.', live: 'Explain `<image></image>`; keep the literal tag.' },
  { name: 'backtick fence', parts: ['Example:\n```xml\n<image></image>\n```\nExplain it.'],
    cold: 'Example:\n```xml\n<image></image>\n```\nExplain it.', live: null },
  { name: 'tilde fence', parts: ['Example:\n~~~xml\n<image></image>\n~~~\nExplain it.'],
    cold: 'Example:\n~~~xml\n<image></image>\n~~~\nExplain it.', live: null },
  { name: 'indented code', parts: ['Example:\n\n    <image></image>\n\nExplain it.'],
    cold: 'Example:\n\n    <image></image>\n\nExplain it.', live: null },
  { name: 'generated placeholder before indented code', parts: ['Attachment <image></image>\n\n    <image></image>\n\nExplain the code.'],
    cold: 'Attachment \n\n    <image></image>\n\nExplain the code.', live: 'Attachment \n\n    <image></image>\n\nExplain the code.' },
  { name: 'placeholder part carrying code indentation', parts: ['Attachment ', '<image></image>\n\n    ', '<image></image>\n\nExplain the code.'],
    cold: 'Attachment \n\n    <image></image>\n\nExplain the code.', live: null },
  { name: 'leading indented code and explanation', parts: ['    <image></image>\n\nExplain the code.'],
    cold: '    <image></image>\n\nExplain the code.', live: '    <image></image>\n\nExplain the code.' },
  { name: 'indented code only', parts: ['    <image></image>'],
    cold: '    <image></image>', live: '    <image></image>' },
  { name: 'indented code after actual metadata', parts: ['<environment_context>\n<cwd>/workspace</cwd>\n</environment_context>\n\n    <image></image>\n\nExplain the code.'],
    cold: '    <image></image>\n\nExplain the code.', live: '    <image></image>\n\nExplain the code.' },
  { name: 'ordinary trimming after indented actual metadata', parts: [' \n    <environment_context>generated</environment_context>\n\n  Explain the attachment. \n'],
    cold: 'Explain the attachment.', live: null },
  { name: 'multipart fence', parts: ['Example:\n```xml\n', '<image></image>', '\n```\nExplain it.'],
    cold: 'Example:\n```xml\n<image></image>\n```\nExplain it.', live: 'Example:\n```xml\n\n\n<image></image>\n\n\n```\nExplain it.' },
  { name: 'multipart inline code', parts: ['Explain `', '<image></image>', '`; keep it.'],
    cold: 'Explain `<image></image>`; keep it.', live: null },
  { name: 'code alongside generated attachments', parts: ['Keep `<image></image>`.', '<image name=[Image #1]>', '</image>', 'Explain the attachment.'],
    cold: 'Keep `<image></image>`.Explain the attachment.', live: 'Keep `<image></image>`.\n\nExplain the attachment.' },
];

describe.each(['cold history', 'live notification'] as const)('Codex image literals in %s', consumer => {
  it.each(examples.filter(example => consumer === 'cold history' || example.live !== null))('preserves $name', ({ parts, cold, live }) => {
    let actual: unknown;
    const expected = consumer === 'cold history' ? cold : live;
    if (consumer === 'cold history') {
      const records = [{ type: 'response_item', timestamp: testDate().toISOString(), payload: {
        type: 'message', role: 'user', content: parts.map(text => ({ type: 'input_text', text })),
      } }];
      const messages = parseCodexSessionTurns(records.map(record => JSON.stringify(record)).join('\n'))
        .flatMap(turn => turn.messages);
      actual = messages.filter(message => message.role === 'user').map(message => message.content);
    } else {
      const chunks: StreamChunk[] = [];
      const router = new CodexNotificationRouter(chunk => chunks.push(chunk), '/workspace');
      router.handleNotification('item/started', { item: {
        type: 'userMessage', id: 'user-image-example', content: parts.flatMap(text =>
          text === '<image name=[Image #1]>'
            ? [{ type: 'text', text }, { type: 'localImage', path: '/temporary/demo.png' }]
            : [{ type: 'text', text }]),
      } });
      actual = chunks.map(chunk => chunk.type === 'user_message_start' ? chunk.content : chunk);
    }
    expect(actual).toEqual([expected]);
  });
});

it('preserves leading image code through the cold user_message event producer', () => {
  const records = [{ type: 'event_msg', timestamp: testDate().toISOString(), payload: {
    type: 'user_message', message: '    <image></image>\n\nExplain the code.',
  } }];
  const messages = parseCodexSessionTurns(records.map(record => JSON.stringify(record)).join('\n'))
    .flatMap(turn => turn.messages);
  expect(messages.filter(message => message.role === 'user').map(message => message.content))
    .toEqual(['    <image></image>\n\nExplain the code.']);
});
