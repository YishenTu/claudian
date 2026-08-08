import type {
  CanUseTool,
  PermissionMode as SDKPermissionMode,
  PermissionResult,
} from '@anthropic-ai/claude-agent-sdk';

import type {
  ProviderInteractionDismissReason,
  ProviderInteractionPort,
} from '../../../core/execution';
import { getActionDescription } from '../../../core/security/approvalRules';
import {
  TOOL_ASK_USER_QUESTION,
  TOOL_EXIT_PLAN_MODE,
} from '../../../core/tools/toolNames';
import type { PermissionMode } from '../../../core/types/settings';
import { buildPermissionUpdates } from '../security/ClaudePermissionUpdates';

export interface ClaudeExecutionInteractionDeps {
  readonly interactionPort: ProviderInteractionPort;
  readonly sessionInstanceId: string;
  readonly getTurnId: () => string | null;
  readonly isToolAllowed: (toolName: string) => boolean;
  readonly getPermissionMode: () => PermissionMode;
  readonly resolveSdkPermissionMode: (
    mode: PermissionMode,
  ) => SDKPermissionMode;
  readonly onToolBlocked: (toolUseId: string) => void;
}

export class ClaudeInteractionHandler {
  private readonly pendingInteractionIds = new Set<string>();

  constructor(private readonly deps: ClaudeExecutionInteractionDeps) {}

  readonly canUseTool: CanUseTool = async (
    toolName,
    input,
    options,
  ): Promise<PermissionResult> => {
    if (!this.deps.isToolAllowed(toolName)) {
      return {
        behavior: 'deny',
        message: `Tool "${toolName}" is not allowed by this execution policy.`,
      };
    }

    const turnId = this.deps.getTurnId();
    if (!turnId) {
      return {
        behavior: 'deny',
        message: 'No current Claude turn owns this interaction.',
        interrupt: true,
      };
    }

    const interactionId = this.getInteractionId(options.toolUseID);
    if (this.pendingInteractionIds.has(interactionId)) {
      return {
        behavior: 'deny',
        message: `Interaction "${interactionId}" is already pending.`,
      };
    }
    this.pendingInteractionIds.add(interactionId);

    let dismissReason: ProviderInteractionDismissReason = 'native-rejected';
    try {
      const identity = {
        interactionId,
        sessionInstanceId: this.deps.sessionInstanceId,
        turnId,
        nativeContext: {
          toolUseId: options.toolUseID,
          requestId: options.requestId,
          agentId: options.agentID,
        },
      };

      if (toolName === TOOL_ASK_USER_QUESTION) {
        const questionInput = addCustomAnswerSupport(input);
        const response = await this.deps.interactionPort.askUserQuestion({
          ...identity,
          kind: 'question',
          input: questionInput,
        }, options.signal);
        assertResponseIdentity(interactionId, response.interactionId);
        dismissReason = 'resolved';
        if (response.answers === null) {
          return {
            behavior: 'deny',
            message: 'User declined to answer.',
            interrupt: true,
          };
        }
        return {
          behavior: 'allow',
          updatedInput: {
            ...questionInput,
            answers: response.answers,
          },
        };
      }

      if (toolName === TOOL_EXIT_PLAN_MODE) {
        const response = await this.deps.interactionPort.requestPlanDecision({
          ...identity,
          kind: 'plan-decision',
          input,
        }, options.signal);
        assertResponseIdentity(interactionId, response.interactionId);
        dismissReason = 'resolved';
        const decision = response.decision;
        if (decision === null) {
          return {
            behavior: 'deny',
            message: 'User cancelled.',
            interrupt: true,
          };
        }
        if (decision.type === 'feedback') {
          return {
            behavior: 'deny',
            message: decision.text,
            interrupt: false,
          };
        }
        if (decision.type === 'abandon') {
          return {
            behavior: 'deny',
            message: 'User abandoned the plan.',
            interrupt: true,
          };
        }

        const sdkMode = this.deps.resolveSdkPermissionMode(
          this.deps.getPermissionMode(),
        );
        return {
          behavior: 'allow',
          updatedInput: input,
          updatedPermissions: [{
            type: 'setMode',
            mode: sdkMode,
            destination: 'session',
          }],
        };
      }

      const response = await this.deps.interactionPort.requestApproval({
        ...identity,
        kind: 'approval',
        toolName,
        input,
        description: getActionDescription(toolName, input),
        decisionReason: options.decisionReason,
        blockedPath: options.blockedPath,
        additionalPermissions: options.suggestions,
      }, options.signal);
      assertResponseIdentity(interactionId, response.interactionId);
      dismissReason = 'resolved';
      const decision = response.decision;
      if (decision === 'cancel') {
        return {
          behavior: 'deny',
          message: 'User interrupted.',
          interrupt: true,
        };
      }
      if (decision === 'allow' || decision === 'allow-always') {
        return {
          behavior: 'allow',
          updatedInput: input,
          updatedPermissions: buildPermissionUpdates(
            toolName,
            input,
            decision,
            options.suggestions,
          ),
        };
      }
      this.deps.onToolBlocked(options.toolUseID);
      return {
        behavior: 'deny',
        message: 'User denied this action.',
        interrupt: false,
      };
    } catch (error) {
      if (error instanceof StaleClaudeInteractionResponseError) {
        return {
          behavior: 'deny',
          message: error.message,
          interrupt: true,
        };
      }
      return {
        behavior: 'deny',
        message: error instanceof Error
          ? `Interaction failed: ${error.message}`
          : 'Interaction failed.',
        interrupt: options.signal.aborted,
      };
    } finally {
      this.pendingInteractionIds.delete(interactionId);
      this.deps.interactionPort.dismissInteraction(
        interactionId,
        options.signal.aborted ? 'cancelled' : dismissReason,
      );
    }
  };

  dismissAll(reason: ProviderInteractionDismissReason): void {
    for (const interactionId of this.pendingInteractionIds) {
      this.deps.interactionPort.dismissInteraction(interactionId, reason);
    }
    this.pendingInteractionIds.clear();
  }

  private getInteractionId(nativeToolUseId: string): string {
    return `claude:${this.deps.sessionInstanceId}:${nativeToolUseId}`;
  }
}

export function createClaudeExecutionCanUseTool(
  deps: ClaudeExecutionInteractionDeps,
): CanUseTool {
  return new ClaudeInteractionHandler(deps).canUseTool;
}

class StaleClaudeInteractionResponseError extends Error {}

function assertResponseIdentity(expected: string, actual: string): void {
  if (actual !== expected) {
    throw new StaleClaudeInteractionResponseError(
      `Stale interaction response: expected "${expected}", received "${actual}".`,
    );
  }
}

function addCustomAnswerSupport(
  input: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const copy = {
    ...input,
  };
  if (!Array.isArray(input.questions)) {
    return copy;
  }
  const questions: unknown[] = input.questions;
  copy.questions = questions.map((question) => (
    isRecord(question) && !('isOther' in question)
      ? { ...question, isOther: true }
      : question
  ));
  return copy;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
