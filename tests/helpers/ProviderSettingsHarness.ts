import { within } from '@testing-library/dom';

import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { ProviderSettingsTabRenderer, ProviderSettingsTabRendererContext } from '@/core/providers/types';

/** Mount the real environment, model and execution-target sections over the shared Obsidian host. */
export function mountProviderSettings(
  renderer: ProviderSettingsTabRenderer,
  host: ProviderHost,
  context: Partial<Omit<ProviderSettingsTabRendererContext, 'plugin'>> = {},
) {
  const container = document.body.createDiv();
  const handle = renderer.render(container, {
    plugin: host,
    notifyProviderModelOptionsChanged() {},
    renderCustomContextLimits() {},
    ...context,
  });
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    handle?.dispose();
    container.remove();
  };
  onTestFinished(dispose);
  return { container, ui: within(container), refresh: () => handle?.refresh(), dispose };
}
