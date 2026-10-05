/** @jest-environment jsdom */

import '@/providers';

import { TEST_CODEX_CATALOG } from '@test/helpers/codexModels';
import { fireEvent, within } from '@testing-library/dom';

import { ModelSelector } from '@/features/chat/composer/toolbar/ModelSelector';
import type { ToolbarCallbacks } from '@/features/chat/composer/toolbar/types';
import { getBlankTabModelOptions } from '@/features/chat/tabs/tabProviderSettings';
import { claudeChatUIConfig } from '@/providers/claude/ui/ClaudeChatUIConfig';

HTMLElement.prototype.empty = function () { this.replaceChildren(); };
HTMLElement.prototype.addClass = function (...classes) { this.classList.add(...classes); };
HTMLElement.prototype.removeClass = function (...classes) { this.classList.remove(...classes); };
HTMLElement.prototype.hasClass = function (name) { return this.classList.contains(name); };
HTMLElement.prototype.toggleClass = function (classes, value) {
  for (const name of typeof classes === 'string' ? [classes] : classes) this.classList.toggle(name, value);
};

afterEach(() => {
  document.body.replaceChildren();
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
  fireEvent.click(within(host).getByRole('button', { name: /^Model: haiku/ }));
  const labels = () => within(host).getAllByRole('option').map(node => node.textContent);
  expect(labels()).toEqual(['haiku', 'sonnet', 'opus']);
  // A single-provider list takes the view's active-provider brand; rows name no provider.
  expect(within(host).getAllByRole('option').map(node => node.getAttribute('data-provider'))).toEqual([null, null, null]);
  config.visibleModels = ['sonnet', 'opus', 'haiku'];
  selector.renderOptions();
  expect(labels()).toEqual(['sonnet', 'opus', 'haiku']);
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
  fireEvent.click(within(host).getByRole('button', { name: /^Set up models/ }));
  // Each row names its provider so it can carry that provider's brand colour.
  expect(within(host).getAllByRole('option').map(node => node.getAttribute('data-provider')))
    .toEqual(['claude', 'claude', 'codex', 'codex']);
  const groups = within(host).getAllByRole('group');
  expect(groups.map(group => [
    group.getAttribute('aria-labelledby') && host.querySelector(`#${group.getAttribute('aria-labelledby')}`)?.textContent,
    within(group).getAllByRole('option').map(item => item.textContent),
  ])).toEqual([
    ['Claude Code', ['haiku', 'opus']],
    ['Codex CLI', ['GPT-5.4 Mini', 'GPT-5.5']],
  ]);
});
