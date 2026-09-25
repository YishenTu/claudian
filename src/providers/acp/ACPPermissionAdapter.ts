import type { ProviderApprovalDecisionOption } from '../../core/execution';
import type { ApprovalDecision } from '../../core/types';
import type {
  ACPPermissionOption,
  ACPPermissionOptionKind,
  ACPRequestPermissionResponse,
} from './types';

const CANCELLED_RESPONSE: ACPRequestPermissionResponse = {
  outcome: { outcome: 'cancelled' },
};

export function mapACPApprovalDecision(
  decision: ApprovalDecision,
  options: readonly ACPPermissionOption[],
): ACPRequestPermissionResponse {
  if (decision === 'allow') {
    return selectPermissionOption(options, ['allow_once', 'allow_always']);
  }

  if (decision === 'allow-always') {
    return selectPermissionOption(options, ['allow_always', 'allow_once']);
  }

  if (decision === 'deny') {
    return selectPermissionOption(options, ['reject_once', 'reject_always']);
  }

  if (typeof decision === 'object' && decision.type === 'select-option') {
    const option = options.find((entry) => entry.optionId === decision.value);
    return option ? selectedResponse(option) : CANCELLED_RESPONSE;
  }

  return CANCELLED_RESPONSE;
}

export function buildACPApprovalDecisionOptions(
  options: readonly ACPPermissionOption[],
): ProviderApprovalDecisionOption[] {
  return options.map((option) => ({
    ...(option.kind === 'allow_once'
      ? { decision: 'allow' as const }
      : option.kind === 'allow_always'
      ? { decision: 'allow-always' as const }
      : {}),
    label: option.name,
    value: option.optionId,
  }));
}

function selectPermissionOption(
  options: readonly ACPPermissionOption[],
  preferredKinds: readonly ACPPermissionOptionKind[],
): ACPRequestPermissionResponse {
  for (const kind of preferredKinds) {
    const option = options.find((entry) => entry.kind === kind);
    if (option) {
      return selectedResponse(option);
    }
  }

  return CANCELLED_RESPONSE;
}

function selectedResponse(option: ACPPermissionOption): ACPRequestPermissionResponse {
  return {
    outcome: {
      optionId: option.optionId,
      outcome: 'selected',
    },
  };
}
