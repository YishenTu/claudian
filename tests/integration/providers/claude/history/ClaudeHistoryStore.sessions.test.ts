import * as path from 'node:path';

import { useClaudeSessionFiles } from '@test/helpers/providers/claudeHistory';
import { testTime } from '@test/helpers/testClock';

import { readSDKSessionFile } from '@/providers/claude/history/ClaudeHistoryPathResolver';
import { encodeVaultPathForSDK, loadSDKSessionMessages } from '@/providers/claude/history/ClaudeHistoryStore';

const writeSessionFile = useClaudeSessionFiles();
const vaultPath = '/vault';

// Native JSONL bytes cross the real reader, branch filter, tool merge and history projection.
describe('Claude native history replay', () => {
  it('loads and converts all messages from session file', async () => {
      const sessionPath = writeSessionFile([
        `{"type":"user","uuid":"u1","timestamp":"${testTime({ milliseconds: 0 })}","message":{"content":"Hello"}}`,
        `{"type":"assistant","uuid":"a1","timestamp":"${testTime({ milliseconds: 60000 })}","message":{"content":[{"type":"text","text":"Hi!"}]}}`,
        '{"type":"system","uuid":"s1"}',
        `{"type":"user","uuid":"u2","timestamp":"${testTime({ milliseconds: 120000 })}","message":{"content":"Thanks"}}`,
      ].join('\n'));

      const result = await loadSDKSessionMessages(vaultPath, 'session-full', undefined, sessionPath);

      // Should have 3 messages (system skipped)
      expect(result.messages).toHaveLength(3);
      expect(result.messages[0].role).toBe('user');
      expect(result.messages[0].content).toBe('Hello');
      expect(result.messages[1].role).toBe('assistant');
      expect(result.messages[1].content).toBe('Hi!');
      expect(result.messages[2].role).toBe('user');
      expect(result.messages[2].content).toBe('Thanks');
    });

  it('restores response duration from Claude turn metadata', async () => {
      const sessionPath = writeSessionFile([
        `{"type":"user","uuid":"u1","timestamp":"${testTime({ milliseconds: 0 })}","message":{"content":"Inspect the project"}}`,
        `{"type":"assistant","uuid":"a1","timestamp":"${testTime({ milliseconds: 2000 })}","message":{"content":[{"type":"tool_use","id":"tool-1","name":"Read","input":{"file_path":"README.md"}}]}}`,
        `{"type":"user","uuid":"tool-result-1","timestamp":"${testTime({ milliseconds: 3000 })}","toolUseResult":{},"message":{"content":[{"type":"tool_result","tool_use_id":"tool-1","content":"Project details"}]}}`,
        `{"type":"assistant","uuid":"a2","timestamp":"${testTime({ milliseconds: 9000 })}","message":{"content":[{"type":"text","text":"Inspection complete."}]}}`,
        `{"type":"system","subtype":"turn_duration","uuid":"duration-1","parentUuid":"a2","timestamp":"${testTime({ milliseconds: 9100 })}","durationMs":4500,"messageCount":4}`,
      ].join('\n'));

      const result = await loadSDKSessionMessages(vaultPath, 'session-native-duration', undefined, sessionPath);

      expect(result.messages).toHaveLength(2);
      expect(result.messages[1]).toMatchObject({
        role: 'assistant',
        content: 'Inspection complete.',
        durationSeconds: 4,
      });
    });

  it('resolves response duration through an intermediary stop hook record', async () => {
      const sessionPath = writeSessionFile([
        `{"type":"user","uuid":"u1","timestamp":"${testTime({ milliseconds: 0 })}","message":{"content":"Inspect the project"}}`,
        `{"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"${testTime({ milliseconds: 4000 })}","message":{"content":[{"type":"text","text":"Inspection complete."}]}}`,
        `{"type":"system","subtype":"stop_hook_summary","uuid":"stop-1","parentUuid":"a1","timestamp":"${testTime({ milliseconds: 4050 })}"}`,
        `{"type":"system","subtype":"turn_duration","uuid":"duration-1","parentUuid":"stop-1","timestamp":"${testTime({ milliseconds: 4100 })}","durationMs":4500}`,
      ].join('\n'));

      const result = await loadSDKSessionMessages(vaultPath, 'session-stop-hook-duration', undefined, sessionPath);

      expect(result.messages[1]).toMatchObject({
        role: 'assistant',
        content: 'Inspection complete.',
        durationSeconds: 4,
      });
    });

  it('restores checkpoint duration from metadata beyond resume truncation', async () => {
      const sessionPath = writeSessionFile([
        `{"type":"user","uuid":"u1","timestamp":"${testTime({ milliseconds: 0 })}","message":{"content":"First turn"}}`,
        `{"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"${testTime({ milliseconds: 4000 })}","message":{"content":[{"type":"text","text":"First response"}]}}`,
        `{"type":"system","subtype":"turn_duration","uuid":"duration-1","parentUuid":"a1","timestamp":"${testTime({ milliseconds: 4100 })}","durationMs":4500}`,
        `{"type":"user","uuid":"u2","parentUuid":"duration-1","timestamp":"${testTime({ milliseconds: 5000 })}","message":{"content":"Later turn"}}`,
        `{"type":"assistant","uuid":"a2","parentUuid":"u2","timestamp":"${testTime({ milliseconds: 8000 })}","message":{"content":[{"type":"text","text":"Later response"}]}}`,
      ].join('\n'));

      const result = await loadSDKSessionMessages(vaultPath, 'session-checkpoint-duration', 'a1', sessionPath);

      expect(result.messages).toHaveLength(2);
      expect(result.messages[1]).toMatchObject({
        role: 'assistant',
        content: 'First response',
        durationSeconds: 4,
      });
    });

  it('preserves response duration before rebuilt history context', async () => {
      const sessionPath = writeSessionFile([
        `{"type":"user","uuid":"u1","timestamp":"${testTime({ milliseconds: 0 })}","message":{"content":"First turn"}}`,
        `{"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"${testTime({ milliseconds: 4000 })}","message":{"content":[{"type":"text","text":"First response"}]}}`,
        `{"type":"system","subtype":"turn_duration","uuid":"duration-1","parentUuid":"a1","timestamp":"${testTime({ milliseconds: 4100 })}","durationMs":4500}`,
        `{"type":"user","uuid":"replay-1","parentUuid":"duration-1","timestamp":"${testTime({ milliseconds: 5000 })}","message":{"content":"User: Earlier question\\n\\nAssistant: Earlier response\\n\\nUser: Continue"}}`,
      ].join('\n'));

      const result = await loadSDKSessionMessages(vaultPath, 'session-rebuilt-context', undefined, sessionPath);

      expect(result.messages[1]).toMatchObject({
        role: 'assistant',
        content: 'First response',
        durationSeconds: 4,
      });
      expect(result.messages[2]).toMatchObject({
        role: 'user',
        isRebuiltContext: true,
      });
    });

  it('treats a sub-second native turn duration as authoritative', async () => {
      const sessionPath = writeSessionFile([
        `{"type":"user","uuid":"u1","timestamp":"${testTime({ milliseconds: 0 })}","message":{"content":"Quick check"}}`,
        `{"type":"assistant","uuid":"a1","timestamp":"${testTime({ milliseconds: 3000 })}","message":{"content":[{"type":"text","text":"Done."}]}}`,
        `{"type":"system","subtype":"turn_duration","uuid":"duration-1","parentUuid":"a1","timestamp":"${testTime({ milliseconds: 3100 })}","durationMs":681}`,
      ].join('\n'));

      const result = await loadSDKSessionMessages(vaultPath, 'session-subsecond-duration', undefined, sessionPath);

      expect(result.messages[1].durationSeconds).toBe(0);
    });

  it('infers response duration from transcript timestamps when native metadata is absent', async () => {
      const sessionPath = writeSessionFile([
        `{"type":"user","uuid":"u1","timestamp":"${testTime({ milliseconds: 0 })}","message":{"content":"Inspect"}}`,
        `{"type":"assistant","uuid":"a1","timestamp":"${testTime({ milliseconds: 7000 })}","message":{"content":[{"type":"text","text":"Complete."}]}}`,
      ].join('\n'));

      const result = await loadSDKSessionMessages(vaultPath, 'session-no-duration', undefined, sessionPath);

      expect(result.messages).toHaveLength(2);
      expect(result.messages[1].durationSeconds).toBe(7);
    });

  it('infers each turn through its last assistant event without counting idle time between prompts', async () => {
      const sessionPath = writeSessionFile([
        `{"type":"user","uuid":"u1","timestamp":"${testTime({ milliseconds: 0 })}","message":{"content":"Inspect"}}`,
        `{"type":"assistant","uuid":"a1","timestamp":"${testTime({ milliseconds: 2000 })}","message":{"content":[{"type":"tool_use","id":"read","name":"Read","input":{"file_path":"README.md"}}]}}`,
        `{"type":"user","uuid":"tool-result","timestamp":"${testTime({ milliseconds: 3000 })}","toolUseResult":{},"message":{"content":[{"type":"tool_result","tool_use_id":"read","content":"Details"}]}}`,
        `{"type":"assistant","uuid":"a2","timestamp":"${testTime({ milliseconds: 65000 })}","message":{"content":"Complete."}}`,
        `{"type":"user","uuid":"u2","timestamp":"${testTime({ milliseconds: 7200000 })}","message":{"content":"Next"}}`,
        `{"type":"assistant","uuid":"a3","timestamp":"${testTime({ milliseconds: 7209000 })}","message":{"content":"Done."}}`,
      ].join('\n'));

      const result = await loadSDKSessionMessages(vaultPath, 'session-timing', undefined, sessionPath);

      expect(result.messages.filter(message => message.role === 'assistant')).toMatchObject([
        { content: 'Complete.', durationSeconds: 65, completedAt: Date.parse(testTime({ milliseconds: 65000 })) },
        { content: 'Done.', durationSeconds: 9 },
      ]);
    });

  it.each([
      [undefined, testTime({ milliseconds: 7000 })],
      [testTime({ milliseconds: 0 }), undefined],
      ['invalid', testTime({ milliseconds: 7000 })],
      [testTime({ milliseconds: 7000 }), testTime({ milliseconds: 0 })],
    ])('leaves duration unknown for unusable transcript timestamps (%s, %s)', async (start, end) => {
      const sessionPath = writeSessionFile([
        JSON.stringify({ type: 'user', uuid: 'u1', timestamp: start, message: { content: 'Inspect' } }),
        JSON.stringify({ type: 'assistant', uuid: 'a1', timestamp: end, message: { content: 'Complete.' } }),
      ].join('\n'));

      const result = await loadSDKSessionMessages(vaultPath, 'session-invalid-timing', undefined, sessionPath);

      expect(result.messages.find(message => message.role === 'assistant')?.durationSeconds).toBeUndefined();
    });

  it('does not add response duration to assistant output from an interrupted turn', async () => {
      const sessionPath = writeSessionFile([
        `{"type":"user","uuid":"u1","timestamp":"${testTime({ milliseconds: 0 })}","message":{"content":"Start"}}`,
        `{"type":"assistant","uuid":"a1","timestamp":"${testTime({ milliseconds: 4000 })}","message":{"content":[{"type":"text","text":"Partial response"}]}}`,
        `{"type":"system","subtype":"turn_duration","uuid":"duration-1","parentUuid":"a1","timestamp":"${testTime({ milliseconds: 4100 })}","durationMs":4000}`,
        `{"type":"user","uuid":"interrupt-1","timestamp":"${testTime({ milliseconds: 5000 })}","message":{"content":"[Request interrupted by user]"}}`,
      ].join('\n'));

      const result = await loadSDKSessionMessages(vaultPath, 'session-interrupted-duration', undefined, sessionPath);
      const assistant = result.messages.find(message => message.role === 'assistant');

      expect(assistant).toBeDefined();
      expect(assistant?.durationSeconds).toBeUndefined();
    });

  it('sorts messages by timestamp ascending', async () => {
      const sessionPath = writeSessionFile([
        `{"type":"assistant","uuid":"a1","timestamp":"${testTime({ milliseconds: 60000 })}","message":{"content":[{"type":"text","text":"Second"}]}}`,
        `{"type":"user","uuid":"u1","timestamp":"${testTime({ milliseconds: 0 })}","message":{"content":"First"}}`,
        `{"type":"user","uuid":"u2","timestamp":"${testTime({ milliseconds: 120000 })}","message":{"content":"Third"}}`,
      ].join('\n'));

      const result = await loadSDKSessionMessages(vaultPath, 'session-unordered', undefined, sessionPath);

      expect(result.messages[0].content).toBe('First');
      expect(result.messages[1].content).toBe('Second');
      expect(result.messages[2].content).toBe('Third');
    });

  it('matches tool_result from user message to tool_use in assistant message', async () => {
      const sessionPath = writeSessionFile([
        `{"type":"user","uuid":"u1","timestamp":"${testTime({ milliseconds: 0 })}","message":{"content":"Search for cats"}}`,
        `{"type":"assistant","uuid":"a1","timestamp":"${testTime({ milliseconds: 60000 })}","message":{"content":[{"type":"text","text":"Let me search"},{"type":"tool_use","id":"tool-1","name":"WebSearch","input":{"query":"cats"}}]}}`,
        `{"type":"user","uuid":"u2","timestamp":"${testTime({ milliseconds: 120000 })}","toolUseResult":{},"message":{"content":[{"type":"tool_result","tool_use_id":"tool-1","content":"Found 10 results"}]}}`,
        `{"type":"assistant","uuid":"a2","timestamp":"${testTime({ milliseconds: 180000 })}","message":{"content":[{"type":"text","text":"I found 10 results about cats."}]}}`,
      ].join('\n'));

      const result = await loadSDKSessionMessages(vaultPath, 'session-cross-tool', undefined, sessionPath);

      // Should have 2 messages (tool_result-only user skipped, assistant messages merged)
      expect(result.messages).toHaveLength(2);
      expect(result.messages[0].role).toBe('user');
      expect(result.messages[1].role).toBe('assistant');
      expect(result.messages[0].content).toBe('Search for cats');
      // Merged assistant message has tool calls and combined content
      expect(result.messages[1].toolCalls).toHaveLength(1);
      expect(result.messages[1].toolCalls![0].id).toBe('tool-1');
      expect(result.messages[1].toolCalls![0].result).toBe('Found 10 results');
      expect(result.messages[1].toolCalls![0].status).toBe('completed');
      expect(result.messages[1].content).toContain('Let me search');
      expect(result.messages[1].content).toContain('I found 10 results about cats.');
    });

  it('hydrates Claude task mutations as TodoWrite snapshots', async () => {
      const sessionPath = writeSessionFile([
        `{"type":"user","uuid":"u1","timestamp":"${testTime({ milliseconds: 0 })}","message":{"content":"Fix the issue"}}`,
        `{"type":"assistant","uuid":"a1","timestamp":"${testTime({ milliseconds: 60000 })}","message":{"content":[{"type":"tool_use","id":"create-1","name":"TaskCreate","input":{"subject":"Inspect issue","activeForm":"Inspecting issue"}}]}}`,
        `{"type":"user","uuid":"r1","timestamp":"${testTime({ milliseconds: 120000 })}","toolUseResult":{"task":{"id":"1","subject":"Inspect issue"}},"message":{"content":[{"type":"tool_result","tool_use_id":"create-1","content":"Task #1 created successfully: Inspect issue"}]}}`,
        `{"type":"assistant","uuid":"a2","timestamp":"${testTime({ milliseconds: 180000 })}","message":{"content":[{"type":"tool_use","id":"create-2","name":"TaskCreate","input":{"subject":"Implement fix"}}]}}`,
        `{"type":"user","uuid":"r2","timestamp":"${testTime({ milliseconds: 240000 })}","toolUseResult":{"task":{"id":"2","subject":"Implement fix"}},"message":{"content":[{"type":"tool_result","tool_use_id":"create-2","content":"Task #2 created successfully: Implement fix"}]}}`,
        `{"type":"assistant","uuid":"a3","timestamp":"${testTime({ milliseconds: 300000 })}","message":{"content":[{"type":"tool_use","id":"update-1","name":"TaskUpdate","input":{"taskId":"1","status":"completed"}},{"type":"tool_use","id":"delete-2","name":"TaskUpdate","input":{"taskId":"2","status":"deleted"}}]}}`,
        `{"type":"user","uuid":"r3","timestamp":"${testTime({ milliseconds: 360000 })}","toolUseResult":{"success":true,"taskId":"1","updatedFields":["status"],"statusChange":{"from":"pending","to":"completed"}},"message":{"content":[{"type":"tool_result","tool_use_id":"update-1","content":"Updated task #1 status"}]}}`,
        `{"type":"user","uuid":"r4","timestamp":"${testTime({ milliseconds: 420000 })}","toolUseResult":{"success":true,"taskId":"2","updatedFields":["deleted"],"statusChange":{"from":"pending","to":"deleted"}},"message":{"content":[{"type":"tool_result","tool_use_id":"delete-2","content":"Updated task #2 deleted"}]}}`,
      ].join('\n'));

      const result = await loadSDKSessionMessages(vaultPath, 'session-task-tools', undefined, sessionPath);
      const taskCalls = result.messages
        .flatMap(message => message.toolCalls ?? [])
        .filter(toolCall => toolCall.name === 'TodoWrite');

      expect(taskCalls).toHaveLength(4);
      expect(taskCalls[0].providerPayload).toMatchObject({
        rawName: 'TaskCreate',
        rawInput: { subject: 'Inspect issue', activeForm: 'Inspecting issue' },
      });
      expect(taskCalls.at(-1)?.input).toEqual({
        todos: [{
          id: '1',
          content: 'Inspect issue',
          activeForm: 'Inspecting issue',
          status: 'completed',
        }],
      });
    });

  it('preserves Claude task state across compacted history', async () => {
      const sessionPath = writeSessionFile([
        `{"type":"user","uuid":"u1","timestamp":"${testTime({ milliseconds: 0 })}","message":{"content":"Fix the issue"}}`,
        `{"type":"assistant","uuid":"a1","timestamp":"${testTime({ milliseconds: 60000 })}","message":{"content":[{"type":"tool_use","id":"create-1","name":"TaskCreate","input":{"subject":"Inspect issue","activeForm":"Inspecting issue"}}]}}`,
        `{"type":"user","uuid":"r1","timestamp":"${testTime({ milliseconds: 120000 })}","toolUseResult":{"task":{"id":"1","subject":"Inspect issue"}},"message":{"content":[{"type":"tool_result","tool_use_id":"create-1","content":"Task #1 created successfully: Inspect issue"}]}}`,
        `{"type":"system","subtype":"compact_boundary","uuid":"c1","timestamp":"${testTime({ milliseconds: 180000 })}"}`,
        `{"type":"user","uuid":"summary","timestamp":"${testTime({ milliseconds: 181000 })}","isMeta":true,"message":{"content":"This session is being continued from a previous conversation"}}`,
        `{"type":"user","uuid":"u2","timestamp":"${testTime({ milliseconds: 240000 })}","message":{"content":"Continue"}}`,
        `{"type":"assistant","uuid":"a2","timestamp":"${testTime({ milliseconds: 300000 })}","message":{"content":[{"type":"tool_use","id":"update-1","name":"TaskUpdate","input":{"taskId":"1","status":"completed"}}]}}`,
        `{"type":"user","uuid":"r2","timestamp":"${testTime({ milliseconds: 360000 })}","toolUseResult":{"success":true,"taskId":"1","updatedFields":["status"],"statusChange":{"from":"pending","to":"completed"}},"message":{"content":[{"type":"tool_result","tool_use_id":"update-1","content":"Updated task #1 status"}]}}`,
      ].join('\n'));

      const result = await loadSDKSessionMessages(vaultPath, 'session-task-compact', undefined, sessionPath);
      const taskCalls = result.messages
        .flatMap(message => message.toolCalls ?? [])
        .filter(toolCall => toolCall.name === 'TodoWrite');

      expect(taskCalls.at(-1)?.input).toEqual({
        todos: [{
          id: '1',
          content: 'Inspect issue',
          activeForm: 'Inspecting issue',
          status: 'completed',
        }],
      });
    });

  it.each([
      ['has no answers', '"toolUseResult":{},'],
      ['is absent from the transcript', ''],
    ])('hydrates AskUserQuestion answers from result text when toolUseResult %s', async (_case, toolUseResult) => {
      const sessionPath = writeSessionFile([
        `{"type":"assistant","uuid":"a1","timestamp":"${testTime({ milliseconds: 60000 })}","message":{"content":[{"type":"tool_use","id":"ask-1","name":"AskUserQuestion","input":{"questions":[{"question":"Color?","options":["Blue","Red"]}]}}]}}`,
        `{"type":"user","uuid":"u1","timestamp":"2024-01-15T10:02:00Z",${toolUseResult}"message":{"content":[{"type":"tool_result","tool_use_id":"ask-1","content":"\\"Color?\\"=\\"Blue\\""}]}}`,
      ].join('\n'));

      const result = await loadSDKSessionMessages(vaultPath, 'session-ask-result-fallback', undefined, sessionPath);

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].toolCalls).toHaveLength(1);
      expect(result.messages[0].toolCalls?.[0].resolvedAnswers).toEqual({ 'Color?': 'Blue' });
    });

  it('replays stored structured patches and answers through the neutral result fields', async () => {
      const sessionPath = writeSessionFile([
        `{"type":"assistant","uuid":"a1","timestamp":"${testTime({ milliseconds: 60000 })}","message":{"content":[{"type":"tool_use","id":"edit-1","name":"Edit","input":{"file_path":"notes/a.md","old_string":"old","new_string":"new"}},{"type":"tool_use","id":"ask-1","name":"AskUserQuestion","input":{"questions":[{"question":"Color?"}]}}]}}`,
        `{"type":"user","uuid":"u1","timestamp":"${testTime({ milliseconds: 120000 })}","toolUseResult":{"filePath":"/vault/notes/a.md","oldString":"old","newString":"new","structuredPatch":[{"oldStart":3,"oldLines":2,"newStart":3,"newLines":2,"lines":[" keep","-old","+new"]}]},"message":{"content":[{"type":"tool_result","tool_use_id":"edit-1","content":"Updated"}]}}`,
        `{"type":"user","uuid":"u2","timestamp":"${testTime({ milliseconds: 121000 })}","toolUseResult":{"answers":{"Color?":["Blue"]}},"message":{"content":[{"type":"tool_result","tool_use_id":"ask-1","content":"Answered"}]}}`,
      ].join('\n'));

      const result = await loadSDKSessionMessages(vaultPath, 'session-structured-results', undefined, sessionPath);
      const [edit, ask] = result.messages.flatMap(message => message.toolCalls ?? []);

      expect(edit.diffData).toEqual({
        filePath: '/vault/notes/a.md',
        diffLines: [
          { type: 'equal', text: 'keep', oldLineNum: 3, newLineNum: 3 },
          { type: 'delete', text: 'old', oldLineNum: 4 },
          { type: 'insert', text: 'new', newLineNum: 4 },
        ],
        stats: { added: 1, removed: 1 },
      });
      expect(ask.resolvedAnswers).toEqual({ 'Color?': 'Blue' });
    });

  it('skips skill prompt injection messages (sourceToolUseID)', async () => {
      const sessionPath = writeSessionFile([
        `{"type":"user","uuid":"u1","timestamp":"${testTime({ milliseconds: 0 })}","message":{"content":"/commit"}}`,
        `{"type":"assistant","uuid":"a1","timestamp":"${testTime({ milliseconds: 60000 })}","message":{"content":[{"type":"tool_use","id":"t1","name":"Skill","input":{"skill":"commit"}}]}}`,
        `{"type":"user","uuid":"u2","timestamp":"${testTime({ milliseconds: 120000 })}","toolUseResult":{},"message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"Launching skill: commit"}]}}`,
        `{"type":"user","uuid":"u3","timestamp":"${testTime({ milliseconds: 121000 })}","sourceToolUseID":"t1","isMeta":true,"message":{"content":[{"type":"text","text":"## Your task\\n\\nCommit the changes..."}]}}`,
        `{"type":"assistant","uuid":"a2","timestamp":"${testTime({ milliseconds: 180000 })}","message":{"content":[{"type":"text","text":"Committing the changes now."}]}}`,
      ].join('\n'));

      const result = await loadSDKSessionMessages(vaultPath, 'session-skip-skill', undefined, sessionPath);

      // Should have 2 messages: user query, merged assistant (tool_use + text merged together)
      // Skill prompt injection (u3) and tool result (u2) should be skipped
      // Consecutive assistant messages are merged
      expect(result.messages).toHaveLength(2);
      expect(result.messages[0].role).toBe('user');
      expect(result.messages[0].content).toBe('/commit');
      expect(result.messages[1].role).toBe('assistant');
      expect(result.messages[1].toolCalls?.[0].name).toBe('Skill');
      expect(result.messages[1].content).toContain('Committing');
    });

  it('skips meta messages without sourceToolUseID', async () => {
      const sessionPath = writeSessionFile([
        `{"type":"user","uuid":"u1","timestamp":"${testTime({ milliseconds: 0 })}","message":{"content":"Hello"}}`,
        `{"type":"user","uuid":"u2","timestamp":"${testTime({ milliseconds: 1000 })}","isMeta":true,"message":{"content":"System context injection"}}`,
        `{"type":"assistant","uuid":"a1","timestamp":"${testTime({ milliseconds: 60000 })}","message":{"content":[{"type":"text","text":"Hi there!"}]}}`,
      ].join('\n'));

      const result = await loadSDKSessionMessages(vaultPath, 'session-skip-meta', undefined, sessionPath);

      // Should have 2 messages (meta message u2 skipped)
      expect(result.messages).toHaveLength(2);
      expect(result.messages[0].role).toBe('user');
      expect(result.messages[0].content).toBe('Hello');
      expect(result.messages[1].role).toBe('assistant');
    });

  it('preserves /compact command as user message with clean displayContent', async () => {
      // File ordering mirrors real SDK JSONL: compact_boundary written BEFORE /compact command.
      // The timestamp sort must reorder so /compact (earlier) precedes boundary (later).
      const sessionPath = writeSessionFile([
        `{"type":"user","uuid":"u1","timestamp":"${testTime({ milliseconds: 0 })}","message":{"content":"Hello"}}`,
        `{"type":"assistant","uuid":"a1","timestamp":"${testTime({ milliseconds: 60000 })}","message":{"content":[{"type":"text","text":"Hi!"}]}}`,
        `{"type":"system","subtype":"compact_boundary","uuid":"c1","timestamp":"${testTime({ milliseconds: 130000 })}"}`,
        `{"type":"user","uuid":"u2","timestamp":"${testTime({ milliseconds: 120000 })}","isMeta":true,"message":{"content":"<local-command-caveat>Caveat</local-command-caveat>"}}`,
        `{"type":"user","uuid":"u3","timestamp":"${testTime({ milliseconds: 121000 })}","message":{"content":"<command-name>/compact</command-name>\\n<command-message>compact</command-message>\\n<command-args></command-args>"}}`,
        `{"type":"user","uuid":"u4","timestamp":"${testTime({ milliseconds: 131000 })}","message":{"content":"<local-command-stdout>Compacted </local-command-stdout>"}}`,
      ].join('\n'));

      const result = await loadSDKSessionMessages(vaultPath, 'session-compact', undefined, sessionPath);

      // Should have: user "Hello", assistant "Hi!", user "/compact", assistant compact_boundary
      // Meta (u2), stdout (u4) should be skipped
      // /compact (10:02:01) sorted before compact_boundary (10:02:10) by timestamp
      expect(result.messages).toHaveLength(4);
      expect(result.messages[0].role).toBe('user');
      expect(result.messages[0].content).toBe('Hello');
      expect(result.messages[1].role).toBe('assistant');
      expect(result.messages[2].role).toBe('user');
      expect(result.messages[2].displayContent).toBe('/compact');
      expect(result.messages[3].role).toBe('assistant');
      expect(result.messages[3].contentBlocks).toEqual([{ type: 'context_compacted' }]);
    });

  it('renders compact cancellation stderr as interrupt (not filtered)', async () => {
      const sessionPath = writeSessionFile([
        `{"type":"user","uuid":"u1","timestamp":"${testTime({ milliseconds: 0 })}","message":{"content":"Hello"}}`,
        `{"type":"assistant","uuid":"a1","timestamp":"${testTime({ milliseconds: 60000 })}","message":{"content":[{"type":"text","text":"Hi!"}]}}`,
        `{"type":"user","uuid":"u2","timestamp":"${testTime({ milliseconds: 120000 })}","message":{"content":"<command-name>/compact</command-name>\\n<command-message>compact</command-message>\\n<command-args></command-args>"}}`,
        `{"type":"user","uuid":"u3","timestamp":"${testTime({ milliseconds: 121000 })}","message":{"content":"<local-command-stderr>Error: Compaction canceled.</local-command-stderr>"}}`,
      ].join('\n'));

      const result = await loadSDKSessionMessages(vaultPath, 'session-compact-cancel', undefined, sessionPath);

      // Compact cancellation stderr should appear as interrupt, not be filtered
      const interruptMsg = result.messages.find(m => m.isInterrupt);
      expect(interruptMsg).toBeDefined();
      expect(interruptMsg!.isInterrupt).toBe(true);
    });

  it('does not treat embedded compaction stderr mentions as interrupt markers', async () => {
      const sessionPath = writeSessionFile([
        `{"type":"user","uuid":"u1","timestamp":"${testTime({ milliseconds: 0 })}","message":{"content":"Hello"}}`,
        `{"type":"assistant","uuid":"a1","timestamp":"${testTime({ milliseconds: 60000 })}","message":{"content":[{"type":"text","text":"Hi!"}]}}`,
        `{"type":"user","uuid":"u2","timestamp":"${testTime({ milliseconds: 121000 })}","message":{"content":"## Context\\n<local-command-stderr>Error: Compaction canceled.</local-command-stderr>"}}`,
      ].join('\n'));

      const result = await loadSDKSessionMessages(vaultPath, 'session-compact-quoted-cancel', undefined, sessionPath);

      expect(result.messages).toHaveLength(2);
      expect(result.messages.some(m => m.isInterrupt)).toBe(false);
    });

  it('preserves slash command invocations with clean displayContent', async () => {
      const sessionPath = writeSessionFile([
        `{"type":"user","uuid":"u1","timestamp":"${testTime({ milliseconds: 0 })}","message":{"content":"Hello"}}`,
        `{"type":"assistant","uuid":"a1","timestamp":"${testTime({ milliseconds: 60000 })}","message":{"content":[{"type":"text","text":"Hi!"}]}}`,
        `{"type":"user","uuid":"u2","timestamp":"${testTime({ milliseconds: 120000 })}","message":{"content":"<command-message>md2docx</command-message>\\n<command-name>/md2docx</command-name>\\n<command-args>report.md --toc</command-args>"}}`,
        `{"type":"user","uuid":"u3","timestamp":"${testTime({ milliseconds: 120000 })}","isMeta":true,"message":{"content":"Use bash command md2word..."}}`,
        `{"type":"assistant","uuid":"a2","timestamp":"${testTime({ milliseconds: 180000 })}","message":{"content":[{"type":"text","text":"(no content)"}]}}`,
        `{"type":"assistant","uuid":"a3","timestamp":"${testTime({ milliseconds: 181000 })}","message":{"content":[{"type":"tool_use","id":"t1","name":"Skill","input":{"skill":"md2docx"}}]}}`,
      ].join('\n'));

      const result = await loadSDKSessionMessages(vaultPath, 'session-slash-cmd', undefined, sessionPath);

      // user "Hello", assistant "Hi!", user "/md2docx", assistant with Skill tool
      // META (u3) should be skipped; "(no content)" text should be filtered
      expect(result.messages).toHaveLength(4);
      expect(result.messages[2].role).toBe('user');
      expect(result.messages[2].displayContent).toBe('/md2docx report.md --toc');
      expect(result.messages[3].role).toBe('assistant');
      expect(result.messages[3].content).toBe('');
      expect(result.messages[3].toolCalls).toHaveLength(1);
      expect(result.messages[3].toolCalls![0].name).toBe('Skill');
    });

  it('handles tool_result with error flag', async () => {
      const sessionPath = writeSessionFile([
        `{"type":"assistant","uuid":"a1","timestamp":"${testTime({ milliseconds: 0 })}","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"invalid"}}]}}`,
        `{"type":"user","uuid":"u1","timestamp":"${testTime({ milliseconds: 60000 })}","toolUseResult":{},"message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"Command not found","is_error":true}]}}`,
      ].join('\n'));

      const result = await loadSDKSessionMessages(vaultPath, 'session-error-result', undefined, sessionPath);

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].toolCalls![0].status).toBe('error');
      expect(result.messages[0].toolCalls![0].result).toBe('Command not found');
    });

  it('merges tool calls from consecutive assistant messages', async () => {
      const sessionPath = writeSessionFile([
        `{"type":"assistant","uuid":"a1","timestamp":"${testTime({ milliseconds: 0 })}","message":{"content":[{"type":"tool_use","id":"t1","name":"Read","input":{"path":"a.ts"}}]}}`,
        `{"type":"assistant","uuid":"a2","timestamp":"${testTime({ milliseconds: 1000 })}","message":{"content":[{"type":"tool_use","id":"t2","name":"Write","input":{"path":"b.ts"}}]}}`,
      ].join('\n'));

      const result = await loadSDKSessionMessages(vaultPath, 'session-merge-tools', undefined, sessionPath);

      // Consecutive assistant messages should merge into one
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].toolCalls).toHaveLength(2);
      expect(result.messages[0].toolCalls![0].name).toBe('Read');
      expect(result.messages[0].toolCalls![1].name).toBe('Write');
    });

  it('updates assistantMessageId to last entry when merging assistant messages', async () => {
      const sessionPath = writeSessionFile([
        `{"type":"user","uuid":"u1","timestamp":"${testTime({ milliseconds: 0 })}","message":{"content":"hello"}}`,
        `{"type":"assistant","uuid":"a1-first","parentUuid":"u1","timestamp":"${testTime({ milliseconds: 1000 })}","message":{"content":[{"type":"text","text":"thinking..."}]}}`,
        `{"type":"assistant","uuid":"a1-mid","parentUuid":"a1-first","timestamp":"${testTime({ milliseconds: 2000 })}","message":{"content":[{"type":"tool_use","id":"t1","name":"Read","input":{"path":"a.ts"}}]}}`,
        `{"type":"assistant","uuid":"a1-last","parentUuid":"a1-mid","timestamp":"${testTime({ milliseconds: 3000 })}","message":{"content":[{"type":"text","text":"Done!"}]}}`,
      ].join('\n'));

      const result = await loadSDKSessionMessages(vaultPath, 'session-merge-uuid', undefined, sessionPath);

      expect(result.messages).toHaveLength(2);
      const assistant = result.messages[1];
      expect(assistant.role).toBe('assistant');
      // Must be the last UUID so rewind targets the end of the turn
      expect(assistant.assistantMessageId).toBe('a1-last');
    });

  it('merges assistant content blocks when first has no content blocks', async () => {
      const sessionPath = writeSessionFile([
        `{"type":"assistant","uuid":"a1","timestamp":"${testTime({ milliseconds: 0 })}","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{}}]}}`,
        `{"type":"assistant","uuid":"a2","timestamp":"${testTime({ milliseconds: 1000 })}","message":{"content":[{"type":"thinking","thinking":"hmm"},{"type":"text","text":"Result here"}]}}`,
      ].join('\n'));

      const result = await loadSDKSessionMessages(vaultPath, 'session-merge-blocks', undefined, sessionPath);

      expect(result.messages).toHaveLength(1);
      // Merged: tool call from first + content blocks from both
      expect(result.messages[0].toolCalls).toHaveLength(1);
      expect(result.messages[0].contentBlocks!.length).toBeGreaterThanOrEqual(2);
    });

  it('merges assistant with empty target content', async () => {
      const sessionPath = writeSessionFile([
        // First assistant: only tool_use, no text
        `{"type":"assistant","uuid":"a1","timestamp":"${testTime({ milliseconds: 0 })}","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{}}]}}`,
        // Second assistant: has text content
        `{"type":"assistant","uuid":"a2","timestamp":"${testTime({ milliseconds: 1000 })}","message":{"content":[{"type":"text","text":"Here is the result"}]}}`,
      ].join('\n'));

      const result = await loadSDKSessionMessages(vaultPath, 'session-merge-empty-target', undefined, sessionPath);

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].content).toBe('Here is the result');
    });

  it('handles multiple user images in a message', async () => {
      const sessionPath = writeSessionFile([
        JSON.stringify({
          type: 'user',
          uuid: 'u-imgs',
          timestamp: testTime({ milliseconds: 0 }),
          message: {
            content: [
              { type: 'text', text: 'Check these images' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } },
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'def456' } },
            ],
          },
        }),
      ].join('\n'));

      const result = await loadSDKSessionMessages(vaultPath, 'session-multi-images', undefined, sessionPath);

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].images).toHaveLength(2);
      expect(result.messages[0].images![0].mediaType).toBe('image/png');
      expect(result.messages[0].images![1].mediaType).toBe('image/jpeg');
      expect(result.messages[0].images![1].name).toBe('image-2');
    });

  it('extracts text from Agent tool results with array content', async () => {
      const sessionPath = writeSessionFile([
        JSON.stringify({
          type: 'user', uuid: 'u1', timestamp: testTime({ milliseconds: 0 }),
          message: { content: 'Use an agent' },
        }),
        JSON.stringify({
          type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: testTime({ milliseconds: 1000 }),
          message: { content: [{ type: 'tool_use', id: 'agent-1', name: 'Agent', input: { description: 'test', prompt: 'do stuff' } }] },
        }),
        // Agent tool result has array content (not string)
        JSON.stringify({
          type: 'user', uuid: 'tr1', parentUuid: 'a1', timestamp: testTime({ milliseconds: 30000 }),
          toolUseResult: { status: 'completed', agentId: 'abc123' },
          message: { content: [{
            type: 'tool_result', tool_use_id: 'agent-1', is_error: false,
            content: [
              { type: 'text', text: 'Agent completed the task successfully.' },
              { type: 'text', text: 'agentId: abc123\n<usage>total_tokens: 500</usage>' },
            ],
          }] },
        }),
        JSON.stringify({
          type: 'assistant', uuid: 'a2', parentUuid: 'tr1', timestamp: testTime({ milliseconds: 31000 }),
          message: { content: [{ type: 'text', text: 'Done.' }] },
        }),
      ].join('\n'));

      const result = await loadSDKSessionMessages(vaultPath, 'session-agent-result', undefined, sessionPath);

      // The Agent tool call should have extracted text, not JSON.stringify'd array
      const assistantMsg = result.messages.find(m => m.role === 'assistant' && m.toolCalls?.length);
      expect(assistantMsg).toBeDefined();
      const agentToolCall = assistantMsg!.toolCalls!.find(tc => tc.name === 'Agent');
      expect(agentToolCall).toBeDefined();
      expect(agentToolCall!.result).toBe(
        'Agent completed the task successfully.\nagentId: abc123\n<usage>total_tokens: 500</usage>'
      );
      // Must NOT contain JSON artifacts
      expect(agentToolCall!.result).not.toContain('"type":"text"');
    });

  it('truncates messages at resumeAtMessageId on linear JSONL', async () => {
      const sessionPath = writeSessionFile([
        `{"type":"user","uuid":"u1","timestamp":"${testTime({ milliseconds: 0 })}","message":{"content":"Hello"}}`,
        `{"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"${testTime({ milliseconds: 60000 })}","message":{"content":[{"type":"text","text":"Hi!"}]}}`,
        `{"type":"user","uuid":"u2","parentUuid":"a1","timestamp":"${testTime({ milliseconds: 120000 })}","message":{"content":"More"}}`,
        `{"type":"assistant","uuid":"a2","parentUuid":"u2","timestamp":"${testTime({ milliseconds: 180000 })}","message":{"content":[{"type":"text","text":"More response"}]}}`,
      ].join('\n'));

      const result = await loadSDKSessionMessages(vaultPath, 'session-truncate', 'a1', sessionPath);

      // Should only have u1 and a1 (truncated at a1)
      expect(result.messages).toHaveLength(2);
      expect(result.messages[0].content).toBe('Hello');
      expect(result.messages[1].content).toBe('Hi!');
    });

  it('returns correct active branch on branched JSONL', async () => {
      const sessionPath = writeSessionFile([
        `{"type":"user","uuid":"u1","timestamp":"${testTime({ milliseconds: 0 })}","message":{"content":"Hello"}}`,
        `{"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"${testTime({ milliseconds: 60000 })}","message":{"content":[{"type":"text","text":"Hi!"}]}}`,
        `{"type":"user","uuid":"u2","parentUuid":"a1","timestamp":"${testTime({ milliseconds: 120000 })}","message":{"content":"Old branch"}}`,
        `{"type":"assistant","uuid":"a2","parentUuid":"u2","timestamp":"${testTime({ milliseconds: 180000 })}","message":{"content":[{"type":"text","text":"Old response"}]}}`,
        `{"type":"user","uuid":"u3","parentUuid":"a1","timestamp":"${testTime({ milliseconds: 240000 })}","message":{"content":"New branch"}}`,
        `{"type":"assistant","uuid":"a3","parentUuid":"u3","timestamp":"${testTime({ milliseconds: 300000 })}","message":{"content":[{"type":"text","text":"New response"}]}}`,
      ].join('\n'));

      const result = await loadSDKSessionMessages(vaultPath, 'session-branched', undefined, sessionPath);

      // Should have: u1 "Hello", a1 "Hi!", u3 "New branch", a3 "New response"
      // Old branch (u2, a2) should be excluded
      expect(result.messages).toHaveLength(4);
      expect(result.messages[0].content).toBe('Hello');
      expect(result.messages[1].content).toBe('Hi!');
      expect(result.messages[2].content).toBe('New branch');
      expect(result.messages[3].content).toBe('New response');
    });
});

const agentLaunch = (isError: boolean, status: string | undefined, content: string, background = true) => [
  { type: 'user', uuid: 'u1', timestamp: testTime(), message: { content: 'Review code' } },
  { type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: testTime({ seconds: 1 }), message: { content: [
    { type: 'tool_use', id: 'task-1', name: 'Agent', input: { description: 'Review code', prompt: 'Check for bugs', run_in_background: background } },
  ] } },
  { type: 'user', uuid: 'r1', parentUuid: 'a1', timestamp: testTime({ seconds: 2 }),
    toolUseResult: background ? { isAsync: true, agentId: 'ae5eb9a', ...(status ? { status } : {}) } : {},
    message: { content: [{ type: 'tool_result', tool_use_id: 'task-1', content, is_error: isError }] } },
];

it.each([
  { label: 'queue completion', isError: false, launchStatus: 'async_launched', queueStatus: 'completed',
    launchText: 'Task launched in background.', result: 'Found 3 issues:\n1. Missing error handling\n2. Unused import\n3. Race condition' },
  { label: 'queue completion overriding an error flag', isError: true, launchStatus: 'async_launched', queueStatus: 'completed',
    launchText: 'Task launched in background.', result: 'Background work finished cleanly' },
  { label: 'queue success status', isError: false, launchStatus: 'async_launched', queueStatus: 'success',
    launchText: 'Task launched in background.', result: 'Background task succeeded' },
  { label: 'launch without a queue entry', isError: false, launchStatus: undefined, queueStatus: undefined,
    launchText: 'Task launched.', result: 'Task launched.' },
  { label: 'async launch with an error flag', isError: true, launchStatus: 'async_launched', queueStatus: undefined,
    launchText: 'Task launched in background.', result: 'Task launched in background.' },
])('replays persisted async task state from $label', async ({ isError, launchStatus, queueStatus, launchText, result }) => {
  const sessionPath = writeSessionFile([
    ...agentLaunch(isError, launchStatus, launchText),
    ...queueStatus ? [{ type: 'queue-operation', operation: 'enqueue', content:
      `<task-notification><task-id>ae5eb9a</task-id><status>${queueStatus}</status><summary>Agent completed</summary><result>${result}</result></task-notification>`,
    }] : [],
    { type: 'assistant', uuid: 'a2', parentUuid: 'r1', timestamp: testTime({ seconds: 3 }), message: { content: 'Review response' } },
  ]);
  const replay = await loadSDKSessionMessages(vaultPath, 'session', undefined, sessionPath);
  const tool = replay.messages.flatMap(message => message.toolCalls ?? []).find(tool => tool.id === 'task-1');
  expect(replay.messages.length).toBeGreaterThanOrEqual(2);
  const status = queueStatus ? 'completed' : 'running';
  expect(tool).toMatchObject({
    status, result,
    subagent: { mode: 'async', agentId: 'ae5eb9a', status, asyncStatus: status, result },
  });
});

it('does not build async subagent state for a persisted synchronous Agent result', async () => {
  const sessionPath = writeSessionFile(agentLaunch(false, undefined, 'Sync result', false));
  const replay = await loadSDKSessionMessages(vaultPath, 'session', undefined, sessionPath);
  const tool = replay.messages.flatMap(message => message.toolCalls ?? []).find(tool => tool.id === 'task-1');
  expect(tool).toMatchObject({ name: 'Agent', result: 'Sync result' });
  expect(tool?.subagent).toBeUndefined();
});

it.each(['current', 'relocated'] as const)('loads real subagent sidecars beside a %s transcript', async location => {
  const project = location === 'current' ? encodeVaultPathForSDK(vaultPath) : 'old-project';
  const sessionPath = writeSessionFile([
    ...agentLaunch(false, undefined, 'Launched'),
    ...location === 'current' ? [{ type: 'queue-operation', operation: 'enqueue', content:
      '<task-notification><task-id>ae5eb9a</task-id><status>completed</status><result>Done reviewing</result></task-notification>',
    }] : [],
  ], `projects/${project}/session-sidecar.jsonl`);
  writeSessionFile([
    { type: 'assistant', timestamp: testTime({ seconds: 3 }), message: { content: [
      { type: 'tool_use', id: 'sub-tool-1', name: 'Grep', input: { pattern: 'TODO' } },
    ] } },
    { type: 'user', timestamp: testTime({ seconds: 4 }), message: { content: [
      { type: 'tool_result', tool_use_id: 'sub-tool-1', content: '3 matches found' },
    ] } },
  ], `projects/${project}/session-sidecar/subagents/agent-ae5eb9a.jsonl`);
  const context = { environment: { CLAUDE_CONFIG_DIR: path.dirname(path.dirname(path.dirname(sessionPath))) } };
  const replay = await loadSDKSessionMessages(vaultPath, 'session-sidecar', undefined, location === 'relocated' ? sessionPath : undefined, context);
  const tool = replay.messages.flatMap(message => message.toolCalls ?? []).find(tool => tool.id === 'task-1');
  expect(tool?.subagent?.toolCalls).toEqual([
    expect.objectContaining({ id: 'sub-tool-1', name: 'Grep', input: { pattern: 'TODO' }, status: 'completed', result: '3 matches found' }),
  ]);
});

it('streams a multi-chunk transcript between UI tasks and retains both sides of compaction', async () => {
      const entries = Array.from({ length: 300 }, (_, index) => ({
        type: index % 2 === 0 ? 'user' : 'assistant', uuid: `u${index}`, message: { content: '汉字🙂'.repeat(4096) },
      }));
      const boundary = { type: 'system', subtype: 'compact_boundary', uuid: 'compact', parentUuid: null };
      const records = [...entries.slice(0, 150), boundary, ...entries.slice(150)];
      const lines = records.map(record => JSON.stringify(record));
      // About 12 MiB with CRLF endings, blank lines, and one malformed record.
      const sessionPath = writeSessionFile([...lines.slice(0, 150), '', 'not json', '   ', ...lines.slice(150)].join('\r\n'));
      const parse = vi.spyOn(JSON, 'parse');
      const parsedAtTicks: number[] = [];
      const ticker = setInterval(() => parsedAtTicks.push(parse.mock.calls.length), 0);
      try {
        const result = await readSDKSessionFile(sessionPath);
        expect(result).toEqual({ messages: records, skippedLines: 1 });
        expect(parsedAtTicks.some(count => count > 0 && count < records.length)).toBe(true);
      } finally {
        clearInterval(ticker);
        parse.mockRestore();
      }
    });

it('reports a native read failure from the real file stream', async () => {
      const directory = path.dirname(writeSessionFile(''));

      const result = await readSDKSessionFile(directory);

      expect(result).toMatchObject({ messages: [], skippedLines: 0 });
      expect(result.error).toEqual(expect.stringContaining('EISDIR'));
    });
