import { createMockEl } from '@test/helpers/MockElement';

import type { UsageInfo } from '@/core/types';
import { ContextUsageMeter } from '@/features/chat/ui/InputToolbar';

jest.mock('obsidian', () => ({
  Notice: jest.fn(),
  setIcon: jest.fn(),
}));

function makeUsage(overrides: Partial<UsageInfo> = {}): UsageInfo {
  return {
    inputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    contextWindow: 200000,
    contextTokens: 0,
    percentage: 0,
    ...overrides,
  };
}

describe('ContextUsageMeter', () => {
  let parentEl: any;
  let meter: ContextUsageMeter;

  beforeEach(() => {
    jest.clearAllMocks();
    parentEl = createMockEl();
    meter = new ContextUsageMeter(parentEl);
  });

  it('should remain hidden when update called with null', () => {
    meter.update(null);
    const container = parentEl.querySelector('.claudian-context-meter');
    expect(container?.style.display).toBe('none');
    meter.update(makeUsage({ contextTokens: 50000, contextWindow: 200000, percentage: 25 }));
    expect(container?.style.display).toBe('flex');
    meter.update(null);
    expect(container?.style.display).toBe('none');
  });

  it('should remain hidden when contextTokens is 0', () => {
    meter.update(makeUsage({ contextTokens: 0, contextWindow: 200000, percentage: 0 }));
    const container = parentEl.querySelector('.claudian-context-meter');
    expect(container?.style.display).toBe('none');
    meter.update(makeUsage({ contextTokens: 50000, contextWindow: 200000, percentage: 25 }));
    expect(container?.style.display).toBe('flex');
    meter.update(makeUsage({ contextTokens: 0, contextWindow: 200000, percentage: 0 }));
    expect(container?.style.display).toBe('none');
  });

  it('should expose usage details to assistive technology', () => {
    const container = parentEl.querySelector('.claudian-context-meter');
    expect(container).not.toBeNull();
    expect(container?.style.display).toBe('none');
    meter.update(makeUsage({ contextTokens: 50000, contextWindow: 200000, percentage: 25 }));
    expect(container?.style.display).toBe('flex');
    expect(parentEl.querySelector('.claudian-context-meter-percent')?.textContent).toBe('25%');
    expect(container?.getAttribute('data-tooltip')).toBeNull();
    expect(container?.getAttribute('role')).toBe('progressbar');
    expect(container?.getAttribute('aria-label')).toBe('Context usage: 25% · 50k / 200k');
    expect(container?.getAttribute('aria-valuemin')).toBe('0');
    expect(container?.getAttribute('aria-valuemax')).toBe('100');
    expect(container?.getAttribute('aria-valuenow')).toBe('25');
    expect(container?.getAttribute('aria-valuetext')).toBe('50k / 200k');
  });

  it('should remove warning class when usage drops below 80%', () => {
    meter.update(makeUsage({ contextTokens: 170000, contextWindow: 200000, percentage: 85 }));
    const warningContainer = parentEl.querySelector('.claudian-context-meter');
    expect(warningContainer?.hasClass('warning')).toBe(true);
    expect(warningContainer?.getAttribute('aria-label')).toBe('Context usage: 85% · 170k / 200k (Approaching limit, run `/compact` to continue)');
    meter.update(makeUsage({ contextTokens: 50000, contextWindow: 200000, percentage: 25 }));
    const container = parentEl.querySelector('.claudian-context-meter');
    expect(container?.hasClass('warning')).toBe(false);
  });

  it('should format small token counts without k suffix', () => {
    meter.update(makeUsage({ contextTokens: 500, contextWindow: 200000, percentage: 0 }));
    const container = parentEl.querySelector('.claudian-context-meter');
    expect(container?.getAttribute('aria-label')).toBe('Context usage: 0% · 500 / 200k');
  });

  it('should not add compact reminder to tooltip when usage ≤ 80%', () => {
    meter.update(makeUsage({ contextTokens: 160000, contextWindow: 200000, percentage: 80 }));
    const container = parentEl.querySelector('.claudian-context-meter');
    expect(container?.getAttribute('aria-label')).toBe('Context usage: 80% · 160k / 200k');
  });
});
