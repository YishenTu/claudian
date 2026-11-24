import type {
  ProviderModelPolicy,
  ProviderServiceTierOption,
  ProviderServiceTierPolicy,
  ProviderServiceTierSelection,
  ProviderUIOption,
} from './types';

/** Builds a provider-neutral service-tier policy from a Standard option, accelerated tiers, and selected value. */
export function createServiceTierPolicy(params: {
  standard: ProviderUIOption;
  accelerated: readonly Omit<ProviderServiceTierOption, 'level'>[];
  selectedValue: string | null;
}): ProviderServiceTierPolicy | null {
  if (params.accelerated.length === 0) return null;

  const tiers = params.accelerated.map((tier, index): ProviderServiceTierOption => ({
    ...tier,
    level: index + 1,
  })) as [ProviderServiceTierOption, ...ProviderServiceTierOption[]];

  const selectedTier = tiers.find(tier => tier.value === params.selectedValue);
  const selection: ProviderServiceTierSelection = selectedTier
    ? { kind: 'accelerated', option: selectedTier }
    : { kind: 'standard', option: params.standard };

  if (tiers.length === 1 && tiers[0].isFast) {
    return {
      kind: 'fast-switch',
      standard: params.standard,
      fast: tiers[0],
      selection,
    };
  }

  return {
    kind: 'tiers',
    standard: params.standard,
    accelerated: tiers,
    selection,
    fastValue: tiers.find(tier => tier.isFast)?.value ?? null,
  };
}

/**
 * The canonical service tier projected for a model snapshot.
 * Providers or models without a service-tier policy project `'default'`.
 */
export function resolveServiceTier(
  policy: Pick<ProviderModelPolicy, 'getServiceTierPolicy'>,
  settings: Record<string, unknown>,
  fallback = 'default',
): string {
  return policy.getServiceTierPolicy?.(settings)?.selection.option.value ?? fallback;
}

/** Next tier for `/fast` or a Fast switch: Standard -> Fast (if offered), any accelerated tier -> Standard. */
export function resolveServiceTierToggleTarget(
  policy: ProviderServiceTierPolicy | null,
): string | null {
  if (!policy) return null;
  if (policy.selection.kind === 'accelerated') {
    return policy.standard.value;
  }
  return policy.kind === 'fast-switch' ? policy.fast.value : policy.fastValue;
}
