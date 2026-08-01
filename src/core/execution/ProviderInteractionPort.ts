import type {
  ApprovalDecision,
  AskUserAnswers,
  ExitPlanModeDecision,
  ExitPlanModePresentationOptions,
} from '../types';

export interface ProviderInteractionIdentity {
  readonly interactionId: string;
  readonly sessionInstanceId: string;
  readonly turnId: string;
  /** Provider-native request/session/thread identity, opaque to feature code. */
  readonly nativeContext?: unknown;
}

export interface ProviderApprovalDecisionOption {
  readonly label: string;
  readonly description?: string;
  readonly value: string;
  readonly decision?: ApprovalDecision;
}

export interface ProviderApprovalInteractionRequest
  extends ProviderInteractionIdentity {
  readonly kind: 'approval';
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly description: string;
  readonly decisionReason?: string;
  readonly blockedPath?: string;
  readonly decisionOptions?: readonly ProviderApprovalDecisionOption[];
  readonly additionalPermissions?: unknown;
}

export interface ProviderApprovalInteractionResponse {
  readonly interactionId: string;
  readonly decision: ApprovalDecision;
}

export interface ProviderQuestionInteractionRequest
  extends ProviderInteractionIdentity {
  readonly kind: 'question';
  readonly input: Readonly<Record<string, unknown>>;
}

export interface ProviderQuestionInteractionResponse {
  readonly interactionId: string;
  readonly answers: AskUserAnswers | null;
}

export interface ProviderPlanInteractionRequest
  extends ProviderInteractionIdentity {
  readonly kind: 'plan-decision';
  readonly input: Readonly<Record<string, unknown>>;
  readonly presentation?: ExitPlanModePresentationOptions;
}

export interface ProviderPlanInteractionResponse {
  readonly interactionId: string;
  readonly decision: ExitPlanModeDecision | null;
}

export type ProviderInteractionDismissReason =
  | 'resolved'
  | 'cancelled'
  | 'session-disposed'
  | 'conversation-switched'
  | 'provider-transition'
  | 'superseded'
  | 'native-rejected';

/**
 * Feature-owned bidirectional interaction boundary.
 *
 * Every response echoes its request identity. Providers retain native-to-local
 * identity maps and reject stale or cross-turn native resolutions.
 */
export interface ProviderInteractionPort {
  requestApproval(
    request: ProviderApprovalInteractionRequest,
    signal: AbortSignal,
  ): Promise<ProviderApprovalInteractionResponse>;
  askUserQuestion(
    request: ProviderQuestionInteractionRequest,
    signal: AbortSignal,
  ): Promise<ProviderQuestionInteractionResponse>;
  requestPlanDecision(
    request: ProviderPlanInteractionRequest,
    signal: AbortSignal,
  ): Promise<ProviderPlanInteractionResponse>;
  dismissInteraction(
    interactionId: string,
    reason: ProviderInteractionDismissReason,
  ): void;
}
