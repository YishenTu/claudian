import type {
  ProviderInteractionDismissReason,
  ProviderInteractionPort,
} from '../../core/execution';
import {
  buildAcpApprovalDecisionOptions,
  mapAcpApprovalDecision,
} from './AcpPermissionAdapter';
import type {
  AcpRequestPermissionRequest,
  AcpRequestPermissionResponse,
} from './types';

const CANCELLED_RESPONSE: AcpRequestPermissionResponse = {
  outcome: { outcome: 'cancelled' },
};

interface PendingInteraction {
  readonly abortController: AbortController;
  dismissed: boolean;
}

export interface AcpPermissionPresentation {
  readonly blockedPath?: string;
  readonly decisionReason?: string;
  readonly description: string;
  readonly toolName: string;
}

export interface AcpInteractionControllerOptions {
  readonly getTurnId: () => string | null;
  readonly interactionPort: ProviderInteractionPort;
  readonly presentPermission?: (
    request: AcpRequestPermissionRequest,
    input: Readonly<Record<string, unknown>>,
  ) => AcpPermissionPresentation;
  readonly sessionInstanceId: string;
}

export class AcpInteractionController {
  private disposed = false;
  private interactionSequence = 0;
  private readonly pending = new Map<string, PendingInteraction>();

  constructor(private readonly options: AcpInteractionControllerOptions) {}

  async requestPermission(
    request: AcpRequestPermissionRequest,
    signal?: AbortSignal,
  ): Promise<AcpRequestPermissionResponse> {
    const turnId = this.options.getTurnId();
    if (this.disposed || !turnId || signal?.aborted) {
      return CANCELLED_RESPONSE;
    }

    const interactionId = [
      this.options.sessionInstanceId,
      'approval',
      ++this.interactionSequence,
    ].join(':');
    const abortController = new AbortController();
    const pending: PendingInteraction = {
      abortController,
      dismissed: false,
    };
    this.pending.set(interactionId, pending);

    const abortFromCaller = (): void => {
      this.dismiss(interactionId, 'cancelled');
      abortController.abort();
    };
    signal?.addEventListener('abort', abortFromCaller, { once: true });

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
        decisionOptions: buildAcpApprovalDecisionOptions(request.options),
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
      }, abortController.signal);

      if (response.interactionId !== interactionId) {
        this.dismiss(interactionId, 'native-rejected');
        return CANCELLED_RESPONSE;
      }
      if (this.options.getTurnId() !== turnId) {
        this.dismiss(interactionId, 'superseded');
        return CANCELLED_RESPONSE;
      }

      this.dismiss(interactionId, 'resolved');
      return mapAcpApprovalDecision(response.decision, request.options);
    } catch {
      this.dismiss(interactionId, 'cancelled');
      return CANCELLED_RESPONSE;
    } finally {
      signal?.removeEventListener('abort', abortFromCaller);
      this.pending.delete(interactionId);
    }
  }

  dismissAll(reason: ProviderInteractionDismissReason): void {
    for (const [interactionId, pending] of this.pending) {
      this.dismiss(interactionId, reason);
      pending.abortController.abort();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.dismissAll('session-disposed');
  }

  private dismiss(
    interactionId: string,
    reason: ProviderInteractionDismissReason,
  ): void {
    const pending = this.pending.get(interactionId);
    if (!pending || pending.dismissed) return;
    pending.dismissed = true;
    this.options.interactionPort.dismissInteraction(interactionId, reason);
  }
}

function normalizeToolInput(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return value === undefined ? {} : { value };
}
