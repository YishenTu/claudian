/** @vitest-environment jsdom */

import { axe } from '@test/helpers/accessibility';
import { within } from '@testing-library/dom';

import type { UsageInfo } from '@/core/types';
import { ContextUsageMeter } from '@/features/chat/composer/toolbar/ContextUsageMeter';
import { setLocale } from '@/i18n/i18n';

// The visibility utility from styles, so role queries skip a hidden meter.
const hiddenStyle = document.head.appendChild(document.createElement('style'));
hiddenStyle.textContent = '.claudian-hidden { display: none; }';

afterEach(() => {
  setLocale('en');
  document.body.replaceChildren();
});

it('shows accessible context usage with one native tooltip and warns only above 80%', async () => {
  const host = document.body.createDiv();
  const meter = new ContextUsageMeter(host);
  const usage = { contextTokens: 170000, contextWindow: 200000, percentage: 85 } as UsageInfo;
  expect(within(host).queryByRole('progressbar')).toBeNull();
  meter.update(usage);
  const gauge = within(host).getByRole('progressbar', {
    name: 'Context usage: 85% · 170k / 200k (Approaching limit, run `/compact` to continue)',
  });
  expect(gauge.hasAttribute('data-tooltip')).toBe(false);
  expect(gauge.hasAttribute('title')).toBe(false);
  expect(gauge.getAttribute('aria-valuenow')).toBe('85');
  expect(gauge.classList.contains('warning')).toBe(true);
  meter.update({ ...usage, contextTokens: 50000, percentage: 25 });
  expect(within(host).getByRole('progressbar', { name: 'Context usage: 25% · 50k / 200k' })).toBe(gauge);
  expect(gauge.getAttribute('aria-valuenow')).toBe('25');
  expect(gauge.getAttribute('aria-valuemin')).toBe('0');
  expect(gauge.getAttribute('aria-valuemax')).toBe('100');
  expect(gauge.getAttribute('aria-valuetext')).toBe('50k / 200k');
  expect(within(gauge).getByText('25%')).toBeDefined();
  expect(gauge.classList.contains('warning')).toBe(false);
  expect((await axe(host)).violations).toEqual([]);

  meter.update({ ...usage, contextTokens: 160000, percentage: 80 });
  expect(within(host).getByRole('progressbar', { name: 'Context usage: 80% · 160k / 200k' })).toBe(gauge);
  expect(gauge.classList.contains('warning')).toBe(false);
  meter.update({ ...usage, contextTokens: 500, percentage: 0 });
  expect(within(host).getByRole('progressbar', { name: 'Context usage: 0% · 500 / 200k' })).toBe(gauge);
});

it.each([null, { contextTokens: 0, contextWindow: 200000, percentage: 0 } as UsageInfo])(
  'hides the context meter for %o, including after a visible report', emptyUsage => {
    const host = document.body.createDiv();
    const meter = new ContextUsageMeter(host);
    meter.update(emptyUsage);
    expect(within(host).queryByRole('progressbar')).toBeNull();
    meter.update({ contextTokens: 50000, contextWindow: 200000, percentage: 25 } as UsageInfo);
    expect(within(host).getByRole('progressbar', { name: 'Context usage: 25% · 50k / 200k' })).toBeDefined();
    meter.update(emptyUsage);
    expect(within(host).queryByRole('progressbar')).toBeNull();
  },
);

it('localizes the context meter name and hint while preserving reported values and visibility', async () => {
  setLocale('zh-CN');
  const host = document.body.createDiv();
  const meter = new ContextUsageMeter(host);
  const usage = { contextTokens: 170000, contextWindow: 200000, percentage: 85 } as UsageInfo;
  expect(within(host).queryByRole('progressbar')).toBeNull();
  meter.setVisible(true);
  const gauge = within(host).getByRole('progressbar', { name: '上下文用量' });

  meter.update(usage);
  expect(within(host).getByRole('progressbar', {
    name: '上下文用量：85% · 170k / 200k（接近上限，运行 `/compact` 以继续）',
  })).toBe(gauge);
  expect(gauge.hasAttribute('data-tooltip')).toBe(false);
  expect(gauge.hasAttribute('title')).toBe(false);
  expect(gauge.getAttribute('aria-valuenow')).toBe('85');
  expect(gauge.getAttribute('aria-valuemin')).toBe('0');
  expect(gauge.getAttribute('aria-valuemax')).toBe('100');
  expect(gauge.getAttribute('aria-valuetext')).toBe('170k / 200k');
  expect(within(gauge).getByText('85%')).toBeDefined();
  expect(gauge.classList.contains('warning')).toBe(true);
  expect((await axe(host)).violations).toEqual([]);

  meter.update({ ...usage, contextTokens: 50000, percentage: 25 });
  expect(within(host).getByRole('progressbar', { name: '上下文用量：25% · 50k / 200k' })).toBe(gauge);
  expect(gauge.getAttribute('aria-valuenow')).toBe('25');
  expect(gauge.getAttribute('aria-valuetext')).toBe('50k / 200k');
  expect(within(gauge).getByText('25%')).toBeDefined();
  expect(gauge.classList.contains('warning')).toBe(false);

  meter.update({ ...usage, contextTokens: 160000, percentage: 80 });
  expect(within(host).getByRole('progressbar', { name: '上下文用量：80% · 160k / 200k' })).toBe(gauge);
  expect(gauge.getAttribute('aria-valuenow')).toBe('80');
  expect(gauge.getAttribute('aria-valuetext')).toBe('160k / 200k');
  expect(within(gauge).getByText('80%')).toBeDefined();
  expect(gauge.classList.contains('warning')).toBe(false);

  meter.update({ ...usage, contextTokens: 500, percentage: 0 });
  expect(within(host).getByRole('progressbar', { name: '上下文用量：0% · 500 / 200k' })).toBe(gauge);
  expect(gauge.getAttribute('aria-valuenow')).toBe('0');
  expect(gauge.getAttribute('aria-valuetext')).toBe('500 / 200k');
  expect(within(gauge).getByText('0%')).toBeDefined();

  meter.update(null);
  expect(within(host).queryByRole('progressbar')).toBeNull();
  meter.update(usage);
  expect(within(host).getByRole('progressbar', {
    name: '上下文用量：85% · 170k / 200k（接近上限，运行 `/compact` 以继续）',
  })).toBe(gauge);
  meter.update({ ...usage, contextTokens: 0, percentage: 0 });
  expect(within(host).queryByRole('progressbar')).toBeNull();
});
