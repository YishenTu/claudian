import { resolveServiceTierToggleTarget } from '@/core/providers/serviceTier';
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
  const next = resolveServiceTierToggleTarget(policy);
  if (next === null) {
    return false;
  }

  await context.onServiceTierChange(next);
  return true;
}
