import type {
  ProviderApprovalDecisionOption,
  ProviderApprovalInteractionRequest,
  ProviderApprovalInteractionResponse,
} from '@/core/execution';
import type { ApprovalDecision } from '@/core/types';
import { t } from '@/i18n/i18n';

/** A provider's deny / allow-once / always-allow choices, as an approval request must carry them. */
export function approvalDecisionOptions(): ProviderApprovalDecisionOption[] {
  return [
    { decision: 'deny', label: t('chat.approval.deny'), value: 'Deny' },
    { decision: 'allow', label: t('chat.approval.allowOnce'), value: 'Allow once' },
    { decision: 'allow-always', label: t('chat.approval.alwaysAllow'), value: 'Always allow' },
  ];
}

/** Answers as the panel would: with the value of the first offered option carrying `decision`. */
export function answerApproval(
  request: ProviderApprovalInteractionRequest,
  decision: ApprovalDecision,
): ProviderApprovalInteractionResponse {
  const option = request.decisionOptions.find(candidate => candidate.decision === decision);
  if (!option) throw new Error(`Approval "${request.interactionId}" offers no ${decision} option`);
  return { interactionId: request.interactionId, value: option.value };
}
