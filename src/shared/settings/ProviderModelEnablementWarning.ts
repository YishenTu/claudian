import type {
  ProviderId,
  ProviderSettingsTabRendererContext,
} from '../../core/providers/types';
import { t } from '../../i18n/i18n';

export interface ProviderModelEnablementWarning {
  context: ProviderSettingsTabRendererContext;
  refresh(): void;
}

export interface ProviderEnablementWarning {
  hide(): void;
  showFor(durationMs?: number): void;
}

interface StyledProviderWarning {
  setVisible(visible: boolean): void;
}

interface ProviderModelEnablementWarningOptions {
  getHasEnabledModels(): boolean;
  getIsEnabled(): boolean;
  providerId: ProviderId;
  providerName: string;
}

const PROVIDER_WARNING_CLASSES = [
  'claudian-provider-model-warning',
  'claudian-setting-validation',
  'claudian-setting-validation-warning',
  'claudian-hidden',
].join(' ');

const LAST_PROVIDER_WARNING_DURATION_MS = 10_000;

function renderProviderWarning(
  container: HTMLElement,
  text: string,
  attr?: Record<string, string>,
): StyledProviderWarning {
  const warningEl = container.createDiv({
    ...(attr ? { attr } : {}),
    cls: PROVIDER_WARNING_CLASSES,
    text,
  });

  const setVisible = (visible: boolean): void => {
    warningEl.toggleClass('claudian-hidden', !visible);
  };

  setVisible(false);
  return { setVisible };
}

export function renderLastEnabledProviderWarning(
  container: HTMLElement,
): ProviderEnablementWarning {
  const warning = renderProviderWarning(
    container,
    t('settings.providerEnablement.lastProviderWarning'),
    {
      'aria-live': 'polite',
      role: 'status',
    },
  );
  let hideTimer: number | null = null;

  const hide = (): void => {
    if (hideTimer !== null) {
      window.clearTimeout(hideTimer);
      hideTimer = null;
    }
    warning.setVisible(false);
  };

  const showFor = (durationMs = LAST_PROVIDER_WARNING_DURATION_MS): void => {
    hide();
    warning.setVisible(true);
    hideTimer = window.setTimeout(() => {
      hideTimer = null;
      warning.setVisible(false);
    }, durationMs);
  };

  return { hide, showFor };
}

export function renderProviderModelEnablementWarning(
  container: HTMLElement,
  context: ProviderSettingsTabRendererContext,
  options: ProviderModelEnablementWarningOptions,
): ProviderModelEnablementWarning {
  const warning = renderProviderWarning(
    container,
    t('settings.providerEnablement.noModelsWarning', {
      provider: options.providerName,
    }),
  );

  const refresh = (): void => {
    const shouldShow = options.getIsEnabled() && !options.getHasEnabledModels();
    warning.setVisible(shouldShow);
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
