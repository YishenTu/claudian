import type {
  ProviderId,
  ProviderSettingsTabRendererContext,
} from '../../core/providers/types';
import { t } from '../../i18n/i18n';

export interface ProviderModelEnablementWarning {
  context: ProviderSettingsTabRendererContext;
  refresh(): void;
}

interface ProviderModelEnablementWarningOptions {
  getHasEnabledModels(): boolean;
  getIsEnabled(): boolean;
  providerId: ProviderId;
  providerName: string;
}

export function renderProviderModelEnablementWarning(
  container: HTMLElement,
  context: ProviderSettingsTabRendererContext,
  options: ProviderModelEnablementWarningOptions,
): ProviderModelEnablementWarning {
  const warningEl = container.createDiv({
    cls: 'claudian-provider-model-warning claudian-setting-validation claudian-setting-validation-warning claudian-hidden',
    text: t('settings.providerEnablement.noModelsWarning', {
      provider: options.providerName,
    }),
  });

  const refresh = (): void => {
    const shouldShow = options.getIsEnabled() && !options.getHasEnabledModels();
    warningEl.toggleClass('claudian-hidden', !shouldShow);
  };

  const warningAwareContext: ProviderSettingsTabRendererContext = {
    ...context,
    notifyProviderModelOptionsChanged(providerId) {
      context.notifyProviderModelOptionsChanged(providerId);
      if (providerId === options.providerId) {
        refresh();
      }
    },
  };

  refresh();
  return { context: warningAwareContext, refresh };
}
