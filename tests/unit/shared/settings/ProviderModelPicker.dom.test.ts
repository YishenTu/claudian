/** @jest-environment jsdom */

jest.mock('obsidian', () => ({
  Setting: class MockSetting {
    settingEl = { addClass(): void {} };
    setDesc(): this { return this; }
    setName(): this { return this; }
  },
}));

import { renderProviderModelPicker } from '@/shared/settings/ProviderModelPicker';

describe('ProviderModelPicker catalog status', () => {
  beforeAll(() => {
    const prototype = HTMLElement.prototype as HTMLElement & {
      empty(): void;
      setText(value: string): void;
      toggleClass(className: string, force: boolean): void;
    };
    prototype.empty = function empty(): void {
      this.replaceChildren();
    };
    prototype.setText = function setText(value: string): void {
      this.textContent = value;
    };
    prototype.toggleClass = function toggleClass(className: string, force: boolean): void {
      this.classList.toggle(className, force);
    };
  });

  it('marks the picker as failed when refreshing a cached catalog fails', async () => {
    const container = document.createElement('div');
    const picker = renderProviderModelPicker({
      container,
      emptyCatalogText: 'empty',
      failedCatalogText: 'failed',
      getState: () => ({
        aliases: {},
        catalogStatus: 'ready',
        discoveredCount: 1,
        models: [{ id: 'model-1', name: 'Model 1' }],
        selectedIds: ['model-1'],
      }),
      loadCatalog: async () => 'failed',
      loadingCatalogText: 'loading',
      modifier: 'test',
      onAliasesChange: async () => {},
      onSelectedIdsChange: async () => {},
      providerName: 'Test',
    });

    const refreshButton = container.querySelector<HTMLButtonElement>(
      '.claudian-provider-model-picker-action',
    );
    refreshButton?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(container.querySelector('.claudian-provider-model-picker')
      ?.getAttribute('data-catalog-status')).toBe('failed');
    picker.refresh();
  });
});
