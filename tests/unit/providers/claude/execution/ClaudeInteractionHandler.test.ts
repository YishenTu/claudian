import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';

import type { ProviderInteractionPort } from '@/core/execution';
import { createClaudeExecutionCanUseTool } from '@/providers/claude/execution/ClaudeInteractionHandler';

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
    requestPlanDecision: jest.fn().mockImplementation(async (request) => ({
      interactionId: request.interactionId,
      decision: { type: 'feedback', text: 'Revise it' },
    })),
    dismissInteraction: jest.fn(),
  };
}

function createHandler(
  port: jest.Mocked<ProviderInteractionPort>,
  onToolBlocked: jest.Mock = jest.fn(),
): CanUseTool {
  return createClaudeExecutionCanUseTool({
    interactionPort: port,
    sessionInstanceId: 'session-local',
    getTurnId: () => 'turn-local',
    isToolAllowed: () => true,
    getPermissionMode: () => 'normal',
    resolveSdkPermissionMode: () => 'default',
    onToolBlocked,
  });
}

const nativeOptions = {
  signal: new AbortController().signal,
  toolUseID: 'native-tool-1',
  requestId: 'native-request-1',
};

describe('createClaudeExecutionCanUseTool', () => {
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

  it('applies provider suggestions only for an always-allow decision', async () => {
    const port = createPort();
    const handler = createHandler(port);
    const input = { command: 'git status' };
    const suggestions = [{
      type: 'addRules' as const,
      behavior: 'allow' as const,
      rules: [{ toolName: 'Bash', ruleContent: 'git *' }],
      destination: 'session' as const,
    }];

    const result = await handler('Bash', input, {
      ...nativeOptions,
      suggestions,
    });

    expect(result).toEqual({
      behavior: 'allow',
      updatedInput: input,
      updatedPermissions: [{
        type: 'addRules',
        behavior: 'allow',
        rules: [{ toolName: 'Bash', ruleContent: 'git *' }],
        destination: 'projectSettings',
      }],
      decisionClassification: 'user_permanent',
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

  it('routes plan feedback without resolving it as approval', async () => {
    const port = createPort();
    const handler = createHandler(port);

    const result = await handler('ExitPlanMode', {}, nativeOptions);

    expect(port.requestPlanDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'plan-decision',
        interactionId: 'claude:session-local:native-tool-1',
      }),
      nativeOptions.signal,
    );
    expect(result).toEqual({
      behavior: 'deny',
      message: 'Revise it',
      interrupt: false,
    });
  });

  it('fails closed for disallowed tools before opening an interaction', async () => {
    const port = createPort();
    const handler = createClaudeExecutionCanUseTool({
      interactionPort: port,
      sessionInstanceId: 'session-local',
      getTurnId: () => 'turn-local',
      isToolAllowed: (toolName) => toolName === 'Read',
      getPermissionMode: () => 'normal',
      resolveSdkPermissionMode: () => 'default',
      onToolBlocked: jest.fn(),
    });

    const result = await handler('Edit', {}, nativeOptions);

    expect(result).toEqual(expect.objectContaining({
      behavior: 'deny',
      message: expect.stringContaining('not allowed'),
    }));
    expect(port.requestApproval).not.toHaveBeenCalled();
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
