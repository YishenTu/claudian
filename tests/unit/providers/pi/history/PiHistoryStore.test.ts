import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { testDate, testTime } from '@test/helpers/testClock';

import {
  createPiForkSessionFile,
  getPiTurnStats,
  parsePiSessionContent,
  parsePiSessionEntries,
  type PiSessionEntry,
  resolvePiActivePath,
  rollbackCreatedPiForkSessionFile,
} from '@/providers/pi/history/PiHistoryStore';
import { encodePiRecoveryPrompt } from '@/providers/pi/history/PiRecoveryPromptCodec';

describe('PiHistoryStore', () => {
  it('parses linear user and assistant messages', () => {
    const content = [
      JSON.stringify({ type: 'session', id: 's1' }),
      JSON.stringify({ id: 'u1', type: 'entry', message: { role: 'user', content: 'Hello' } }),
      JSON.stringify({
        id: 'a1',
        type: 'entry',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', text: 'Thinking' },
            { type: 'text', text: 'Hi' },
          ],
        },
      }),
    ].join('\n');

    const messages = parsePiSessionContent(content);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      content: 'Hello',
      role: 'user',
      userMessageId: 'u1',
    });
    expect(messages[1]).toMatchObject({
      assistantMessageId: 'a1',
      content: 'Hi',
      contentBlocks: [
        { type: 'thinking', content: 'Thinking' },
        { type: 'text', content: 'Hi' },
      ],
      role: 'assistant',
    });
  });

  it('restores turn duration through tool calls using the final entry timestamp', () => {
    const content = [
      { type: 'message', id: 'u1', timestamp: testTime({ days: 11, hours: 10, milliseconds: 10 }),
        message: { role: 'user', timestamp: testDate({ days: 11, hours: 10 }).getTime(), content: 'Inspect' } },
      { type: 'message', id: 'a1', parentId: 'u1', timestamp: testTime({ days: 11, hours: 10, seconds: 4 }),
        message: { role: 'assistant', timestamp: testDate({ days: 11, hours: 10, milliseconds: 10 }).getTime(), stopReason: 'toolUse',
          content: [{ type: 'toolCall', id: 'read', name: 'read', arguments: { path: 'README.md' } }] } },
      { type: 'message', id: 'tr1', parentId: 'a1', timestamp: testTime({ days: 11, hours: 10, seconds: 5 }),
        message: { role: 'toolResult', toolCallId: 'read', content: [{ type: 'text', text: 'Details' }] } },
      { type: 'message', id: 'a2', parentId: 'tr1', timestamp: testTime({ days: 11, hours: 10, minutes: 1, seconds: 5, milliseconds: 900 }),
        message: { role: 'assistant', timestamp: testDate({ days: 11, hours: 10, seconds: 5 }).getTime(), stopReason: 'stop',
          content: [{ type: 'text', text: 'Complete.' }] } },
    ].map(entry => JSON.stringify(entry)).join('\n');

    expect(parsePiSessionContent(content)).toMatchObject([
      { role: 'user', content: 'Inspect' },
      { role: 'assistant', assistantMessageId: 'a2', content: 'Complete.', durationSeconds: 65, completedAt: Date.parse(testTime({ days: 11, hours: 10, minutes: 1, seconds: 5, milliseconds: 900 })) },
    ]);
    expect(parsePiSessionContent(content, { leafEntryId: 'a1' })[1].durationSeconds).toBeUndefined();
  });

  it.each([
    ['stop', testTime({ days: 11, hours: 10, milliseconds: 900 }), 0],
    ['length', testTime({ days: 11, hours: 10, seconds: 5 }), 5],
    ['aborted', testTime({ days: 11, hours: 10, seconds: 5 }), undefined],
    ['error', testTime({ days: 11, hours: 10, seconds: 5 }), undefined],
    ['toolUse', testTime({ days: 11, hours: 10, seconds: 5 }), undefined],
    ['stop', undefined, undefined],
    ['stop', 'invalid', undefined],
    ['stop', testTime({ days: 11, hours: 9, minutes: 59, seconds: 59 }), undefined],
  ])('restores only completed durations with valid timing (%s, %s)', (stopReason, timestamp, expected) => {
    const content = [
      { id: 'u1', type: 'message', timestamp: testTime({ days: 11, hours: 10 }),
        message: { role: 'user', content: 'Inspect' } },
      { id: 'a1', parentId: 'u1', type: 'message', timestamp,
        message: { role: 'assistant', timestamp: testDate({ days: 11, hours: 10, milliseconds: 10 }).getTime(), stopReason, content: 'Reply' } },
    ].map(entry => JSON.stringify(entry)).join('\n');

    expect(parsePiSessionContent(content)[1].durationSeconds).toBe(expected);
  });

  it('starts timing again at the next user prompt', () => {
    const content = [
      { id: 'u1', type: 'message', timestamp: testTime({ days: 11, hours: 10 }),
        message: { role: 'user', content: 'First' } },
      { id: 'a1', parentId: 'u1', type: 'message', timestamp: testTime({ days: 11, hours: 10, seconds: 5 }),
        message: { role: 'assistant', stopReason: 'stop', content: 'First reply' } },
      { id: 'u2', parentId: 'a1', type: 'message', timestamp: testTime({ days: 11, hours: 12 }),
        message: { role: 'user', content: 'Second' } },
      { id: 'a2', parentId: 'u2', type: 'message', timestamp: testTime({ days: 11, hours: 12, seconds: 3 }),
        message: { role: 'assistant', stopReason: 'stop', content: 'Second reply' } },
    ].map(entry => JSON.stringify(entry)).join('\n');

    expect(parsePiSessionContent(content).filter(message => message.role === 'assistant')).toMatchObject([
      { content: 'First reply', durationSeconds: 5 },
      { content: 'Second reply', durationSeconds: 3 },
    ]);
  });

  it('preserves hidden XML context wrappers in raw user content', () => {
    const content = [
      JSON.stringify({
        id: 'u1',
        type: 'entry',
        message: {
          role: 'user',
          content: 'Summarize this\n\n<current_note>\nnotes/today.md\n</current_note>',
        },
      }),
    ].join('\n');

    const messages = parsePiSessionContent(content);

    expect(messages[0]).toMatchObject({
      content: 'Summarize this\n\n<current_note>\nnotes/today.md\n</current_note>',
      role: 'user',
    });
    expect(messages[0].displayContent).toBeUndefined();
  });

  it.each([
    {
      displayContent: '/skill:commit-push',
      suffix: '',
    },
    {
      displayContent: '/skill:commit-push include untracked files',
      suffix: [
        '',
        '',
        'include untracked files',
        '',
        '<linked_note path="notes/release.md" />',
      ].join('\n'),
    },
  ])('restores $displayContent from Pi-expanded skill prompts', ({
    displayContent,
    suffix,
  }) => {
    const expandedPrompt = [
      '<skill name="commit-push" location="/Users/test/.agents/skills/commit-push/SKILL.md">',
      'References are relative to /Users/test/.agents/skills/commit-push.',
      '',
      'Commit all uncommitted changes, then push to remote.',
      '</skill>',
    ].join('\n') + suffix;
    const content = JSON.stringify({
      id: 'u1',
      type: 'message',
      message: {
        role: 'user',
        content: [{ type: 'text', text: expandedPrompt }],
      },
    });

    const messages = parsePiSessionContent(content);

    expect(messages[0]).toMatchObject({
      content: expandedPrompt,
      displayContent,
      role: 'user',
    });
  });

  it('rehydrates user image content parts', () => {
    const content = [
      JSON.stringify({
        id: 'u1',
        type: 'entry',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'What is in this image?' },
            {
              type: 'image',
              mimeType: 'image/png',
              data: 'aGVsbG8=',
            },
          ],
        },
      }),
    ].join('\n');

    const messages = parsePiSessionContent(content);

    expect(messages[0]).toMatchObject({
      content: 'What is in this image?',
      images: [{
        data: 'aGVsbG8=',
        id: 'pi-img-u1-0',
        mediaType: 'image/png',
        name: 'image-1.png',
        size: 5,
        source: 'paste',
      }],
      role: 'user',
    });
  });

  it('attaches tool results to the previous assistant tool call', () => {
    const content = [
      JSON.stringify({
        id: 'a1',
        type: 'entry',
        message: {
          role: 'assistant',
          content: [
            { id: 'tool-1', input: { path: 'a.md' }, name: 'read', type: 'toolCall' },
          ],
        },
      }),
      JSON.stringify({
        result: { content: [{ text: 'file contents', type: 'text' }] },
        toolCallId: 'tool-1',
        type: 'toolResult',
      }),
    ].join('\n');

    const messages = parsePiSessionContent(content);

    expect(messages[0].toolCalls).toEqual([{
      id: 'tool-1',
      input: { file_path: 'a.md', path: 'a.md' },
      name: 'Read',
      result: 'file contents',
      status: 'completed',
    }]);
  });

  it('attaches real Pi message-role tool results to shared renderer tool calls', () => {
    const content = [
      JSON.stringify({
        id: 'a1',
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { arguments: { path: 'a.md' }, id: 'tool-1', name: 'read', type: 'toolCall' },
          ],
        },
      }),
      JSON.stringify({
        id: 'tr1',
        parentId: 'a1',
        type: 'message',
        message: {
          content: [{ text: 'file contents', type: 'text' }],
          isError: false,
          role: 'toolResult',
          toolCallId: 'tool-1',
          toolName: 'read',
        },
      }),
    ].join('\n');

    const messages = parsePiSessionContent(content);

    expect(messages[0].toolCalls).toEqual([{
      id: 'tool-1',
      input: { file_path: 'a.md', path: 'a.md' },
      name: 'Read',
      result: 'file contents',
      status: 'completed',
    }]);
    expect(messages[0].contentBlocks).toEqual([{ toolId: 'tool-1', type: 'tool_use' }]);
  });

  it('rehydrates Pi web extension tools with shared renderer names', () => {
    const content = [
      JSON.stringify({
        id: 'assistant-web',
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            {
              arguments: { count: 5, query: 'provider protocol' },
              id: 'web-search-1',
              name: 'web_search',
              type: 'toolCall',
            },
            {
              arguments: { url: 'https://example.com/reference' },
              id: 'web-fetch-1',
              name: 'web_fetch',
              type: 'toolCall',
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'message',
        message: {
          content: [{ text: 'Search result', type: 'text' }],
          isError: false,
          role: 'toolResult',
          toolCallId: 'web-search-1',
          toolName: 'web_search',
        },
      }),
      JSON.stringify({
        type: 'message',
        message: {
          content: [{ text: 'Fetched page', type: 'text' }],
          isError: false,
          role: 'toolResult',
          toolCallId: 'web-fetch-1',
          toolName: 'web_fetch',
        },
      }),
    ].join('\n');

    const toolCalls = parsePiSessionContent(content)[0].toolCalls ?? [];

    expect(toolCalls).toEqual([
      expect.objectContaining({
        input: { count: 5, query: 'provider protocol' },
        name: 'WebSearch',
        result: 'Search result',
      }),
      expect.objectContaining({
        input: { url: 'https://example.com/reference' },
        name: 'WebFetch',
        result: 'Fetched page',
      }),
    ]);
  });

  it('merges Pi assistant continuations split by tool results into one chat message', () => {
    const content = [
      JSON.stringify({ id: 'u1', type: 'message', message: { role: 'user', content: 'Hide scrollbars' } }),
      JSON.stringify({
        id: 'a1',
        parentId: 'u1',
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Inspecting snippets' },
            { arguments: { path: '.obsidian' }, id: 'ls-1', name: 'ls', type: 'toolCall' },
            { arguments: { path: '.obsidian/snippets' }, id: 'ls-2', name: 'ls', type: 'toolCall' },
          ],
        },
      }),
      JSON.stringify({
        id: 'tr1',
        parentId: 'a1',
        type: 'message',
        message: {
          content: [{ text: 'appearance.json\nsnippets/', type: 'text' }],
          isError: false,
          role: 'toolResult',
          toolCallId: 'ls-1',
          toolName: 'ls',
        },
      }),
      JSON.stringify({
        id: 'tr2',
        parentId: 'tr1',
        type: 'message',
        message: {
          content: [{ text: 'existing.css', type: 'text' }],
          isError: false,
          role: 'toolResult',
          toolCallId: 'ls-2',
          toolName: 'ls',
        },
      }),
      JSON.stringify({
        id: 'a2',
        parentId: 'tr2',
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { arguments: { path: '.obsidian/appearance.json' }, id: 'read-1', name: 'read', type: 'toolCall' },
          ],
        },
      }),
      JSON.stringify({
        id: 'tr3',
        parentId: 'a2',
        type: 'message',
        message: {
          content: [{ text: '{"enabledCssSnippets":[]}', type: 'text' }],
          isError: false,
          role: 'toolResult',
          toolCallId: 'read-1',
          toolName: 'read',
        },
      }),
      JSON.stringify({
        id: 'a3',
        parentId: 'tr3',
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Creating snippet' },
            { arguments: { path: '.obsidian/snippets/hide-scrollbars.css', content: 'css' }, id: 'write-1', name: 'write', type: 'toolCall' },
          ],
        },
      }),
      JSON.stringify({
        id: 'tr4',
        parentId: 'a3',
        type: 'message',
        message: {
          content: [{ text: 'Successfully wrote file', type: 'text' }],
          isError: false,
          role: 'toolResult',
          toolCallId: 'write-1',
          toolName: 'write',
        },
      }),
      JSON.stringify({
        id: 'a4',
        parentId: 'tr4',
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Done.' }],
        },
      }),
    ].join('\n');

    const messages = parsePiSessionContent(content);

    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      assistantMessageId: 'a4',
      content: 'Done.',
      role: 'assistant',
    });
    expect(messages[1].contentBlocks).toEqual([
      { type: 'thinking', content: 'Inspecting snippets' },
      { type: 'tool_use', toolId: 'ls-1' },
      { type: 'tool_use', toolId: 'ls-2' },
      { type: 'tool_use', toolId: 'read-1' },
      { type: 'thinking', content: 'Creating snippet' },
      { type: 'tool_use', toolId: 'write-1' },
      { type: 'text', content: 'Done.' },
    ]);
    expect(messages[1].toolCalls?.map(toolCall => ({
      id: toolCall.id,
      result: toolCall.result,
      status: toolCall.status,
    }))).toEqual([
      { id: 'ls-1', result: 'appearance.json\nsnippets/', status: 'completed' },
      { id: 'ls-2', result: 'existing.css', status: 'completed' },
      { id: 'read-1', result: '{"enabledCssSnippets":[]}', status: 'completed' },
      { id: 'write-1', result: 'Successfully wrote file', status: 'completed' },
    ]);
  });

  it('hydrates Pi write/edit tool calls with diff data for stored rendering', () => {
    const content = [
      JSON.stringify({
        id: 'a1',
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            {
              arguments: {
                edits: [{ oldText: 'old', newText: 'new' }],
                path: 'notes/a.md',
              },
              id: 'edit-1',
              name: 'edit',
              type: 'toolCall',
            },
          ],
        },
      }),
      JSON.stringify({
        id: 'tr1',
        parentId: 'a1',
        type: 'message',
        message: {
          content: [{ text: 'Edited notes/a.md', type: 'text' }],
          details: {
            diff: '--- a/notes/a.md\n+++ b/notes/a.md\n@@ -1 +1 @@\n-old\n+new',
          },
          isError: false,
          role: 'toolResult',
          toolCallId: 'edit-1',
          toolName: 'edit',
        },
      }),
    ].join('\n');

    const messages = parsePiSessionContent(content);

    expect(messages[0].toolCalls?.[0]).toMatchObject({
      id: 'edit-1',
      input: {
        edits: [{ oldText: 'old', newText: 'new' }],
        file_path: 'notes/a.md',
        path: 'notes/a.md',
      },
      name: 'Edit',
      result: 'Edited notes/a.md',
      status: 'completed',
    });
    expect(messages[0].toolCalls?.[0].diffData).toMatchObject({
      filePath: 'notes/a.md',
      stats: { added: 1, removed: 1 },
    });
    expect(messages[0].toolCalls?.[0].diffData?.diffLines.map(line => line.text)).toEqual(['old', 'new']);
  });

  it('resolves only the active branch path', () => {
    const entries: PiSessionEntry[] = [
      { id: 'root', raw: {}, type: 'entry' },
      { id: 'left', parentId: 'root', raw: {}, type: 'entry' },
      { id: 'right', parentId: 'root', raw: {}, type: 'entry' },
    ];

    expect(resolvePiActivePath(entries, 'left').map(entry => entry.id)).toEqual(['root', 'left']);
    expect(resolvePiActivePath(entries).map(entry => entry.id)).toEqual(['root', 'right']);
  });

  it('keeps id-less tool results attached to the active branch', () => {
    const content = [
      JSON.stringify({
        id: 'root',
        type: 'entry',
        message: { role: 'user', content: 'Read the active file' },
      }),
      JSON.stringify({
        id: 'left',
        parentId: 'root',
        type: 'entry',
        message: {
          role: 'assistant',
          content: [
            { id: 'tool-left', input: { path: 'left.md' }, name: 'read', type: 'toolCall' },
          ],
        },
      }),
      JSON.stringify({
        result: { content: [{ text: 'left contents', type: 'text' }] },
        toolCallId: 'tool-left',
        type: 'toolResult',
      }),
      JSON.stringify({
        id: 'right',
        parentId: 'root',
        type: 'entry',
        message: {
          role: 'assistant',
          content: [
            { id: 'tool-right', input: { path: 'right.md' }, name: 'read', type: 'toolCall' },
          ],
        },
      }),
      JSON.stringify({
        result: { content: [{ text: 'right contents', type: 'text' }] },
        toolCallId: 'tool-right',
        type: 'toolResult',
      }),
    ].join('\n');

    const messages = parsePiSessionContent(content, { leafEntryId: 'left' });

    expect(messages[1].toolCalls).toEqual([{
      id: 'tool-left',
      input: { file_path: 'left.md', path: 'left.md' },
      name: 'Read',
      result: 'left contents',
      status: 'completed',
    }]);
  });

  it('truncates linear Pi sessions through the requested checkpoint', () => {
    const content = [
      JSON.stringify({ id: 'u1', type: 'message', message: { role: 'user', content: 'First' } }),
      JSON.stringify({ id: 'a1', type: 'message', message: { role: 'assistant', content: 'Done' } }),
      JSON.stringify({ id: 'u2', type: 'message', message: { role: 'user', content: 'Later' } }),
      JSON.stringify({ id: 'a2', type: 'message', message: { role: 'assistant', content: 'Do not include' } }),
    ].join('\n');
    expect(parsePiSessionContent(content, { leafEntryId: 'a1' }).map(message => message.content)).toEqual([
      'First',
      'Done',
    ]);
  });

  it('keeps id-less trailing entries during normal linear hydration', () => {
    const content = [
      JSON.stringify({ id: 'u1', type: 'message', message: { role: 'user', content: 'First' } }),
      JSON.stringify({ id: 'a1', type: 'message', message: { role: 'assistant', content: 'Done' } }),
      JSON.stringify({ type: 'custom_message', content: 'Trailing notice' }),
    ].join('\n');

    expect(parsePiSessionContent(content).map(message => message.content)).toEqual([
      'First',
      'Done',
      'Trailing notice',
    ]);
    expect(parsePiSessionContent(content, { leafEntryId: 'a1' }).map(message => message.content)).toEqual([
      'First',
      'Done',
    ]);
  });

  it('creates a self-contained Pi fork session file at the assistant checkpoint', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-fork-'));
    const sourceFile = path.join(dir, 'source.jsonl');
    await fs.writeFile(sourceFile, [
      JSON.stringify({ type: 'session', version: 3, id: 'source-session', timestamp: testTime({ days: -238 }), cwd: '/source-cwd' }),
      JSON.stringify({ id: 'u1', parentId: null, type: 'message', message: { role: 'user', content: 'First' } }),
      JSON.stringify({ id: 'a1', parentId: 'u1', type: 'message', message: { role: 'assistant', content: 'Done' } }),
      JSON.stringify({ id: 'u2', parentId: 'a1', type: 'message', message: { role: 'user', content: 'Do not copy' } }),
    ].join('\n'));

    const forked = await createPiForkSessionFile(sourceFile, 'a1', {
      now: testDate({ days: -205, hours: 4, minutes: 5, seconds: 6, milliseconds: 789 }),
      sessionId: 'fork-session',
      targetCwd: '/target-cwd',
    });
    const forkedContent = await fs.readFile(forked.sessionFile, 'utf-8');
    const forkedLines = forkedContent.trim().split('\n').map(line => JSON.parse(line));

    expect(forked).toEqual({
      leafEntryId: 'a1',
      parentSession: sourceFile,
      sessionFile: path.join(dir, `${testTime({ days: -205, hours: 4, minutes: 5, seconds: 6, milliseconds: 789 }).replace(/[:.]/g, '-')}_fork-session.jsonl`),
      sessionId: 'fork-session',
    });
    expect(forkedLines).toEqual([
      {
        cwd: '/target-cwd',
        id: 'fork-session',
        parentSession: sourceFile,
        timestamp: testTime({ days: -205, hours: 4, minutes: 5, seconds: 6, milliseconds: 789 }),
        type: 'session',
        version: 3,
      },
      { id: 'u1', parentId: null, type: 'message', message: { role: 'user', content: 'First' } },
      { id: 'a1', parentId: 'u1', type: 'message', message: { role: 'assistant', content: 'Done' } },
    ]);
  });

  it('rolls back only the exact newly created fork target and joins duplicate cleanup', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-fork-rollback-'));
    const sourceFile = path.join(dir, 'source.jsonl');
    await fs.writeFile(sourceFile, [
      JSON.stringify({ id: 'source', type: 'session', version: 3 }),
      JSON.stringify({ id: 'a1', type: 'message', message: { role: 'assistant', content: 'Done' } }),
    ].join('\n'));
    const forked = await createPiForkSessionFile(sourceFile, 'a1', {
      sessionId: 'fork-session',
    });
    const createdTarget = forked.sessionFile;

    forked.sessionFile = sourceFile;
    forked.parentSession = createdTarget;
    await Promise.all([
      rollbackCreatedPiForkSessionFile(forked),
      rollbackCreatedPiForkSessionFile(forked),
    ]);

    await expect(fs.access(sourceFile)).resolves.toBeUndefined();
    await expect(fs.access(createdTarget)).rejects.toThrow();
    await expect(rollbackCreatedPiForkSessionFile(forked)).rejects.toThrow(
      'not owned by this process',
    );
    await fs.rm(dir, { force: true, recursive: true });
  });

  it('includes active id-less tool results when creating linear Pi fork files', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-fork-linear-'));
    const sourceFile = path.join(dir, 'source.jsonl');
    await fs.writeFile(sourceFile, [
      JSON.stringify({ type: 'session', version: 3, id: 'source-session', timestamp: testTime({ days: -238 }), cwd: '/source-cwd' }),
      JSON.stringify({ id: 'u1', type: 'message', message: { role: 'user', content: 'Read a file' } }),
      JSON.stringify({
        id: 'a1',
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { id: 'tool-1', input: { path: 'a.md' }, name: 'read', type: 'toolCall' },
          ],
        },
      }),
      JSON.stringify({
        result: { content: [{ text: 'file contents', type: 'text' }] },
        toolCallId: 'tool-1',
        type: 'toolResult',
      }),
      JSON.stringify({ id: 'u2', type: 'message', message: { role: 'user', content: 'Do not copy' } }),
    ].join('\n'));

    const forked = await createPiForkSessionFile(sourceFile, 'a1', {
      now: testDate({ days: -205, hours: 4, minutes: 5, seconds: 6, milliseconds: 789 }),
      sessionId: 'fork-session',
    });
    const forkedContent = await fs.readFile(forked.sessionFile, 'utf-8');
    const forkedLines = forkedContent.trim().split('\n').map(line => JSON.parse(line));

    expect(forkedLines.map(line => line.id)).toEqual(['fork-session', 'u1', 'a1', undefined]);
    expect(forkedLines[3]).toMatchObject({
      toolCallId: 'tool-1',
      type: 'toolResult',
    });
    expect(parsePiSessionContent(forkedContent)[1].toolCalls).toEqual([{
      id: 'tool-1',
      input: { file_path: 'a.md', path: 'a.md' },
      name: 'Read',
      result: 'file contents',
      status: 'completed',
    }]);
  });

  it('ignores malformed lines and maps compaction boundaries', () => {
    const content = [
      'not-json',
      JSON.stringify({ id: 'c1', type: 'compaction' }),
    ].join('\n');

    expect(parsePiSessionContent(content)[0].contentBlocks).toEqual([{ type: 'context_compacted' }]);
  });
});

it.each([false, true])('restores Pi turn output across tool loops (missing usage: %s)', (missing) => {
  const content = [
    { type: 'session', id: 'session' },
    { type: 'message', id: 'u', parentId: null, timestamp: testTime({ days: 24, hours: 11, milliseconds: 10 }),
      message: { role: 'user', content: 'Work', timestamp: Date.parse(testTime({ days: 24, hours: 11 })) } },
    { type: 'message', id: 'a', parentId: 'u', timestamp: testTime({ days: 24, hours: 11, seconds: 1 }),
      message: { role: 'assistant', stopReason: 'toolUse', usage: missing ? undefined : { output: 100 },
        content: [{ type: 'toolCall', id: 'tool', name: 'read', arguments: {} }] } },
    { type: 'message', id: 'r', parentId: 'a', timestamp: testTime({ days: 24, hours: 11, seconds: 2 }),
      message: { role: 'toolResult', toolCallId: 'tool', content: [{ type: 'text', text: 'Result' }] } },
    { type: 'message', id: 'final', parentId: 'r', timestamp: testTime({ days: 24, hours: 11, seconds: 2, milliseconds: 500 }),
      message: { role: 'assistant', stopReason: 'stop', usage: { output: 25 },
        timestamp: Date.parse(testTime({ days: 24, hours: 11, seconds: 2 })), content: [{ type: 'text', text: 'Done' }] } },
  ].map(entry => JSON.stringify(entry)).join('\n');
  expect(parsePiSessionContent(content).at(-1)?.turnStats).toEqual(missing ? undefined : { outputTokens: 125, durationMs: 2500 });
});


it('keeps live and replay stats unavailable for a hidden recovery-only input', () => {
  const content = [
    { type: 'message', id: 'recovery', timestamp: testTime({ days: 24, hours: 11 }),
      message: { role: 'user', content: encodePiRecoveryPrompt('User: Previous question', null) } },
    { type: 'message', id: 'answer', parentId: 'recovery', timestamp: testTime({ days: 24, hours: 11, seconds: 2, milliseconds: 500 }),
      message: { role: 'assistant', content: 'Answer', stopReason: 'stop', usage: { output: 125 } } },
  ].map(record => JSON.stringify(record)).join('\n');
  const entries = resolvePiActivePath(parsePiSessionEntries(content).entries);
  expect(getPiTurnStats(entries, 'answer')).toBeUndefined();
  expect(parsePiSessionContent(content).at(-1)?.turnStats).toBeUndefined();
});
