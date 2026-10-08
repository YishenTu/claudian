import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';

import type { ProviderInteractionPort } from '@/core/execution';
import { ClaudeExecutionInteractionRouter } from '@/providers/claude/execution/ClaudeExecutionInteractionRouter';

function createPort(): jest.Mocked<ProviderInteractionPort> {
  return {
    requestApproval: jest.fn().mockImplementation(async (request) => ({
      interactionId: request.interactionId,
      decision: 'allow-always',
    })),
    askUserQuestion: jest.fn().mockImplementation(async (request) => ({
      interactionId: request.interactionId,
      answers: { answer: 'yes' },
    })),
    dismissInteraction: jest.fn(),
  };
}

function createHandler(
  port: jest.Mocked<ProviderInteractionPort>,
  onToolBlocked: jest.Mock = jest.fn(),
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
  it('allows only the current invocation for an allow-once decision', async () => {
    const port = createPort();
    port.requestApproval.mockImplementation(async (request) => ({
      interactionId: request.interactionId,
      decision: 'allow',
    }));
    const handler = createHandler(port);
    const input = { command: 'ls /external/path' };
    const suggestions = [{
      type: 'addRules' as const,
      behavior: 'allow' as const,
      rules: [{ toolName: 'Bash', ruleContent: 'ls *' }],
      destination: 'session' as const,
    }];

    const result = await handler('Bash', input, {
      ...nativeOptions,
      suggestions,
    });

    expect(result).toEqual({
      behavior: 'allow',
      updatedInput: input,
      decisionClassification: 'user_temporary',
    });
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
    const handler = createHandler(port);
    const input = { content: 'note' };

    const result = await handler('mcp__connector__write', input, {
      ...nativeOptions,
      suggestions,
      suppressAlwaysAllowRule,
    });

    const request = port.requestApproval.mock.calls[0][0];
    expect(request.decisionOptions?.map(option => option.decision)).toEqual(['deny', 'allow']);
    // The port deliberately returns allow-always even though that choice was not offered.
    expect(result).toEqual({
      behavior: 'allow',
      updatedInput: input,
      decisionClassification: 'user_temporary',
    });
  });

  it('routes approvals with stable native/local identity and dismisses the exact interaction', async () => {
    const port = createPort();
    const handler = createHandler(port);

    const result = await handler(
      'Edit',
      { file_path: 'note.md' },
      nativeOptions,
    );

    expect(port.requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        interactionId: 'claude:session-local:native-tool-1',
        sessionInstanceId: 'session-local',
        turnId: 'turn-local',
        toolName: 'Edit',
        nativeContext: expect.objectContaining({
          toolUseId: 'native-tool-1',
        }),
      }),
      nativeOptions.signal,
    );
    expect(result?.behavior).toBe('allow');
    expect(port.dismissInteraction).toHaveBeenCalledWith(
      'claude:session-local:native-tool-1',
      'resolved',
    );
  });

  it('reports a denied approval against its native tool identity', async () => {
    const port = createPort();
    port.requestApproval.mockImplementation(async (request) => ({
      interactionId: request.interactionId,
      decision: 'deny',
    }));
    const onToolBlocked = jest.fn();
    const handler = createHandler(port, onToolBlocked);

    const result = await handler('Bash', { command: 'rm -rf /' }, nativeOptions);

    expect(result).toEqual({
      behavior: 'deny',
      message: 'User denied this action.',
      interrupt: false,
    });
    expect(onToolBlocked).toHaveBeenCalledWith('native-tool-1');
  });

  it('routes questions and injects Claude Code compatible custom-answer support', async () => {
    const port = createPort();
    const handler = createHandler(port);
    const input = {
      questions: [{
        question: 'Continue?',
        header: 'Choice',
        options: [],
        multiSelect: false,
      }],
    };

    const result = await handler('AskUserQuestion', input, nativeOptions);

    expect(port.askUserQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'question',
        input: expect.objectContaining({
          questions: [expect.objectContaining({ isOther: true })],
        }),
      }),
      nativeOptions.signal,
    );
    expect(result).toEqual({
      behavior: 'allow',
      updatedInput: expect.objectContaining({
        answers: { answer: 'yes' },
      }),
    });
  });

  it('fails closed for disallowed tools before opening an interaction', async () => {
    const port = createPort();
    const handler = new ClaudeExecutionInteractionRouter({
      interactionPort: port,
      sessionInstanceId: 'session-local',
      getTurnId: () => 'turn-local',
      isToolAllowed: (toolName) => toolName === 'Read',
      onToolBlocked: jest.fn(),
    }).canUseTool;

    const result = await handler('Edit', {}, nativeOptions);

    expect(result).toEqual(expect.objectContaining({
      behavior: 'deny',
      message: expect.stringContaining('not allowed'),
    }));
    expect(port.requestApproval).not.toHaveBeenCalled();
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
      onToolBlocked: jest.fn(),
    });

    const pending = handler.canUseTool('Edit', {}, nativeOptions);
    handler.dismissAll('cancelled');
    resolveApproval({
      interactionId: 'claude:session-local:native-tool-1',
      decision: 'allow',
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
      decision: 'allow',
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
