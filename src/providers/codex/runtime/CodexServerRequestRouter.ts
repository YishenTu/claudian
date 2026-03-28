import type { ApprovalCallback, AskUserQuestionCallback } from '../../../core/runtime/types';
import { normalizeCodexToolName } from '../normalization/codexToolNormalization';
import type {
  ApprovalResponse,
  UserInputResponse,
} from './codexAppServerTypes';

export class CodexServerRequestRouter {
  private approvalCallback: ApprovalCallback | null = null;
  private askUserCallback: AskUserQuestionCallback | null = null;

  setApprovalCallback(callback: ApprovalCallback | null): void {
    this.approvalCallback = callback;
  }

  setAskUserCallback(callback: AskUserQuestionCallback | null): void {
    this.askUserCallback = callback;
  }

  async handleServerRequest(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'item/commandExecution/requestApproval':
        return this.handleCommandApproval(params as Record<string, unknown>);

      case 'item/fileChange/requestApproval':
        return this.handleFileChangeApproval(params as Record<string, unknown>);

      case 'item/permissions/requestApproval':
        return this.handlePermissionsApproval(params as Record<string, unknown>);

      case 'item/tool/requestUserInput':
        return this.handleUserInputRequest(params as Record<string, unknown>);

      default:
        throw new Error(`Unsupported server request: ${method}`);
    }
  }

  private async handleCommandApproval(params: Record<string, unknown>): Promise<ApprovalResponse> {
    if (!this.approvalCallback) return { decision: 'deny' };

    const command = String(params.command ?? '');
    const toolName = normalizeCodexToolName('command_execution');
    const input = { command };
    const description = `Execute: ${command}`;

    const decision = await this.approvalCallback(toolName, input, description, {});
    return { decision: mapApprovalDecision(decision) };
  }

  private async handleFileChangeApproval(params: Record<string, unknown>): Promise<ApprovalResponse> {
    if (!this.approvalCallback) return { decision: 'deny' };

    const changes = params.changes as Array<{ path: string; type: string }> | undefined ?? [];
    const toolName = normalizeCodexToolName('file_change');
    const input: Record<string, unknown> = { changes };
    const paths = changes.map(c => c.path).join(', ');
    const description = `File change: ${paths || 'unknown'}`;

    const decision = await this.approvalCallback(toolName, input, description, {});
    return { decision: mapApprovalDecision(decision) };
  }

  private async handlePermissionsApproval(params: Record<string, unknown>): Promise<ApprovalResponse> {
    if (!this.approvalCallback) return { decision: 'deny' };

    const toolName = 'permissions';
    const description = 'Permission request';

    const decision = await this.approvalCallback(toolName, params, description, {});
    return { decision: mapApprovalDecision(decision) };
  }

  private async handleUserInputRequest(params: Record<string, unknown>): Promise<UserInputResponse> {
    if (!this.askUserCallback) return { answers: {} };

    const questions = params.questions as Array<{ id: string; text: string }> | undefined ?? [];
    const input: Record<string, unknown> = { questions };

    const userAnswers = await this.askUserCallback(input);

    if (!userAnswers) return { answers: {} };

    const answers: Record<string, { answers: string[] }> = {};
    for (const [key, value] of Object.entries(userAnswers)) {
      answers[key] = { answers: [value] };
    }

    return { answers };
  }
}

function mapApprovalDecision(decision: string): 'accept' | 'deny' | 'alwaysAccept' {
  switch (decision) {
    case 'allow':
      return 'accept';
    case 'allow-always':
      return 'alwaysAccept';
    case 'deny':
    case 'cancel':
      return 'deny';
    default:
      return 'deny';
  }
}
