import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import type {
  ClaudeExecutionEventChannel,
  ClaudeNormalizedExecutionEvent,
} from '@/providers/claude/execution/ClaudeExecutionEventNormalizer';
import { ClaudeResponseOwnership } from '@/providers/claude/execution/ClaudeResponseOwnership';

const toolFrame = { type: 'user' } as unknown as SDKMessage;

function streamFrame(event: 'message_start' | 'message_stop'): SDKMessage {
  return {
    type: 'stream_event',
    parent_tool_use_id: null,
    event: event === 'message_start'
      ? { type: 'message_start', message: { id: 'message-1' } }
      : { type: 'message_stop' },
  } as unknown as SDKMessage;
}

function started(toolCallId: string, main = true): ClaudeNormalizedExecutionEvent {
  return {
    type: 'output',
    event: {
      type: 'tool_started',
      toolCallId,
      name: 'Bash',
      input: {},
      toolScope: main ? { kind: 'main' } : { kind: 'subagent', subagentId: 'agent-1' },
    },
  };
}

function completed(toolCallId: string): ClaudeNormalizedExecutionEvent {
  return {
    type: 'output',
    event: { type: 'tool_completed', toolCallId, toolScope: { kind: 'main' } },
  };
}

type Step =
  | readonly ['observe', ClaudeExecutionEventChannel, readonly ClaudeNormalizedExecutionEvent[], SDKMessage?]
  | readonly ['reset', ClaudeExecutionEventChannel];

describe('ClaudeResponseOwnership', () => {
  it('tracks pending main-response work per channel across tool and stream lifecycles', () => {
    const ownership = new ClaudeResponseOwnership();
    // Each step lists the expected [requested, background] pending state after it runs.
    const steps: ReadonlyArray<readonly [string, Step, readonly [boolean, boolean]]> = [
      ['background main tool starts', ['observe', 'background', [started('bg-1')]], [false, true]],
      ['subagent tool never holds the main response', ['observe', 'background', [started('child-1', false)]], [false, true]],
      ['second background main tool starts', ['observe', 'background', [started('bg-2')]], [false, true]],
      ['first background tool completes', ['observe', 'background', [completed('bg-1')]], [false, true]],
      ['completion reported on another channel settles the owning channel', ['observe', 'requested', [completed('bg-2')]], [false, false]],
      ['a final snapshot of a completed tool does not reopen it', ['observe', 'background', [started('bg-2')]], [false, false]],
      ['a repeated completion does not underflow', ['observe', 'background', [completed('bg-2')]], [false, false]],
      ['an unknown completion is ignored', ['observe', 'requested', [completed('unknown')]], [false, false]],
      ['requested start and completion in one batch', ['observe', 'requested', [started('req-1'), completed('req-1')]], [false, false]],
      ['requested main tool starts', ['observe', 'requested', [started('req-2')]], [true, false]],
      ['background main tool starts beside it', ['observe', 'background', [started('bg-3')]], [true, true]],
      ['reset clears only its channel', ['reset', 'background'], [true, false]],
      ['a reset tool id can start again', ['observe', 'background', [started('bg-3')]], [true, true]],
      ['requested reset', ['reset', 'requested'], [false, true]],
      ['background tool completes', ['observe', 'background', [completed('bg-3')]], [false, false]],
      ['an open main stream holds its channel', ['observe', 'requested', [], streamFrame('message_start')], [true, false]],
      ['the stream stop releases it', ['observe', 'requested', [], streamFrame('message_stop')], [false, false]],
    ];

    for (const [label, step, expected] of steps) {
      if (step[0] === 'reset') {
        ownership.reset(step[1]);
      } else {
        ownership.observe(step[3] ?? toolFrame, step[1], step[2]);
      }
      expect({
        label,
        pending: [ownership.hasPending('requested'), ownership.hasPending('background')],
      }).toEqual({ label, pending: expected });
    }
  });
});
