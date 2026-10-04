import {
  PendingInteractionLedger,
  type ProviderInteractionDismissReason,
  type ProviderInteractionPort,
} from '../../core/execution';
import {
  buildACPApprovalDecisionOptions,
  mapACPApprovalDecision,
} from './ACPPermissionAdapter';
import type {
  ACPRequestPermissionRequest,
  ACPRequestPermissionResponse,
} from './types';

const CANCELLED_RESPONSE: ACPRequestPermissionResponse = {
  outcome: { outcome: 'cancelled' },
};

export interface ACPPermissionPresentation {
  readonly blockedPath?: string;
  readonly decisionReason?: string;
  readonly description: string;
  readonly toolName: string;
}

export interface ACPInteractionControllerOptions {
  readonly getTurnId: () => string | null;
  readonly interactionPort: ProviderInteractionPort;
  readonly presentPermission?: (
    request: ACPRequestPermissionRequest,
    input: Readonly<Record<string, unknown>>,
  ) => ACPPermissionPresentation;
  readonly sessionInstanceId: string;
}

export class ACPInteractionController {
  private disposed = false;
  private interactionSequence = 0;
  private readonly pending: PendingInteractionLedger;

  constructor(private readonly options: ACPInteractionControllerOptions) {
    this.pending = new PendingInteractionLedger(options.interactionPort);
  }

  async requestPermission(
    request: ACPRequestPermissionRequest,
    signal?: AbortSignal,
  ): Promise<ACPRequestPermissionResponse> {
    const turnId = this.options.getTurnId();
    if (this.disposed || !turnId || signal?.aborted) {
      return CANCELLED_RESPONSE;
    }

    const interactionId = [
      this.options.sessionInstanceId,
      'approval',
      ++this.interactionSequence,
    ].join(':');
    const pending = this.pending.begin(interactionId, signal);
    if (!pending) return CANCELLED_RESPONSE;

    try {
      const input = normalizeToolInput(request.toolCall.rawInput);
      const presentation = this.options.presentPermission?.(request, input) ?? {
        description: request.toolCall.title || 'ACP permission request',
        toolName: request.toolCall.title || request.toolCall.kind || 'tool',
      };
      const response = await this.options.interactionPort.requestApproval({
        ...(presentation.blockedPath
          ? { blockedPath: presentation.blockedPath }
          : {}),
        decisionOptions: buildACPApprovalDecisionOptions(request.options),
        ...(presentation.decisionReason
          ? { decisionReason: presentation.decisionReason }
          : {}),
        description: presentation.description,
        input,
        interactionId,
        kind: 'approval',
        nativeContext: {
          sessionId: request.sessionId,
          toolCallId: request.toolCall.toolCallId,
        },
        sessionInstanceId: this.options.sessionInstanceId,
        toolName: presentation.toolName,
        turnId,
      }, pending.signal);

      if (this.disposed || pending.signal.aborted) return CANCELLED_RESPONSE;
      if (this.pending.isStaleResponse(pending, response)) {
        this.pending.settle(pending, 'native-rejected');
        return CANCELLED_RESPONSE;
      }
      if (this.options.getTurnId() !== turnId) {
        this.pending.settle(pending, 'superseded');
        return CANCELLED_RESPONSE;
      }

      this.pending.settle(pending, 'resolved');
      return mapACPApprovalDecision(response.decision, request.options);
    } catch {
      this.pending.settle(pending, 'cancelled');
      return CANCELLED_RESPONSE;
    } finally {
      this.pending.release(pending);
    }
  }

  dismissAll(reason: ProviderInteractionDismissReason): void {
    this.pending.dismissAll(reason);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.dismissAll('session-disposed');
  }
}

function normalizeToolInput(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return value === undefined ? {} : { value };
}
