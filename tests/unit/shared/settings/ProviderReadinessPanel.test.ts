/** @jest-environment jsdom */

jest.mock('obsidian', () => ({
  Setting: class MockSetting {
    setName(): this { return this; }
    setDesc(): this { return this; }
    setHeading(): this { return this; }
  },
}));

import { renderProviderReadinessPanel } from '@/shared/settings/ProviderReadinessPanel';

Object.defineProperty(HTMLElement.prototype, 'setText', {
  configurable: true,
  value(this: HTMLElement, text: string): void {
    this.textContent = text;
  },
});

describe('renderProviderReadinessPanel', () => {
  it('shows an actionable hint for each blocked or attention check', async () => {
    const container = document.createElement('div');

    renderProviderReadinessPanel({
      container,
      providerName: 'Test',
      getSnapshot: async () => ({
        status: 'blocked',
        checks: [
          { id: 'enabled', status: 'ready' },
          { id: 'cli', status: 'blocked', remediation: 'configureCli' },
          { id: 'models', status: 'attention', remediation: 'refreshModels' },
          { id: 'selection', status: 'blocked', remediation: 'selectModel' },
        ],
      }),
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const hints = [...container.querySelectorAll('.claudian-provider-readiness-check-hint')]
      .map((element) => element.textContent);
    expect(hints).toEqual([
      "Set a valid CLI path or make the CLI available on Obsidian's PATH.",
      'Check the provider login or session, then check again to load models.',
      'Select at least one chat model below.',
    ]);
  });
});
