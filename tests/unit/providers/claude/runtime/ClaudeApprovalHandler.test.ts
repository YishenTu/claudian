import { TOOL_EXIT_PLAN_MODE } from '@/core/tools/toolNames';
import { createClaudeApprovalCallback } from '@/providers/claude/runtime/ClaudeApprovalHandler';

function createDeps(decision: 'allow' | 'allow-always') {
  return {
    getAllowedTools: () => null,
    getApprovalCallback: () => jest.fn().mockResolvedValue(decision),
    getAskUserQuestionCallback: () => null,
    getExitPlanModeCallback: () => null,
    getPermissionMode: () => 'normal' as const,
    resolveSDKPermissionMode: () => 'default' as const,
    syncPermissionMode: jest.fn(),
    notifyAlwaysAppliedOnce: jest.fn(),
  };
}

describe('createClaudeApprovalCallback', () => {
  const options = {
    signal: new AbortController().signal,
    suggestions: undefined,
  } as any;

  it('allows an unscoped always decision once without returning persistent updates', async () => {
    const deps = createDeps('allow-always');
    const callback = createClaudeApprovalCallback(deps);

    const result = await callback('Read', {}, options);

    expect(result).toEqual({ behavior: 'allow', updatedInput: {} });
    expect(deps.notifyAlwaysAppliedOnce).toHaveBeenCalledTimes(1);
  });

  it('does not notify when an always decision has a derived scope', async () => {
    const deps = createDeps('allow-always');
    const callback = createClaudeApprovalCallback(deps);

    const result = await callback('Bash', { command: 'git status' }, options);

    expect(result).toMatchObject({
      behavior: 'allow',
      updatedPermissions: [{
        type: 'addRules',
        rules: [{ toolName: 'Bash', ruleContent: 'git status' }],
        destination: 'projectSettings',
      }],
    });
    expect(deps.notifyAlwaysAppliedOnce).not.toHaveBeenCalled();
  });

  it('keeps one-time approvals unchanged when no scope can be derived', async () => {
    const deps = createDeps('allow');
    const callback = createClaudeApprovalCallback(deps);

    const result = await callback('Read', {}, options);

    expect(result).toMatchObject({
      behavior: 'allow',
      updatedPermissions: [{
        type: 'addRules',
        rules: [{ toolName: 'Read' }],
        destination: 'session',
      }],
    });
    expect(deps.notifyAlwaysAppliedOnce).not.toHaveBeenCalled();
  });

  it('does not interpret a provider-specific abandon decision as Claude approval', async () => {
    const deps = {
      ...createDeps('allow'),
      getExitPlanModeCallback: () => jest.fn().mockResolvedValue({ type: 'abandon' }),
    };
    const callback = createClaudeApprovalCallback(deps);

    await expect(callback(TOOL_EXIT_PLAN_MODE, {}, options)).resolves.toEqual({
      behavior: 'deny',
      interrupt: true,
      message: 'User abandoned the plan.',
    });
  });
});
