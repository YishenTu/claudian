/** @jest-environment jsdom */

import { within } from '@testing-library/dom';
import { axe } from 'jest-axe';

import type { UsageInfo } from '@/core/types';
import { ContextUsageMeter } from '@/features/chat/ui/InputToolbar';

HTMLElement.prototype.addClass = function (...classes) { this.classList.add(...classes); };
HTMLElement.prototype.removeClass = function (...classes) { this.classList.remove(...classes); };
HTMLElement.prototype.toggleClass = function (classes, value) {
  for (const name of typeof classes === 'string' ? [classes] : classes) this.classList.toggle(name, value);
};

it('uses one native context tooltip and updates its warning with usage', async () => {
  const host = document.body.createDiv();
  const meter = new ContextUsageMeter(host);
  const usage = { contextTokens: 170000, contextWindow: 200000, percentage: 85 } as UsageInfo;
  meter.update(usage);
  const gauge = within(host).getByRole('progressbar', {
    name: 'Context usage: 170k / 200k (Approaching limit, run `/compact` to continue)',
  });
  expect(gauge.hasAttribute('data-tooltip')).toBe(false);
  expect(gauge.hasAttribute('title')).toBe(false);
  expect(gauge.getAttribute('aria-valuenow')).toBe('85');
  meter.update({ ...usage, contextTokens: 50000, percentage: 25 });
  expect(within(host).getByRole('progressbar', { name: 'Context usage: 50k / 200k' })).toBe(gauge);
  expect(gauge.getAttribute('aria-valuenow')).toBe('25');
  expect((await axe(host)).violations).toEqual([]);
  host.remove();
});
