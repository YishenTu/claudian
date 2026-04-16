import type {
  ApprovalCallback,
  AskUserQuestionCallback,
} from '../../../core/runtime/types';
import type { ApprovalDecision } from '../../../core/types';
import type {
  AcpToolApprovalRequest,
  AcpToolApprovalResponse,
  AcpUserInputRequest,
  AcpUserInputResponse,
} from '../protocol/acpProtocolTypes';

/**
 * Handles server requests from ACP agents (tool approval, user input).
 * Adapted from CodexServerRequestRouter for the ACP protocol.
 */
export class AcpServerRequestRouter {
  private approvalCallback: ApprovalCallback | null = null;
  private askUserCallback: AskUserQuestionCallback | null = null;
  private pendingAskUserAbortController: AbortController | null = null;

  setApprovalCallback(callback: ApprovalCallback | null): void {
    this.approvalCallback = callback;
  }

  setAskUserCallback(callback: AskUserQuestionCallback | null): void {
    this.askUserCallback = callback;
  }

  async handleServerRequest(
    requestId: string | number,
    method: string,
    params: unknown,
  ): Promise<unknown> {
    switch (method) {
      case 'tool/requestApproval':
        return this.handleToolApproval(requestId, params as AcpToolApprovalRequest);
      case 'user/requestInput':
        return this.handleUserInput(requestId, params as AcpUserInputRequest);
      default:
        throw new Error(`Unsupported server request: ${method}`);
    }
  }

  private async handleToolApproval(
    _requestId: string | number,
    params: AcpToolApprovalRequest,
  ): Promise<AcpToolApprovalResponse> {
    if (!this.approvalCallback) {
      return { decision: 'deny' };
    }

    try {
      const decision = await this.approvalCallback(
        params.toolName,
        params.input,
        params.description ?? '',
      );

      // Map Claudian's approval decision to ACP's
      const acpDecision: AcpToolApprovalResponse['decision'] =
        decision === 'allow' || decision === 'allow-always' ? 'allow' :
        decision === 'deny' || decision === 'cancel' ? 'deny' : 'allow-always';

      return { decision: acpDecision };
    } catch {
      return { decision: 'deny' };
    }
  }

  private async handleUserInput(
    _requestId: string | number,
    params: AcpUserInputRequest,
  ): Promise<AcpUserInputResponse> {
    if (!this.askUserCallback) {
      throw new Error('No ask-user callback registered');
    }

    // Abort any pending ask-user request
    this.abortPendingAskUser();

    this.pendingAskUserAbortController = new AbortController();

    try {
      // Build input for the callback - convert questions to Record<string, unknown>
      const input: Record<string, unknown> = {};
      for (const q of params.questions) {
        input[q.id] = {
          question: q.question,
          header: q.header,
          options: q.options?.map(o => ({ label: o.label, description: o.description })) ?? [],
          isOther: q.isOther,
          isSecret: q.isSecret,
        };
      }

      const answers = await this.askUserCallback(
        input,
        this.pendingAskUserAbortController.signal,
      );

      // Map answers back to ACP format
      const answersRecord: Record<string, { answers: string[] }> = {};
      if (answers) {
        for (const [id, answer] of Object.entries(answers)) {
          answersRecord[id] = { answers: Array.isArray(answer) ? answer : [answer] };
        }
      }

      return { answers: answersRecord };
    } finally {
      this.pendingAskUserAbortController = null;
    }
  }

  abortPendingAskUser(): void {
    if (this.pendingAskUserAbortController) {
      this.pendingAskUserAbortController.abort();
      this.pendingAskUserAbortController = null;
    }
  }

  hasPendingApprovalRequest(_requestId: string | number, _messageId: string): boolean {
    // ACP doesn't have the same "auto-resolve" pattern as Codex
    return false;
  }
}
