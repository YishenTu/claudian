import type { ProviderChatUIConfig } from '@/core/providers/types';

export interface ServiceTierActionSettings extends Record<string, unknown> {
  serviceTier: string;
}

export interface ServiceTierActionContext {
  getSettings(): ServiceTierActionSettings;
  getUIConfig(): Pick<ProviderChatUIConfig, 'getServiceTierToggle'>;
  onServiceTierChange(serviceTier: string): Promise<void>;
}

/** Fast mode on/off: the standard tier switches to Fast, any accelerated tier back to standard. */
export async function toggleServiceTier(
  context: ServiceTierActionContext,
): Promise<boolean> {
  const policy = context.getUIConfig().getServiceTierToggle?.(context.getSettings()) ?? null;
  const standardValue = policy?.options[0]?.value;
  if (!policy || standardValue === undefined) {
    return false;
  }

  // Turning acceleration off needs no Fast tier; only turning it on does.
  const next = policy.selectedValue === standardValue ? policy.fastValue : standardValue;
  if (next === null) {
    return false;
  }

  await context.onServiceTierChange(next);
  return true;
}
