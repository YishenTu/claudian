import type { ProviderModelCatalog } from '../../core/providers/models/ProviderModelCatalog';
import type { ProviderId } from '../../core/providers/types';
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
      ? `${providerName} model catalog is stale. Click Discover to refresh it.` : ''));
  };
  const picker = renderProviderModelPicker({
    container,
    providerName,
    modifier: providerId,
    getState: () => catalog.getSnapshot(),
    emptyCatalogText: `No ${providerName} models reported. Check your configuration and click Discover.`,
    loadingCatalogText: `Loading ${providerName} models…`,
    async loadCatalog(force) { await catalog.refresh({ force }); },
    onSelectedIdsChange: ids => catalog.select(ids),
    onAliasesChange: aliases => catalog.setAliases(aliases),
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
