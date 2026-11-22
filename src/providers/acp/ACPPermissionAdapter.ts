import type { ProviderApprovalChoice } from '../../core/execution';
import type {
  ACPPermissionOption,
  ACPRequestPermissionResponse,
} from './types';

export const CANCELLED_ACP_PERMISSION_RESPONSE: ACPRequestPermissionResponse = {
  outcome: { outcome: 'cancelled' },
};

/** Claudian's own approval: the native one-time allow, else the persistent one, else cancelled. */
export function allowACPPermission(
  options: readonly ACPPermissionOption[],
): ACPRequestPermissionResponse {
  const option = options.find(entry => entry.kind === 'allow_once')
    ?? options.find(entry => entry.kind === 'allow_always');
  return option ? selectedResponse(option) : CANCELLED_ACP_PERMISSION_RESPONSE;
}

/** Every native option in native order, each answering with its own optionId. */
export function buildACPApprovalChoices(
  options: readonly ACPPermissionOption[],
  describeOption?: (option: ACPPermissionOption) => string | undefined,
): ProviderApprovalChoice<ACPRequestPermissionResponse>[] {
  return options.map((option) => ({
    option: {
      ...(option.kind === 'allow_once'
        ? { decision: 'allow' as const }
        : option.kind === 'allow_always'
        ? { decision: 'allow-always' as const }
        : {}),
      ...(describeOption ? { description: describeOption(option) } : {}),
      label: option.name,
      value: option.optionId,
    },
    reply: selectedResponse(option),
  }));
}

function selectedResponse(option: ACPPermissionOption): ACPRequestPermissionResponse {
  return {
    outcome: {
      optionId: option.optionId,
      outcome: 'selected',
    },
  };
}
