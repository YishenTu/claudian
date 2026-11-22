import type {
  ApprovalDecision,
  AskUserAnswers,
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
  /** Identifies the option in the answer; unique within a request. */
  readonly value: string;
  /** Scripting metadata (docs/plugin-api.md); routers decode the answer by `value`, never by this tag. */
  readonly decision?: ApprovalDecision;
}

/** An offered option paired with the native reply it sends. */
export interface ProviderApprovalChoice<Reply> {
  readonly option: ProviderApprovalDecisionOption;
  readonly reply: Reply;
}

export interface ProviderApprovalInteractionRequest
  extends ProviderInteractionIdentity {
  readonly kind: 'approval';
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly description: string;
  readonly decisionReason?: string;
  readonly blockedPath?: string;
  /** The native choices, in native order; Claudian invents none for a provider. */
  readonly decisionOptions: readonly ProviderApprovalDecisionOption[];
}

export interface ProviderApprovalInteractionResponse {
  readonly interactionId: string;
  /** The selected option's `value`; null when the request was dismissed or cancelled. */
  readonly value: string | null;
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
  dismissInteraction(
    interactionId: string,
    reason: ProviderInteractionDismissReason,
  ): void;
}

/** The reply of the offered option an answer selects; undefined for a dismissal or a value nothing offered. */
export function resolveApprovalChoice<Reply>(
  choices: readonly ProviderApprovalChoice<Reply>[],
  value: string | null,
): Reply | undefined {
  return value === null ? undefined : choices.find(choice => choice.option.value === value)?.reply;
}
