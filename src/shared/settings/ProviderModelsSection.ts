import type { ProviderModelCatalog } from '../../core/providers/models/ProviderModelCatalog';
import type { ProviderId } from '../../core/providers/types';
import { t } from '../../i18n/i18n';
import { type ProviderModelPickerController, renderProviderModelPicker } from './ProviderModelPicker';

export function renderProviderModelsSection(
  container: HTMLElement,
  providerId: ProviderId,
  providerName: string,
  catalog: ProviderModelCatalog,
  onUpdate?: () => void,
): ProviderModelPickerController {
  const status = container.createDiv({ attr: { role: 'status', 'aria-live': 'polite' } });
  const updateStatus = () => {
    const snapshot = catalog.getSnapshot();
    status.setText(snapshot.error ?? (snapshot.stale
      ? t('settings.modelPicker.stale', { provider: providerName }) : ''));
  };
  const picker = renderProviderModelPicker({
    container,
    providerName,
    modifier: providerId,
    getState: () => catalog.getSnapshot(),
    emptyCatalogText: t('settings.modelPicker.emptyCatalog', { provider: providerName }),
    loadingCatalogText: t('settings.modelPicker.loadingCatalog', { provider: providerName }),
    async loadCatalog(force) { await catalog.refresh({ force }); },
    onSelectionChange: change => catalog.changeSelection(change),
    onAliasChange: (modelId, alias) => catalog.setAlias(modelId, alias),
  });
  const refresh = () => {
    updateStatus();
    picker.refresh();
    onUpdate?.();
  };
  const unsubscribe = catalog.observe(refresh);
  refresh();
  return {
    refresh,
    dispose() {
      unsubscribe();
      picker.dispose();
    },
  };
}
