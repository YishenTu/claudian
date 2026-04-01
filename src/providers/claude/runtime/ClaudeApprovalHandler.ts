import type {
  CanUseTool,
  PermissionMode as SDKPermissionMode,
  PermissionResult,
} from '@anthropic-ai/claude-agent-sdk';

import type {
  ApprovalCallback,
  AskUserQuestionCallback,
} from '../../../core/runtime/types';
import { getActionDescription } from '../../../core/security/ApprovalManager';
import {
  TOOL_ASK_USER_QUESTION,
  TOOL_EXIT_PLAN_MODE,
  TOOL_SKILL,
} from '../../../core/tools/toolNames';
import type {
  ApprovalDecision,
  ExitPlanModeCallback,
  ExitPlanModeDecision,
} from '../../../core/types';
import type { PermissionMode } from '../../../core/types/settings';
import { buildPermissionUpdates } from '../security/ClaudePermissionUpdates';

export interface ClaudeApprovalHandlerDeps {
  getAllowedTools: () => string[] | null;
  getApprovalCallback: () => ApprovalCallback | null;
  getAskUserQuestionCallback: () => AskUserQuestionCallback | null;
  getExitPlanModeCallback: () => ExitPlanModeCallback | null;
  getPermissionMode: () => PermissionMode;
  resolveSDKPermissionMode: (mode: PermissionMode) => SDKPermissionMode;
  syncPermissionMode: (mode: PermissionMode, sdkMode: SDKPermissionMode) => void;
}

export function createClaudeApprovalCallback(
  deps: ClaudeApprovalHandlerDeps,
): CanUseTool {
  return async (toolName, input, options): Promise<PermissionResult> => {
    const currentAllowedTools = deps.getAllowedTools();
    if (currentAllowedTools !== null) {
      if (!currentAllowedTools.includes(toolName) && toolName !== TOOL_SKILL) {
        const allowedList = currentAllowedTools.length > 0
          ? ` Allowed tools: ${currentAllowedTools.join(', ')}.`
          : ' No tools are allowed for this query type.';
        return {
          behavior: 'deny',
          message: `Tool "${toolName}" is not allowed for this query.${allowedList}`,
        };
      }
    }

    const exitPlanModeCallback = deps.getExitPlanModeCallback();
    if (toolName === TOOL_EXIT_PLAN_MODE && exitPlanModeCallback) {
      try {
        const decision: ExitPlanModeDecision | null = await exitPlanModeCallback(input, options.signal);
        if (decision === null) {
          return { behavior: 'deny', message: 'User cancelled.', interrupt: true };
        }
        if (decision.type === 'feedback') {
          return { behavior: 'deny', message: decision.text, interrupt: false };
        }

        const permissionMode = deps.getPermissionMode();
        const sdkMode = deps.resolveSDKPermissionMode(permissionMode);
        deps.syncPermissionMode(permissionMode, sdkMode);
        return {
          behavior: 'allow',
          updatedInput: input,
          updatedPermissions: [
            { type: 'setMode', mode: sdkMode, destination: 'session' },
          ],
        };
      } catch (error) {
        return {
          behavior: 'deny',
          message: `Failed to handle plan mode exit: ${error instanceof Error ? error.message : 'Unknown error'}`,
          interrupt: true,
        };
      }
    }

    const askUserQuestionCallback = deps.getAskUserQuestionCallback();
    if (toolName === TOOL_ASK_USER_QUESTION && askUserQuestionCallback) {
      try {
        const answers = await askUserQuestionCallback(input, options.signal);
        if (answers === null) {
          return { behavior: 'deny', message: 'User declined to answer.', interrupt: true };
        }
        return { behavior: 'allow', updatedInput: { ...input, answers } };
      } catch (error) {
        return {
          behavior: 'deny',
          message: `Failed to get user answers: ${error instanceof Error ? error.message : 'Unknown error'}`,
          interrupt: true,
        };
      }
    }

    const approvalCallback = deps.getApprovalCallback();
    if (!approvalCallback) {
      return { behavior: 'deny', message: 'No approval handler available.' };
    }

    try {
      const { decisionReason, blockedPath, agentID } = options;
      const description = getActionDescription(toolName, input);
      const decision: ApprovalDecision = await approvalCallback(
        toolName,
        input,
        description,
        { decisionReason, blockedPath, agentID },
      );

      if (decision === 'cancel') {
        return { behavior: 'deny', message: 'User interrupted.', interrupt: true };
      }

      if (decision === 'allow' || decision === 'allow-always') {
        const updatedPermissions = buildPermissionUpdates(
          toolName,
          input,
          decision,
          options.suggestions,
        );
        return { behavior: 'allow', updatedInput: input, updatedPermissions };
      }

      return { behavior: 'deny', message: 'User denied this action.', interrupt: false };
    } catch (error) {
      return {
        behavior: 'deny',
        message: `Approval request failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        interrupt: false,
      };
    }
  };
}
