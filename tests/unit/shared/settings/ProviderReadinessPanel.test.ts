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

  it('shows checking feedback while a refresh is in flight', async () => {
    const container = document.createElement('div');
    let finishRefresh!: () => void;
    const onRefresh = jest.fn(() => new Promise<void>(resolve => { finishRefresh = resolve; }));

    renderProviderReadinessPanel({
      container,
      providerName: 'Test',
      getSnapshot: async () => ({ status: 'ready', checks: [] }),
      onRefresh,
    });
    await new Promise<void>(resolve => setTimeout(resolve, 0));

    const button = container.querySelector<HTMLButtonElement>('.claudian-provider-readiness-refresh');
    expect(button).not.toBeNull();
    button?.click();
    await new Promise<void>(resolve => setTimeout(resolve, 0));

    expect(button?.disabled).toBe(true);
    expect(button?.textContent).toBe('Checking provider readiness…');
    expect(button?.getAttribute('aria-busy')).toBe('true');

    finishRefresh();
    await new Promise<void>(resolve => setTimeout(resolve, 140));

    expect(button?.disabled).toBe(false);
    expect(button?.textContent).toBe('Check again');
    expect(button?.getAttribute('aria-busy')).toBeNull();
  });
});
