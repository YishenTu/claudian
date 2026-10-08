import type {
  CanUseTool,
  PermissionResult,
} from '@anthropic-ai/claude-agent-sdk';

import {
  type PendingInteraction,
  PendingInteractionLedger,
  type ProviderApprovalDecisionOption,
  type ProviderInteractionDismissReason,
  type ProviderInteractionPort,
} from '../../../core/execution';
import { getActionDescription } from '../../../core/security/approvalRules';
import {
  TOOL_ASK_USER_QUESTION,
} from '../../../core/tools/toolNames';

export interface ClaudeExecutionInteractionDeps {
  readonly interactionPort: ProviderInteractionPort;
  readonly sessionInstanceId: string;
  readonly getTurnId: (toolId: string) => string | null;
  readonly isToolAllowed: (toolName: string) => boolean;
  readonly onToolBlocked: (toolUseId: string) => void;
}

const ONE_TIME_DECISION_OPTIONS: readonly ProviderApprovalDecisionOption[] = [
  { label: 'Deny', value: 'deny', decision: 'deny' },
  { label: 'Allow once', value: 'allow', decision: 'allow' },
];

// Claude Code decides what an "Always allow" persists and where; offer it only
// when the SDK suggested permission updates and permits persistent approval.
const PERSISTABLE_DECISION_OPTIONS: readonly ProviderApprovalDecisionOption[] = [
  ...ONE_TIME_DECISION_OPTIONS,
  { label: 'Always allow', value: 'allow-always', decision: 'allow-always' },
];

export class ClaudeExecutionInteractionRouter {
  private readonly pending: PendingInteractionLedger;

  constructor(private readonly deps: ClaudeExecutionInteractionDeps) {
    this.pending = new PendingInteractionLedger(deps.interactionPort);
  }

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

    const turnId = this.deps.getTurnId(options.toolUseID);
    if (!turnId) {
      return {
        behavior: 'deny',
        message: 'No current Claude Code turn owns this interaction.',
        interrupt: true,
      };
    }

    const interactionId = this.#getInteractionId(options.toolUseID);
    const pending = this.pending.begin(interactionId);
    if (!pending) {
      return {
        behavior: 'deny',
        message: `Interaction "${interactionId}" is already pending.`,
      };
    }

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
        this.#assertCurrentResponse(pending, response.interactionId);
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

      const canPersistApproval = !options.suppressAlwaysAllowRule && Boolean(options.suggestions?.length);
      const response = await this.deps.interactionPort.requestApproval({
        ...identity,
        kind: 'approval',
        toolName,
        input,
        description: getActionDescription(toolName, input),
        decisionReason: options.decisionReason,
        blockedPath: options.blockedPath,
        decisionOptions: canPersistApproval
          ? PERSISTABLE_DECISION_OPTIONS
          : ONE_TIME_DECISION_OPTIONS,
      }, options.signal);
      this.#assertCurrentResponse(pending, response.interactionId);
      dismissReason = 'resolved';
      const decision = response.decision;
      if (decision === 'cancel') {
        return {
          behavior: 'deny',
          message: 'User interrupted.',
          interrupt: true,
        };
      }
      if (decision === 'allow' || (decision === 'allow-always' && !canPersistApproval)) {
        return {
          behavior: 'allow',
          updatedInput: input,
          decisionClassification: 'user_temporary',
        };
      }
      if (decision === 'allow-always') {
        return {
          behavior: 'allow',
          updatedInput: input,
          updatedPermissions: options.suggestions,
          decisionClassification: 'user_permanent',
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
      this.pending.settle(
        pending,
        options.signal.aborted ? 'cancelled' : dismissReason,
      );
    }
  };

  dismissAll(reason: ProviderInteractionDismissReason): void {
    this.pending.dismissAll(reason);
  }

  #assertCurrentResponse(pending: PendingInteraction, responseId: string): void {
    if (responseId !== pending.interactionId) {
      throw new StaleClaudeInteractionResponseError(
        `Stale interaction response: expected "${pending.interactionId}", received "${responseId}".`,
      );
    }
    if (this.pending.isStaleResponse(pending, { interactionId: responseId })) {
      throw new StaleClaudeInteractionResponseError(
        `Stale interaction response: "${pending.interactionId}" was already dismissed.`,
      );
    }
  }

  #getInteractionId(nativeToolUseId: string): string {
    return `claude:${this.deps.sessionInstanceId}:${nativeToolUseId}`;
  }
}

class StaleClaudeInteractionResponseError extends Error {}

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
