/** @jest-environment jsdom */

import '@/providers';

import { TEST_CODEX_CATALOG } from '@test/helpers/codexModels';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import { axe } from 'jest-axe';

import type { ToolbarCallbacks } from '@/features/chat/composer/toolbar/types';
import { claudeChatUIConfig } from '@/providers/claude/ui/ClaudeChatUIConfig';
import { updateCodexProviderSettings } from '@/providers/codex/settings';
import { codexChatUIConfig } from '@/providers/codex/ui/CodexChatUIConfig';
import { EffortSelector } from '@/shared/toolbar/EffortSelector';
import { ModelSelector } from '@/shared/toolbar/ModelSelector';
import { getProviderPickerModelOptions } from '@/shared/toolbar/providerPickerModelOptions';

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

it.each([
  {
    name: 'discovered labels without own aliases',
    aliases: null,
    labels: ['String Model', 'Proto Model', 'Constructor Model'],
  },
  {
    name: 'imported own aliases',
    aliases: '{"toString":"Custom String","__proto__":"Custom Proto","constructor":"Custom Constructor"}',
    labels: ['Custom String', 'Custom Proto', 'Custom Constructor'],
  },
])('renders persisted Codex $name in the named toolbar and options', async ({ aliases, labels }) => {
  let settings: Record<string, unknown> = { model: 'openai-codex/__proto__' };
  updateCodexProviderSettings(settings, {
    discoveredModels: [
      ['constructor', 'Constructor Model'],
      ['toString', 'String Model'],
      ['__proto__', 'Proto Model'],
    ].map(([model, displayName]) => ({
      model, displayName, description: '',
      supportedReasoningEfforts: [{ value: 'high', description: 'High' }],
      defaultReasoningEffort: 'high',
      serviceTiers: [], defaultServiceTier: null, inputModalities: ['text'], isDefault: false,
    })),
    visibleModels: ['toString', '__proto__', 'constructor'],
    modelAliases: aliases === null ? {} : JSON.parse(aliases),
  });
  settings = JSON.parse(JSON.stringify(settings));

  const host = document.body.createDiv();
  new ModelSelector(host, {
    getSettings: () => settings,
    getUIConfig: () => codexChatUIConfig,
    onModelChange: async (model: string) => { settings.model = model; },
  } as unknown as ToolbarCallbacks);

  fireEvent.click(within(host).getByRole('button', { name: `Model: ${labels[1]}` }));
  expect(within(host).getAllByRole('option').map(node => node.textContent)).toEqual(labels);
  expect(within(host).getByRole('option', { name: labels[1] }).getAttribute('aria-selected')).toBe('true');
  expect((await axe(host)).violations).toEqual([]);

  const values = ['openai-codex/toString', 'openai-codex/__proto__', 'openai-codex/constructor'];
  for (const [index, label] of labels.entries()) {
    fireEvent.click(within(host).getByRole('option', { name: label }));
    await waitFor(() => {
      expect(settings.model).toBe(values[index]);
      expect(within(host).getByRole('button', { name: `Model: ${label}` }).textContent).toBe(label);
    });
  }
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

it('lists a new session\'s providers in their own column and shows one provider\'s models at a time', async () => {
  const host = document.body.createDiv();
  const settings = {
    model: 'opus',
    reasoning: 'high',
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
      pi: {
        enabled: true,
        discoveredModels: [
          { encodedId: 'pi:anthropic/claude-sonnet-4', id: 'claude-sonnet-4', label: 'Claude Sonnet 4', provider: 'anthropic', thinkingLevels: ['off'] },
          { encodedId: 'pi:openai/gpt-5', id: 'gpt-5', label: 'GPT-5', provider: 'openai', thinkingLevels: ['off'] },
        ],
        visibleModels: ['pi:anthropic/claude-sonnet-4', 'pi:openai/gpt-5'],
      },
      opencode: {
        enabled: true,
        discoveredModels: [{ label: 'zai/GLM-5', rawId: 'zai/glm-5' }],
        visibleModels: ['zai/glm-5'],
      },
      grok: { enabled: false },
    },
  };
  const onModelChange = jest.fn(async (model: string) => { settings.model = model; });
  const callbacks = {
    getSettings: () => settings,
    getUIConfig: () => ({
      getModelOptions: (options: Record<string, unknown>) => getProviderPickerModelOptions(() => options),
      getReasoningOptions: () => [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }],
      getDefaultReasoningValue: () => 'low',
    }),
    getCapabilities: () => ({ reasoningControl: 'effort' }),
    onModelChange,
  } as unknown as ToolbarCallbacks;
  new EffortSelector(new ModelSelector(host, callbacks), callbacks);
  const button = within(host).getByRole('button', { name: /^Model: opus/ });
  fireEvent.click(button);

  const providers = within(host).getByRole('tablist', { name: 'Provider' });
  const tab = (name: string) => within(providers).getByRole('tab', { name });
  const modelList = () => within(host).getByRole('listbox', { name: 'Model' });
  const shown = () => within(modelList()).getAllByRole('option')
    .map(item => item.querySelector('.claudian-toolbar-popover-option-label')?.textContent);
  // Providers follow the settings tab order; the current model's provider is shown first, in saved model order.
  expect(within(providers).getAllByRole('tab').map(item => [item.getAttribute('aria-label'), item.getAttribute('aria-selected')]))
    .toEqual([['Claude Code', 'true'], ['Codex', 'false'], ['OpenCode', 'false'], ['Pi', 'false']]);
  expect(shown()).toEqual(['haiku', 'opus']);
  expect(within(modelList()).getByRole('option', { name: 'opus' }).getAttribute('aria-selected')).toBe('true');
  // The selected model, not the selected provider, takes focus when the popover opens.
  expect(document.activeElement).toBe(within(modelList()).getByRole('option', { name: 'opus' }));
  // Each tab names its provider so its icon carries that provider's brand colour.
  expect(tab('Codex').getAttribute('data-provider')).toBe('codex');
  expect(tab('Codex').getAttribute('aria-controls')).toBe(modelList().id);
  expect((await axe(host)).violations).toEqual([]);

  // Choosing a provider only browses its models; the session's model is unchanged until a model is picked.
  tab('Codex').focus();
  fireEvent.click(tab('Codex'));
  expect(tab('Codex').getAttribute('aria-selected')).toBe('true');
  expect([tab('Claude Code').tabIndex, tab('Codex').tabIndex]).toEqual([-1, 0]);
  expect(document.activeElement).toBe(tab('Codex'));
  expect(shown()).toEqual(['GPT-5.4 Mini', 'GPT-5.5']);
  expect(onModelChange).not.toHaveBeenCalled();
  expect(within(modelList()).queryAllByRole('option', { selected: true })).toEqual([]);
  // With no model chosen in the browsed provider, no thinking level is chosen either, and the
  // current model's levels cannot be changed from here.
  const levels = () => within(host).getAllByRole('option', { name: /^(Low|High)$/, hidden: true });
  expect(levels().map(level => level.getAttribute('aria-selected'))).toEqual(['false', 'false']);
  expect(host.querySelector('.claudian-model-parts')?.hasAttribute('inert')).toBe(true);
  // Arrow keys skip the faded column: Down from the last model wraps to the first provider.
  fireEvent.keyDown(within(modelList()).getByRole('option', { name: 'GPT-5.5' }), { key: 'ArrowDown' });
  expect(document.activeElement).toBe(tab('Claude Code'));
  // Browsing back to the current model's provider restores its level.
  fireEvent.click(tab('Claude Code'));
  expect(levels().map(level => level.getAttribute('aria-selected'))).toEqual(['true', 'false']);
  expect(host.querySelector('.claudian-model-parts')?.hasAttribute('inert')).toBe(false);
  fireEvent.click(tab('Codex'));

  fireEvent.click(within(modelList()).getByRole('option', { name: 'GPT-5.5' }));
  await waitFor(() => expect(button.getAttribute('aria-label')).toBe('Model: GPT-5.5, effort High'));
  expect(onModelChange).toHaveBeenCalledWith(expect.stringContaining('gpt-5.5'));
  // Once a model of the browsed provider is chosen, its level is shown and editable again.
  expect(levels().map(level => level.getAttribute('aria-selected'))).toEqual(['true', 'false']);
  expect(host.querySelector('.claudian-model-parts')?.hasAttribute('inert')).toBe(false);

  // A provider's upstream groups keep their headings in a new session, as in a started one.
  fireEvent.click(tab('Pi'));
  expect(within(modelList()).getAllByRole('group').map(group => [
    host.querySelector(`#${group.getAttribute('aria-labelledby')}`)?.textContent,
    within(group).getAllByRole('option').map(item => item.querySelector('.claudian-toolbar-popover-option-label')?.textContent),
  ])).toEqual([['anthropic', ['Claude Sonnet 4']], ['openai', ['GPT-5']]]);

  // Reopening starts on the provider of the model now in use.
  fireEvent.click(button);
  fireEvent.click(button);
  expect(tab('Codex').getAttribute('aria-selected')).toBe('true');
  expect(within(modelList()).getByRole('option', { name: 'GPT-5.5', selected: true })).toBe(document.activeElement);
});
