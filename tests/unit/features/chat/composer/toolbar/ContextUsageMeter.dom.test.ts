/** @jest-environment jsdom */

import { within } from '@testing-library/dom';
import { axe } from 'jest-axe';

import type { UsageInfo } from '@/core/types';
import { ContextUsageMeter } from '@/features/chat/composer/toolbar/ContextUsageMeter';

HTMLElement.prototype.empty = function () { this.replaceChildren(); };
HTMLElement.prototype.addClass = function (...classes) { this.classList.add(...classes); };
HTMLElement.prototype.removeClass = function (...classes) { this.classList.remove(...classes); };
HTMLElement.prototype.hasClass = function (name) { return this.classList.contains(name); };
HTMLElement.prototype.toggleClass = function (classes, value) {
  for (const name of typeof classes === 'string' ? [classes] : classes) this.classList.toggle(name, value);
};

// The visibility utility from styles, so role queries skip a hidden meter.
const hiddenStyle = document.head.appendChild(document.createElement('style'));
hiddenStyle.textContent = '.claudian-hidden { display: none; }';

afterEach(() => {
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
  'hides the context meter for %p, including after a visible report', emptyUsage => {
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
