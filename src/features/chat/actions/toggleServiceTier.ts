import type { ProviderChatUIConfig } from '../../../core/providers/types';

export interface ServiceTierActionSettings extends Record<string, unknown> {
  serviceTier: string;
}

export interface ServiceTierActionContext {
  getSettings(): ServiceTierActionSettings;
  getUIConfig(): Pick<ProviderChatUIConfig, 'getServiceTierToggle'>;
  onServiceTierChange(serviceTier: string): Promise<void>;
}

export async function toggleServiceTier(
  context: ServiceTierActionContext,
): Promise<boolean> {
  const settings = context.getSettings();
  const toggleConfig = context.getUIConfig().getServiceTierToggle?.(settings) ?? null;
  if (!toggleConfig) {
    return false;
  }

  const next = settings.serviceTier === toggleConfig.activeValue
    ? toggleConfig.inactiveValue
    : toggleConfig.activeValue;
  await context.onServiceTierChange(next);
  return true;
}
