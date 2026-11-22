import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { answerApproval } from '@test/helpers/features/chat/approvalDecisionOptions';
import type { Mock, Mocked } from 'vitest';

import type { ProviderInteractionPort } from '@/core/execution';
import { ClaudeExecutionInteractionRouter } from '@/providers/claude/execution/ClaudeExecutionInteractionRouter';


function createPort(): Mocked<ProviderInteractionPort> {
  return {
    requestApproval: vi.fn().mockImplementation(async (request) => answerApproval(request, 'allow-always')),
    askUserQuestion: vi.fn().mockImplementation(async (request) => ({
      interactionId: request.interactionId,
      answers: { answer: 'yes' },
    })),
    dismissInteraction: vi.fn(),
  };
}

function createHandler(
  port: Mocked<ProviderInteractionPort>,
  onToolBlocked: Mock = vi.fn(),
): CanUseTool {
  return new ClaudeExecutionInteractionRouter({
    interactionPort: port,
    sessionInstanceId: 'session-local',
    getTurnId: () => 'turn-local',
    isToolAllowed: () => true,
    onToolBlocked,
  }).canUseTool;
}

const nativeOptions = {
  signal: new AbortController().signal,
  toolUseID: 'native-tool-1',
  requestId: 'native-request-1',
};

describe('ClaudeExecutionInteractionRouter', () => {
  it('auto-allows Claudian session tools before ordinary policy and interaction routing', async () => {
    const port = createPort();
    const handler = new ClaudeExecutionInteractionRouter({
      interactionPort: port, sessionInstanceId: 'session', getTurnId: () => null,
      isToolAllowed: () => false, onToolBlocked: vi.fn(),
    }).canUseTool;
    const input = { text: 'Hello' };
    expect(await handler('mcp__claudian_sessions__claudian_send_message', input, nativeOptions))
      .toEqual({ behavior: 'allow', updatedInput: input });
    expect(port.requestApproval).not.toHaveBeenCalled();
  });


  it.each([undefined, false])('returns provider suggestions unchanged when suppression is %s', async (suppressAlwaysAllowRule) => {
    const port = createPort();
    const handler = createHandler(port);
    const input = { command: 'git status' };
    const suggestions = [
      {
        type: 'addRules' as const,
        behavior: 'allow' as const,
        rules: [{ toolName: 'Bash', ruleContent: 'git status:*' }],
        destination: 'localSettings' as const,
      },
      {
        type: 'addDirectories' as const,
        directories: ['/external/path'],
        destination: 'session' as const,
      },
    ];

    const result = await handler('Bash', input, {
      ...nativeOptions,
      suggestions,
      suppressAlwaysAllowRule,
    });

    expect(port.requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        decisionOptions: expect.arrayContaining([
          expect.objectContaining({ decision: 'allow-always' }),
        ]),
      }),
      nativeOptions.signal,
    );
    expect(result).toEqual({
      behavior: 'allow',
      updatedInput: input,
      updatedPermissions: [
        {
          type: 'addRules',
          behavior: 'allow',
          rules: [{ toolName: 'Bash', ruleContent: 'git status:*' }],
          destination: 'localSettings',
        },
        {
          type: 'addDirectories',
          directories: ['/external/path'],
          destination: 'session',
        },
      ],
      decisionClassification: 'user_permanent',
    });
  });

  it.each([
    { label: 'absent', suggestions: undefined, suppressAlwaysAllowRule: undefined },
    { label: 'empty', suggestions: [], suppressAlwaysAllowRule: false },
    {
      label: 'suppressed',
      suggestions: [{
        type: 'addRules' as const,
        behavior: 'allow' as const,
        rules: [{ toolName: 'mcp__connector__write' }],
        destination: 'session' as const,
      }],
      suppressAlwaysAllowRule: true,
    },
  ])('limits approval to this invocation when suggestions are $label', async ({ suggestions, suppressAlwaysAllowRule }) => {
    const port = createPort();
    port.requestApproval.mockImplementation(async request => answerApproval(request, 'allow'));
    const handler = createHandler(port);
    const input = { content: 'note' };
    const native = { ...nativeOptions, suggestions, suppressAlwaysAllowRule };

    const result = await handler('mcp__connector__write', input, native);

    const request = port.requestApproval.mock.calls[0][0];
    expect(request.decisionOptions.map(option => option.decision)).toEqual(['deny', 'allow']);
    expect(result).toEqual({
      behavior: 'allow',
      updatedInput: input,
      decisionClassification: 'user_temporary',
    });

    // An answer naming the Always allow Claude did not offer never persists suggestions.
    const onToolBlocked = vi.fn();
    port.requestApproval.mockImplementation(async ({ interactionId }) => ({ interactionId, value: 'allow-always' }));
    await expect(createHandler(port, onToolBlocked)('mcp__connector__write', input, native)).resolves
      .toEqual({ behavior: 'deny', message: 'User denied this action.', interrupt: false });
    expect(onToolBlocked).toHaveBeenCalledWith(nativeOptions.toolUseID);
  });

  it('interrupts the turn when the approval is dismissed', async () => {
    const port = createPort();
    port.requestApproval.mockImplementation(async ({ interactionId }) => ({ interactionId, value: null }));
    await expect(createHandler(port)('Bash', { command: 'ls' }, nativeOptions)).resolves
      .toEqual({ behavior: 'deny', message: 'User interrupted.', interrupt: true });
  });






  it('dismisses a cancelled interaction once and ignores its late response', async () => {
    const port = createPort();
    let resolveApproval!: (
      response: Awaited<ReturnType<ProviderInteractionPort['requestApproval']>>,
    ) => void;
    port.requestApproval.mockReturnValue(new Promise((resolve) => {
      resolveApproval = resolve;
    }));
    const handler = new ClaudeExecutionInteractionRouter({
      interactionPort: port,
      sessionInstanceId: 'session-local',
      getTurnId: () => 'turn-local',
      isToolAllowed: () => true,
      onToolBlocked: vi.fn(),
    });

    const pending = handler.canUseTool('Edit', {}, nativeOptions);
    handler.dismissAll('cancelled');
    resolveApproval({
      interactionId: 'claude:session-local:native-tool-1',
      value: 'allow',
    });

    const result = await pending;
    expect(port.dismissInteraction.mock.calls).toEqual([
      ['claude:session-local:native-tool-1', 'cancelled'],
    ]);
    expect(result).toEqual(expect.objectContaining({ behavior: 'deny' }));
  });

  it('rejects stale response identities and duplicate pending native interactions', async () => {
    const port = createPort();
    let resolveApproval!: (
      response: Awaited<ReturnType<ProviderInteractionPort['requestApproval']>>,
    ) => void;
    port.requestApproval.mockReturnValue(new Promise((resolve) => {
      resolveApproval = resolve;
    }));
    const handler = createHandler(port);

    const first = handler('Edit', {}, nativeOptions);
    const duplicate = await handler('Edit', {}, nativeOptions);
    resolveApproval({
      interactionId: 'wrong-interaction',
      value: 'allow',
    });

    expect(duplicate).toEqual(expect.objectContaining({
      behavior: 'deny',
      message: expect.stringContaining('already pending'),
    }));
    await expect(first).resolves.toEqual(expect.objectContaining({
      behavior: 'deny',
      message: expect.stringContaining('Stale interaction response'),
    }));
  });
});
