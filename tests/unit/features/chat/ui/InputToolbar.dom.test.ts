/** @jest-environment jsdom */

import '@/providers';

import { TEST_CODEX_CATALOG } from '@test/helpers/codexModels';
import { within } from '@testing-library/dom';
import { axe } from 'jest-axe';

import type { UsageInfo } from '@/core/types';
import { getBlankTabModelOptions } from '@/features/chat/tabs/TabProviderState';
import { ContextUsageMeter, ModelSelector, type ToolbarCallbacks } from '@/features/chat/ui/InputToolbar';
import { claudeChatUIConfig } from '@/providers/claude/ui/ClaudeChatUIConfig';

HTMLElement.prototype.empty = function () { this.replaceChildren(); };
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
    name: 'Context usage: 85% · 170k / 200k (Approaching limit, run `/compact` to continue)',
  });
  expect(gauge.hasAttribute('data-tooltip')).toBe(false);
  expect(gauge.hasAttribute('title')).toBe(false);
  expect(gauge.getAttribute('aria-valuenow')).toBe('85');
  meter.update({ ...usage, contextTokens: 50000, percentage: 25 });
  expect(within(host).getByRole('progressbar', { name: 'Context usage: 25% · 50k / 200k' })).toBe(gauge);
  expect(gauge.getAttribute('aria-valuenow')).toBe('25');
  expect((await axe(host)).violations).toEqual([]);
  host.remove();
});

it('renders saved model order top-to-bottom through the real provider UI config', () => {
  const host = document.body.createDiv();
  const config = {
    discoveredModels: ['opus', 'haiku', 'sonnet'].map(value => ({ value, label: value, description: '' })),
    visibleModels: ['haiku', 'sonnet', 'opus'],
  };
  const selector = new ModelSelector(host, {
    getSettings: () => ({ model: 'haiku', providerConfigs: { claude: config } }),
    getUIConfig: () => claudeChatUIConfig,
  } as unknown as ToolbarCallbacks);
  const dropdown = host.querySelector<HTMLElement>('.claudian-model-dropdown')!;
  const labels = () => within(dropdown).getAllByText(/^(haiku|sonnet|opus)$/).map(node => node.textContent);
  expect(labels()).toEqual(['haiku', 'sonnet', 'opus']);
  config.visibleModels = ['sonnet', 'opus', 'haiku'];
  selector.renderOptions();
  expect(labels()).toEqual(['sonnet', 'opus', 'haiku']);
  host.remove();
});

it('preserves provider group display order while keeping saved order inside each group', () => {
  const host = document.body.createDiv();
  const settings = {
    model: '',
    providerConfigs: {
      claude: {
        enabled: true,
        discoveredModels: ['opus', 'haiku'].map(value => ({ value, label: value, description: '' })),
        visibleModels: ['haiku', 'opus'],
      },
      codex: {
        enabled: true,
        discoveredModels: TEST_CODEX_CATALOG,
        visibleModels: ['gpt-5.4-mini', 'gpt-5.5'],
      },
      grok: { enabled: false }, pi: { enabled: false }, opencode: { enabled: false },
    },
  };
  new ModelSelector(host, {
    getSettings: () => settings,
    getUIConfig: () => ({ getModelOptions: getBlankTabModelOptions }),
  } as unknown as ToolbarCallbacks);
  const dropdown = host.querySelector<HTMLElement>('.claudian-model-dropdown')!;
  expect(within(dropdown).getAllByText(/^(Claude Code|Codex CLI|haiku|opus|GPT-5.4 Mini|GPT-5.5)$/)
    .map(node => node.textContent)).toEqual(['Claude Code', 'haiku', 'opus', 'Codex CLI', 'GPT-5.4 Mini', 'GPT-5.5']);
  host.remove();
});
