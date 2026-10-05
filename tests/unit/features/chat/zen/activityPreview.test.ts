import { holdResponse } from '@test/helpers/ConversationPorts';

import type { ChatMessage, ToolCallInfo } from '@/core/types';
import { ChatState } from '@/features/chat/state/ChatState';
import { TurnCoordinator } from '@/features/chat/turns/TurnCoordinator';
import { formatActivityPreview } from '@/features/chat/zen/activityPreview';

function tool(status: ToolCallInfo['status']): ToolCallInfo {
  return { id: 'tool-1', name: 'Bash', input: { command: 'rm -rf build' }, status, result: 'long output' };
}

function assistant(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { id: 'a1', role: 'assistant', content: '', timestamp: 2, ...overrides };
}

describe('formatActivityPreview', () => {
  it('leaves an empty conversation blank and describes working state neutrally', () => {
    const turns = new TurnCoordinator();
    const state = new ChatState({}, undefined, turns);
    expect(formatActivityPreview(state)).toEqual({ text: '', tone: 'idle' });

    state.addMessage({ id: 'u1', role: 'user', content: 'raw', displayContent: '  Review\n the   note ', timestamp: 1 });
    expect(formatActivityPreview(state)).toEqual({ text: 'Review the note', tone: 'idle' });

    holdResponse(turns);
    state.addMessage(assistant());
    expect(formatActivityPreview(state)).toEqual({ text: 'Review the note', tone: 'working' });

    state.recordActivity({ kind: 'thinking' });
    expect(formatActivityPreview(state).text).toBe('Thinking…');
  });

  it('shows the first non-empty plain line of the latest streamed text within bounds', () => {
    const state = new ChatState();
    state.recordActivity({ kind: 'text', text: `\n  \n> **Quoted** line\n\nLater line\n${'x'.repeat(10_000)}` });
    expect(formatActivityPreview(state).text).toBe('**Quoted** line');

    state.recordActivity({ kind: 'text', text: `- ${'word '.repeat(100)}` });
    const text = formatActivityPreview(state).text;
    expect(text.length).toBe(240);
    expect(text.endsWith('…')).toBe(true);
  });

  it.each([
    ['running', 'Bash · running'],
    ['completed', 'Bash · done'],
    ['error', 'Bash · failed'],
    ['blocked', 'Bash · blocked'],
  ] as const)('summarizes %s tool activity without arguments or output', (status, expected) => {
    const state = new ChatState();
    state.recordActivity({ kind: 'tool', tool: tool(status) });
    expect(formatActivityPreview(state)).toMatchObject({ text: expected, toolName: 'Bash' });
  });

  it('names a tool only when the line describes one', () => {
    const state = new ChatState();
    state.recordActivity({ kind: 'text', text: 'Plain answer' });
    expect(formatActivityPreview(state).toolName).toBeUndefined();

    state.messages = [assistant({
      content: '',
      contentBlocks: [{ type: 'tool_use', toolId: 'tool-1' }],
      toolCalls: [tool('completed')],
    })];
    expect(formatActivityPreview(state).toolName).toBe('Bash');

    state.beginActionRequired('approval-1');
    expect(formatActivityPreview(state).toolName).toBeUndefined();
  });

  it('seeds from loaded history using the latest text or tool block', () => {
    const state = new ChatState();
    const call = tool('completed');
    state.messages = [assistant({
      content: 'Earlier text',
      contentBlocks: [{ type: 'text', content: 'Earlier text' }, { type: 'tool_use', toolId: call.id }],
      toolCalls: [call],
    })];
    expect(formatActivityPreview(state).text).toBe('Bash · done');

    state.messages = [assistant({ content: 'Only content\nlast' })];
    expect(formatActivityPreview(state).text).toBe('Only content');
  });

  it('leads a finished turn with its duration and the first line of the final result', () => {
    const turns = new TurnCoordinator();
    const state = new ChatState({}, undefined, turns);
    const call = tool('completed');
    state.messages = [assistant({
      content: 'Checking\n\n## Result line\nMore detail',
      contentBlocks: [
        { type: 'text', content: 'Checking' },
        { type: 'tool_use', toolId: call.id },
        { type: 'text', content: '\n## Result line\nMore detail' },
      ],
      toolCalls: [call],
      durationSeconds: 67,
    })];
    expect(formatActivityPreview(state)).toEqual({ text: 'Worked for 01:07 · Result line', tone: 'idle' });

    // The final text block is recorded as activity before it joins the message's blocks.
    state.messages = [assistant({ content: '', durationSeconds: 7 })];
    state.recordActivity({ kind: 'text', text: 'Streamed answer\nrest' });
    expect(formatActivityPreview(state).text).toBe('Worked for 00:07 · Streamed answer');

    // A turn that ended on a tool has no result line.
    state.recordActivity({ kind: 'tool', tool: call });
    expect(formatActivityPreview(state)).toEqual({ text: 'Worked for 00:07', tone: 'idle' });

    holdResponse(turns);
    expect(formatActivityPreview(state).text).toBe('Bash · done');
  });

  it('mirrors the main waiting status while streaming, except over a running tool', () => {
    const turns = new TurnCoordinator();
    const state = new ChatState({}, undefined, turns);
    state.addMessage({ id: 'u1', role: 'user', content: 'Review the note', timestamp: 1 });
    holdResponse(turns);
    state.waitingStatus = 'Compacting...';
    expect(formatActivityPreview(state)).toEqual({ text: 'Compacting...', tone: 'working' });

    state.recordActivity({ kind: 'text', text: 'Paused answer' });
    expect(formatActivityPreview(state).text).toBe('Compacting...');

    state.recordActivity({ kind: 'tool', tool: tool('running') });
    expect(formatActivityPreview(state)).toMatchObject({ text: 'Bash · running', toolName: 'Bash' });
    state.recordActivity({ kind: 'tool', tool: tool('completed') });
    expect(formatActivityPreview(state).text).toBe('Compacting...');

    state.beginActionRequired('approval-1');
    expect(formatActivityPreview(state).text).toBe('Needs your input');
    state.endActionRequired('approval-1');

    state.waitingStatus = null;
    expect(formatActivityPreview(state).text).toBe('Bash · done');
  });

  it('prioritizes pending interaction, then errors, then interruption', () => {
    const state = new ChatState();
    state.addMessage(assistant({ content: 'Partial', isInterrupt: true }));
    expect(formatActivityPreview(state)).toEqual({ text: 'Interrupted', tone: 'idle' });

    state.recordActivity({ kind: 'error', message: 'Provider\nunavailable' });
    expect(formatActivityPreview(state)).toEqual({ text: 'Error: Provider unavailable', tone: 'error' });

    state.beginActionRequired('approval-1');
    expect(formatActivityPreview(state)).toEqual({ text: 'Needs your input', tone: 'action-required' });

    state.endActionRequired('approval-1');
    expect(formatActivityPreview(state).tone).toBe('error');
  });
});
