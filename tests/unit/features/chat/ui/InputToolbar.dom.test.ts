/** @jest-environment jsdom */

import '@/providers';

import { TEST_CODEX_CATALOG } from '@test/helpers/codexModels';
import { fireEvent, within } from '@testing-library/dom';
import { axe } from 'jest-axe';
import { setIcon } from 'obsidian';

import type { ProviderPermissionModeOption } from '@/core/providers/types';
import type { UsageInfo } from '@/core/types';
import { getBlankTabModelOptions } from '@/features/chat/tabs/TabProviderState';
import { ContextUsageMeter, createInputToolbar, ModelSelector, type ToolbarCallbacks } from '@/features/chat/ui/InputToolbar';
import { claudeChatUIConfig } from '@/providers/claude/ui/ClaudeChatUIConfig';
import { codexChatUIConfig } from '@/providers/codex/ui/CodexChatUIConfig';

HTMLElement.prototype.empty = function () { this.replaceChildren(); };
HTMLElement.prototype.addClass = function (...classes) { this.classList.add(...classes); };
HTMLElement.prototype.removeClass = function (...classes) { this.classList.remove(...classes); };
HTMLElement.prototype.hasClass = function (name) { return this.classList.contains(name); };
HTMLElement.prototype.toggleClass = function (classes, value) {
  for (const name of typeof classes === 'string' ? [classes] : classes) this.classList.toggle(name, value);
};

// The visibility utility from styles, so role queries skip controls the toolbar hides.
const hiddenStyle = document.head.appendChild(document.createElement('style'));
hiddenStyle.textContent = '.claudian-hidden { display: none; }';

const EFFORT_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Med' },
  { value: 'high', label: 'High', description: 'Deeper reasoning' },
  { value: 'max', label: 'Max' },
];

const BUDGET_OPTIONS = [
  { value: 'off', label: 'Off', tokens: 0 },
  { value: 'low', label: 'Low', tokens: 4000 },
  { value: 'medium', label: 'Med', tokens: 8000 },
  { value: 'high', label: 'High', tokens: 16000 },
  { value: 'xhigh', label: 'Ultra', tokens: 32000 },
];

interface FixtureOptions {
  settings?: Record<string, unknown>;
  models?: Array<Record<string, unknown>>;
  adaptive?: boolean;
  reasoningOptions?: Array<Record<string, unknown>>;
  reasoningControl?: string;
  permissionToggle?: boolean;
  permissionModes?: readonly ProviderPermissionModeOption[];
  serviceTier?: boolean;
  modeSelector?: boolean;
  providerIcon?: Record<string, unknown>;
}

function renderToolbar(fixture: FixtureOptions = {}) {
  const settings: Record<string, unknown> = {
    model: 'sonnet',
    reasoning: 'high',
    serviceTier: 'default',
    permissionMode: 'normal',
    selectedMode: 'build',
    ...fixture.settings,
  };
  const uiConfig = {
    getProviderIcon: () => fixture.providerIcon ?? null,
    getModelOptions: jest.fn(() => fixture.models ?? [
      { value: 'haiku', label: 'Haiku', description: 'Fast and efficient' },
      { value: 'sonnet', label: 'Sonnet' },
      { value: 'opus', label: 'Opus' },
    ]),
    isAdaptiveReasoningModel: () => fixture.adaptive ?? true,
    getReasoningOptions: () => fixture.reasoningOptions ?? EFFORT_OPTIONS,
    getDefaultReasoningValue: () => 'high',
    getPermissionModeOptions: () => (fixture.permissionToggle === false ? null : fixture.permissionModes ?? [
      { value: 'normal', label: 'Safe' },
      { value: 'yolo', label: 'YOLO', bypassesApprovals: true },
    ]),
    getServiceTierToggle: (current: Record<string, unknown>) => (fixture.serviceTier ? {
      inactiveValue: 'default',
      inactiveLabel: 'Standard',
      activeValue: 'fast',
      activeLabel: 'Fast',
      isActive: current.serviceTier === 'fast',
      description: '1.5x speed, 2x credits',
    } : null),
    getModeSelector: (current: Record<string, unknown>) => (fixture.modeSelector ? {
      activeValue: 'build',
      label: 'Mode',
      options: [
        { value: 'build', label: 'Build', description: 'Default editing agent' },
        { value: 'plan', label: 'Plan', description: 'Planning-first agent' },
      ],
      value: current.selectedMode as string,
    } : null),
  };
  const callbacks = {
    onModelChange: jest.fn(async (model: string) => { settings.model = model; }),
    onModeChange: jest.fn(async (mode: string) => { settings.selectedMode = mode; }),
    onThinkingBudgetChange: jest.fn(async (budget: string) => { settings.reasoning = budget; }),
    onEffortLevelChange: jest.fn(async (effort: string) => { settings.reasoning = effort; }),
    onServiceTierChange: jest.fn(async (tier: string) => { settings.serviceTier = tier; }),
    onPermissionModeChange: jest.fn(async (mode: string) => { settings.permissionMode = mode; }),
    getSettings: () => settings,
    getEnvironmentVariables: () => 'ANTHROPIC_MODEL=opus',
    getUIConfig: () => uiConfig,
    getCapabilities: () => ({ reasoningControl: fixture.reasoningControl ?? 'effort' }),
  } as unknown as ToolbarCallbacks & Record<string, jest.Mock>;
  const host = document.body.createDiv();
  const toolbarEl = host.createDiv({ cls: 'claudian-input-toolbar' });
  const outsideEl = host.createEl('button', { text: 'Outside', attr: { type: 'button' } });
  const toolbar = createInputToolbar(toolbarEl, callbacks);
  const ui = within(toolbarEl);
  return { callbacks, host, outsideEl, settings, toolbar, toolbarEl, ui, uiConfig };
}

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/** The slider's level as the user perceives it: value, announced text, visible label and announced detail. */
function sliderLevel(slider: HTMLElement) {
  const input = slider as HTMLInputElement;
  const section = input.closest('[role="group"]')!;
  return {
    value: input.value,
    valueText: input.getAttribute('aria-valuetext'),
    shown: section.querySelector('.claudian-toolbar-slider-value')?.textContent,
    detail: input.getAttribute('aria-description'),
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('model button', () => {
  it('opens its popover on click rather than hover, with a model list and an effort slider', async () => {
    const { host, ui } = renderToolbar();
    const button = ui.getByRole('button', { name: 'Model: Sonnet, effort High' });
    expect(button.getAttribute('type')).toBe('button');
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    expect(button.getAttribute('aria-expanded')).toBe('false');

    fireEvent.mouseEnter(button);
    fireEvent.mouseOver(button);
    expect(ui.queryByRole('dialog')).toBeNull();

    fireEvent.click(button);
    const dialog = ui.getByRole('dialog', { name: 'Model options' });
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.getAttribute('aria-controls')).toBe(dialog.id);
    const models = within(dialog).getByRole('listbox', { name: 'Model' });
    const selected = within(models).getByRole('option', { name: 'Sonnet', selected: true });
    expect(document.activeElement).toBe(selected);
    // Each control is one tab stop: the selected model, then the slider.
    expect(within(models).getAllByRole('option').map(option => option.tabIndex)).toEqual([-1, 0, -1]);

    const effort = within(dialog).getByRole('group', { name: 'Effort' });
    const slider = within(effort).getByRole('slider', { name: 'Effort' }) as HTMLInputElement;
    expect([slider.type, slider.min, slider.max, slider.step]).toEqual(['range', '0', '3', '1']);
    expect(sliderLevel(slider)).toEqual({ value: '2', valueText: 'High', shown: 'High', detail: 'Deeper reasoning' });
    // The level's description is announced only: nothing is written under the track and nothing pops up on hover.
    expect(effort.textContent).toBe('EffortHighFasterSmarter');
    expect(slider.hasAttribute('title')).toBe(false);
    // One visible stop per level the provider reports.
    expect(effort.querySelectorAll('.claudian-toolbar-slider-tick')).toHaveLength(4);
    expect((await axe(host)).violations).toEqual([]);

    fireEvent.click(button);
    expect(ui.queryByRole('dialog')).toBeNull();
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('moves between controls with Up and Down and leaves the level keys to the slider', () => {
    const { ui } = renderToolbar({ serviceTier: true });
    const button = ui.getByRole('button', { name: /^Model: Sonnet/ });
    fireEvent.keyDown(button, { key: 'ArrowDown' });
    const dialog = ui.getByRole('dialog', { name: 'Model options' });
    const option = (name: string) => within(dialog).getByRole('option', { name });
    const slider = within(dialog).getByRole('slider', { name: 'Effort' });
    const fastMode = within(dialog).getByRole('switch', { name: 'Fast mode' });
    expect(document.activeElement).toBe(option('Sonnet'));

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(option('Opus'));
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(document.activeElement).toBe(option('Haiku'));
    // Home and End stay inside the model list.
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(document.activeElement).toBe(option('Opus'));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(slider);

    // Left, Right, Home, End and the Page keys change the level natively, so they pass through.
    for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']) {
      expect(fireEvent.keyDown(slider, { key })).toBe(true);
      expect(document.activeElement).toBe(slider);
    }
    // Up and Down leave the slider instead of changing the level.
    expect(fireEvent.keyDown(slider, { key: 'ArrowDown' })).toBe(false);
    expect(document.activeElement).toBe(fastMode);
    fireEvent.keyDown(fastMode, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(option('Haiku'));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(fastMode);
    fireEvent.keyDown(fastMode, { key: 'ArrowUp' });
    expect(fireEvent.keyDown(slider, { key: 'ArrowUp' })).toBe(false);
    expect(document.activeElement).toBe(option('Opus'));

    // Tab moves between the popover's controls instead of closing it.
    expect(fireEvent.keyDown(option('Opus'), { key: 'Tab' })).toBe(true);
    expect(ui.getByRole('dialog')).toBe(dialog);
    expect([slider.tabIndex, fastMode.tabIndex]).toEqual([0, 0]);

    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(ui.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(button);

    fireEvent.keyDown(button, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(ui.getByRole('switch', { name: 'Fast mode' }));
  });

  it('consumes Escape for an open menu before document key handlers in either phase', () => {
    const { ui } = renderToolbar();
    // Stand-ins for Obsidian's keymap, whose scopes cancel a running turn on Escape.
    const seen: string[] = [];
    const record = (phase: string) => (event: KeyboardEvent) => {
      if (event.key === 'Escape') seen.push(`${phase}${event.defaultPrevented ? ':prevented' : ''}`);
    };
    const onCapture = record('capture');
    const onBubble = record('bubble');
    document.addEventListener('keydown', onCapture, true);
    document.addEventListener('keydown', onBubble);
    try {
      const button = ui.getByRole('button', { name: /^Model:/ });
      fireEvent.click(button);
      expect(ui.getByRole('dialog', { name: 'Model options' })).toBeDefined();
      fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
      expect(ui.queryByRole('dialog')).toBeNull();
      expect(document.activeElement).toBe(button);
      expect(seen).toEqual([]);

      // With no menu open, Escape travels as before for the chat's own handling.
      fireEvent.keyDown(button, { key: 'Escape' });
      expect(seen).toEqual(['capture', 'bubble']);
    } finally {
      document.removeEventListener('keydown', onCapture, true);
      document.removeEventListener('keydown', onBubble);
    }
  });

  it('closes an open menu for a keymap that runs first, returning focus to its button', () => {
    const { toolbar, ui } = renderToolbar();
    expect(toolbar.menus.closeOpenMenu()).toBe(false);
    const button = ui.getByRole('button', { name: 'Permission mode: Safe' });
    fireEvent.click(button);
    expect(toolbar.menus.closeOpenMenu()).toBe(true);
    expect(ui.queryByRole('menu')).toBeNull();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(button);
  });

  it('closes on an outside press or when focus leaves, and only one toolbar menu stays open', () => {
    const { outsideEl, ui } = renderToolbar();
    const modelButton = ui.getByRole('button', { name: /^Model:/ });
    const permissionButton = ui.getByRole('button', { name: 'Permission mode: Safe' });

    fireEvent.click(modelButton);
    fireEvent.pointerDown(outsideEl);
    expect(ui.queryByRole('dialog')).toBeNull();

    fireEvent.click(modelButton);
    fireEvent.click(permissionButton);
    expect(ui.queryByRole('dialog')).toBeNull();
    expect(ui.getAllByRole('menu').map(menu => menu.getAttribute('aria-label'))).toEqual(['Permission mode']);
    expect(modelButton.getAttribute('aria-expanded')).toBe('false');

    fireEvent.focusOut(document.activeElement!, { relatedTarget: outsideEl });
    expect(ui.queryByRole('menu')).toBeNull();
  });

  it('changes model through the list and keeps the popover open for the next choice', async () => {
    const { callbacks, ui } = renderToolbar();
    fireEvent.click(ui.getByRole('button', { name: /^Model:/ }));
    // A real click or Enter focuses the item it activates.
    const opus = ui.getByRole('option', { name: 'Opus' });
    opus.focus();
    fireEvent.click(opus);
    await flush();
    expect(callbacks.onModelChange).toHaveBeenCalledWith('opus');
    expect(ui.getByRole('button', { name: 'Model: Opus, effort High' })).toBeDefined();
    expect(ui.getByRole('option', { name: 'Opus', selected: true })).toBe(document.activeElement);
    expect(ui.getByRole('dialog', { name: 'Model options' })).toBeDefined();
  });

  it('follows the thumb while dragging and commits the level once, on release', async () => {
    const { callbacks, outsideEl, toolbar, ui } = renderToolbar();
    const button = ui.getByRole('button', { name: /^Model:/ });
    fireEvent.click(button);
    const slider = ui.getByRole('slider', { name: 'Effort' });
    slider.focus();

    fireEvent.pointerDown(slider);
    fireEvent.input(slider, { target: { value: '1' } });
    fireEvent.input(slider, { target: { value: '0' } });
    expect(sliderLevel(slider)).toEqual({ value: '0', valueText: 'Low', shown: 'Low', detail: null });
    expect(callbacks.onEffortLevelChange).not.toHaveBeenCalled();
    // A refresh mid-drag neither replaces the slider nor snaps it back to the saved level.
    toolbar.thinkingBudgetSelector.updateDisplay();
    expect(ui.getByRole('slider', { name: 'Effort' })).toBe(slider);
    expect(sliderLevel(slider).value).toBe('0');
    // Releasing outside the popover does not close it.
    fireEvent.pointerUp(outsideEl);
    expect(ui.getByRole('dialog', { name: 'Model options' })).toBeDefined();
    expect(button.getAttribute('aria-label')).toBe('Model: Sonnet, effort High');

    fireEvent.change(slider);
    await flush();
    expect(callbacks.onEffortLevelChange).toHaveBeenCalledTimes(1);
    expect(callbacks.onEffortLevelChange).toHaveBeenCalledWith('low');
    expect(button.getAttribute('aria-label')).toBe('Model: Sonnet, effort Low');
    expect(button.querySelector('.claudian-thinking-current')?.textContent).toBe('Low');
    expect(ui.getByRole('slider', { name: 'Effort' })).toBe(slider);
    expect(document.activeElement).toBe(slider);

    // Committing the current level again still reaches the provider, as re-picking it always has.
    fireEvent.change(slider);
    await flush();
    expect(callbacks.onEffortLevelChange).toHaveBeenCalledTimes(2);
    expect(callbacks.onEffortLevelChange).toHaveBeenLastCalledWith('low');
  });

  it('keeps the latest keyboard level while earlier commits are still saving', async () => {
    const { callbacks, settings, toolbar, ui } = renderToolbar();
    const pending: Array<() => void> = [];
    const onEffortLevelChange = callbacks.onEffortLevelChange as jest.Mock;
    onEffortLevelChange.mockImplementation((effort: string) => new Promise<void>((resolve) => {
      pending.push(() => {
        settings.reasoning = effort;
        // The runtime refreshes the toolbar as each save lands, as side chat's settings path does.
        toolbar.thinkingBudgetSelector.updateDisplay();
        resolve();
      });
    }));
    fireEvent.click(ui.getByRole('button', { name: /^Model:/ }));
    const slider = ui.getByRole('slider', { name: 'Effort' });
    // Keyboard steps fire input and change together, one commit per step.
    for (const value of ['1', '0']) {
      fireEvent.input(slider, { target: { value } });
      fireEvent.change(slider);
    }
    expect(onEffortLevelChange.mock.calls).toEqual([['medium'], ['low']]);

    pending[0]();
    await flush();
    expect(sliderLevel(slider)).toMatchObject({ value: '0', valueText: 'Low' });
    pending[1]();
    await flush();
    expect(sliderLevel(slider)).toMatchObject({ value: '0', valueText: 'Low' });
    expect(ui.getByRole('button', { name: 'Model: Sonnet, effort Low' })).toBeDefined();
  });

  it('uses the same slider for a legacy thinking budget, with token counts as its announced detail', async () => {
    const { callbacks, host, ui } = renderToolbar({
      adaptive: false, reasoningOptions: BUDGET_OPTIONS, settings: { reasoning: 'low' },
    });
    fireEvent.click(ui.getByRole('button', { name: 'Model: Sonnet, thinking Low' }));
    const thinking = ui.getByRole('group', { name: 'Thinking' });
    const slider = within(thinking).getByRole('slider', { name: 'Thinking' });
    expect((slider as HTMLInputElement).max).toBe('4');
    expect(thinking.textContent).toBe('ThinkingLow');
    expect(sliderLevel(slider)).toEqual({ value: '1', valueText: 'Low', shown: 'Low', detail: '4,000 tokens' });
    fireEvent.input(slider, { target: { value: '0' } });
    expect(sliderLevel(slider)).toEqual({ value: '0', valueText: 'Off', shown: 'Off', detail: 'Disabled' });
    fireEvent.input(slider, { target: { value: '3' } });
    fireEvent.change(slider);
    await flush();
    expect(callbacks.onThinkingBudgetChange).toHaveBeenCalledWith('high');
    expect(callbacks.onEffortLevelChange).not.toHaveBeenCalled();
    expect(ui.getByRole('button', { name: 'Model: Sonnet, thinking High' })).toBeDefined();
    expect(sliderLevel(slider)).toMatchObject({ value: '3', detail: '16,000 tokens' });
    expect((await axe(host)).violations).toEqual([]);
  });

  it.each([
    ['provider without reasoning control', { reasoningControl: 'none' }],
    ['no reasoning options', { reasoningOptions: [] }],
    ['only the default reasoning option', { reasoningOptions: [{ value: 'high', label: 'High' }] }],
  ])('omits reasoning for a %s', (_case, fixture) => {
    const { ui } = renderToolbar(fixture);
    fireEvent.click(ui.getByRole('button', { name: 'Model: Sonnet' }));
    expect(ui.getByRole('dialog', { name: 'Model options' })).toBeDefined();
    expect(ui.queryByRole('slider')).toBeNull();
    expect(ui.queryByRole('group', { name: /Effort|Thinking/ })).toBeNull();
  });

  it('shows fast mode on the button and switches it from the model menu', async () => {
    const { callbacks, toolbar, ui, settings } = renderToolbar({ serviceTier: true });
    const button = ui.getByRole('button', { name: 'Model: Sonnet, effort High' });
    expect(button.querySelector('.claudian-service-tier-indicator')?.classList.contains('claudian-hidden')).toBe(true);
    fireEvent.click(button);
    const fastMode = ui.getByRole('switch', { name: 'Fast mode' });
    expect(fastMode.getAttribute('aria-checked')).toBe('false');
    expect(fastMode.getAttribute('title')).toBe('Fast mode: Standard\n1.5x speed, 2x credits');
    fireEvent.click(fastMode);
    await flush();
    expect(callbacks.onServiceTierChange).toHaveBeenCalledWith('fast');
    expect(ui.getByRole('switch', { name: 'Fast mode' }).getAttribute('aria-checked')).toBe('true');
    expect(ui.getByRole('button', { name: 'Model: Sonnet, effort High, fast mode on' })).toBe(button);
    expect(button.querySelector('.claudian-service-tier-indicator')?.classList.contains('claudian-hidden')).toBe(false);
    fireEvent.click(ui.getByRole('switch', { name: 'Fast mode' }));
    await flush();
    expect(callbacks.onServiceTierChange).toHaveBeenLastCalledWith('default');
    expect(ui.getByRole('switch', { name: 'Fast mode' }).getAttribute('aria-checked')).toBe('false');

    // Slash-command toggles refresh through the same public update.
    settings.serviceTier = 'default';
    toolbar.serviceTierToggle.updateDisplay();
    expect(ui.getByRole('button', { name: 'Model: Sonnet, effort High' })).toBe(button);
    await expect(toolbar.serviceTierToggle.toggle()).resolves.toBe(true);
    expect(callbacks.onServiceTierChange).toHaveBeenLastCalledWith('fast');

    const withoutTier = renderToolbar();
    fireEvent.click(withoutTier.ui.getByRole('button', { name: /^Model:/ }));
    expect(withoutTier.ui.queryByRole('switch')).toBeNull();
    await expect(withoutTier.toolbar.serviceTierToggle.toggle()).resolves.toBe(false);
    expect(withoutTier.callbacks.onServiceTierChange).not.toHaveBeenCalled();
  });

  it('shows the selected model provider icon ahead of the label', () => {
    const providerIcon = { kind: 'path', viewBox: '0 0 16 16', path: 'M1 1h14v14H1z' };
    const modelIcon = { kind: 'path', viewBox: '0 0 24 24', path: 'M2 2h20v20H2z' };
    const { ui } = renderToolbar({ providerIcon });
    const button = ui.getByRole('button', { name: /^Model: Sonnet/ });
    const icon = button.querySelector('svg.claudian-model-provider-icon')!;
    expect([icon.getAttribute('viewBox'), icon.getAttribute('width'), icon.getAttribute('height')])
      .toEqual(['0 0 16 16', '12', '12']);
    expect(icon.compareDocumentPosition(button.querySelector('.claudian-model-label')!) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();

    // In a mixed-provider picker the selected model's own icon wins over the provider default.
    const mixed = renderToolbar({ providerIcon, models: [{ value: 'sonnet', label: 'Sonnet', providerIcon: modelIcon }] });
    const mixedButton = mixed.ui.getByRole('button', { name: /^Model: Sonnet/ });
    expect(mixedButton.querySelector('svg.claudian-model-provider-icon')?.getAttribute('viewBox')).toBe('0 0 24 24');
  });

  it('keeps unavailable and empty model states', () => {
    const unavailable = renderToolbar({ settings: { model: 'retired' } });
    const button = unavailable.ui.getByRole('button', { name: /^Model unavailable/ });
    expect(button.title).toBe('Choose an enabled model in provider settings. If discovery failed, refresh the model list.');
    fireEvent.click(button);
    expect(unavailable.ui.queryAllByRole('option', { selected: true })).toEqual([]);
    // With nothing selected, the first model is the list's tab stop.
    expect(unavailable.ui.getAllByRole('option').map(option => option.tabIndex)).toEqual([0, -1, -1]);

    const empty = renderToolbar({ settings: { model: '' }, models: [] });
    fireEvent.click(empty.ui.getByRole('button', { name: /^Set up models/ }));
    expect(empty.ui.getByRole('status').textContent)
      .toBe('No models available. Check provider settings and refresh the model list if discovery failed.');
  });

  it('rereads models and settings when the menu opens', () => {
    const { settings, ui, uiConfig } = renderToolbar();
    uiConfig.getModelOptions.mockImplementation(() => [
      { value: 'gpt-new', label: 'GPT New', group: 'Codex' },
      { value: 'gpt-fast', label: 'GPT Fast', group: 'Codex' },
      { value: 'claude', label: 'Claude', group: 'Claude' },
    ]);
    settings.model = 'gpt-new';
    fireEvent.click(ui.getByRole('button', { name: /^Model: Sonnet/ }));
    expect(ui.getByRole('button', { name: /^Model: GPT New/ })).toBeDefined();
    const codex = ui.getByRole('group', { name: 'Codex' });
    expect(within(codex).getAllByRole('option').map(item => item.textContent)).toEqual(['GPT New', 'GPT Fast']);
    expect(within(ui.getByRole('group', { name: 'Claude' })).getAllByRole('option')).toHaveLength(1);
    expect(uiConfig.getModelOptions).toHaveBeenLastCalledWith({ ...settings, environmentVariables: 'ANTHROPIC_MODEL=opus' });
  });
});

describe('permission button', () => {
  it('shows all Codex permissions and allows keyboard selection with accessible descriptions', async () => {
    const { callbacks, host, settings, toolbar, ui, uiConfig } = renderToolbar({
      settings: { permissionMode: 'auto-review' },
    });
    uiConfig.getPermissionModeOptions = () => codexChatUIConfig.getPermissionModeOptions!()!;
    toolbar.permissionToggle.updateDisplay();
    const button = ui.getByRole('button', { name: 'Permission mode: Approve for me' });
    const icon = button.querySelector<HTMLElement>('.claudian-toolbar-chip-icon')!;
    expect(getComputedStyle(icon).display).toBe('none');
    fireEvent.keyDown(button, { key: 'ArrowDown' });
    const items = ui.getAllByRole('menuitemradio');
    expect(items).toHaveLength(3);
    expect(items[0]).toBe(ui.getByRole('menuitemradio', { name: /^Approve for me/ }));
    expect(items[1]).toBe(ui.getByRole('menuitemradio', { name: /^Ask for approval/ }));
    expect(ui.getByRole('menuitemradio', { name: /^Approve for me/, checked: true })).toBe(document.activeElement);
    expect(ui.getByText('Auto-review extra access.')).toBeTruthy();
    expect((await axe(host)).violations).toEqual([]);
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    const fullAccess = ui.getByRole('menuitemradio', { name: /^Full access/ });
    expect(document.activeElement).toBe(fullAccess);
    fireEvent.click(fullAccess);
    await flush();
    expect(callbacks.onPermissionModeChange).toHaveBeenLastCalledWith('yolo');
    expect(settings.permissionMode).toBe('yolo');
    expect(button.classList.contains('claudian-toolbar-chip--alert')).toBe(true);
    expect(getComputedStyle(icon).display).not.toBe('none');
    fireEvent.click(button);
    fireEvent.click(ui.getByRole('menuitemradio', { name: /^Ask for approval/ }));
    await flush();
    expect(callbacks.onPermissionModeChange).toHaveBeenLastCalledWith('normal');
    expect(ui.getByRole('button', { name: 'Permission mode: Ask for approval' })).toBe(button);
    expect(getComputedStyle(icon).display).toBe('none');
  });

  it('offers both provider modes, marks the active one, and closes after a choice', async () => {
    jest.mocked(setIcon).mockClear();
    const { callbacks, host, toolbar, ui } = renderToolbar();
    const button = ui.getByRole('button', { name: 'Permission mode: Safe' });
    const chipIcons = () => jest.mocked(setIcon).mock.calls
      .filter(([el]) => button.contains(el as Node)).map(([, icon]) => icon).filter(icon => icon !== 'chevron-down');
    // Only a mode that skips approvals carries an icon.
    expect(chipIcons()).toEqual([]);
    expect(button.getAttribute('aria-haspopup')).toBe('menu');
    fireEvent.keyDown(button, { key: 'ArrowDown' });
    const menu = ui.getByRole('menu', { name: 'Permission mode' });
    const items = within(menu).getAllByRole('menuitemradio');
    expect(items.map(item => [item.textContent, item.getAttribute('aria-checked')]))
      .toEqual([['Safe', 'true'], ['YOLO', 'false']]);
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    expect((await axe(host)).violations).toEqual([]);
    // A menu closes on Tab and focus continues from its button.
    fireEvent.keyDown(items[1], { key: 'Tab' });
    expect(ui.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);

    fireEvent.click(items[1]);
    await flush();
    expect(callbacks.onPermissionModeChange).toHaveBeenCalledWith('yolo');
    expect(ui.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(ui.getByRole('button', { name: 'Permission mode: YOLO' })).toBe(button);
    expect(button.classList.contains('claudian-toolbar-chip--alert')).toBe(true);
    expect(chipIcons()).toEqual(['shield-alert']);
    fireEvent.click(button);
    jest.mocked(setIcon).mockClear();
    const iconSlot = button.querySelector('.claudian-toolbar-chip-icon')!;
    iconSlot.appendChild(document.createElement('svg'));
    fireEvent.click(ui.getByRole('menuitemradio', { name: 'Safe' }));
    await flush();
    expect(callbacks.onPermissionModeChange).toHaveBeenLastCalledWith('normal');
    expect(button.classList.contains('claudian-toolbar-chip--alert')).toBe(false);
    expect(chipIcons()).toEqual([]);
    expect(iconSlot.childElementCount).toBe(0);
    fireEvent.click(button);
    fireEvent.click(ui.getByRole('menuitemradio', { name: 'YOLO' }));
    await flush();

    toolbar.permissionToggle.setVisible(false);
    expect(ui.queryByRole('button', { name: /^Permission mode/ })).toBeNull();
    toolbar.permissionToggle.setVisible(true);
    expect(ui.getByRole('button', { name: 'Permission mode: YOLO' })).toBe(button);
  });

  it('lists every Claude permission mode with its description and alerts only on YOLO', async () => {
    const { callbacks, ui } = renderToolbar({
      settings: { permissionMode: 'auto' },
      permissionModes: claudeChatUIConfig.getPermissionModeOptions?.() ?? undefined,
    });
    const button = ui.getByRole('button', { name: 'Permission mode: Auto' });
    expect(button.classList.contains('claudian-toolbar-chip--alert')).toBe(false);
    fireEvent.click(button);
    const items = within(ui.getByRole('menu', { name: 'Permission mode' })).getAllByRole('menuitemradio');
    expect(items.map(item => [item.textContent, item.getAttribute('aria-checked')])).toEqual([
      ['AutoClaude handles permission decisions', 'true'],
      ['ManualAlways ask before making changes', 'false'],
      ['Accept editsAutomatically accept all file edits', 'false'],
      ['YOLOAccept all permissions without asking', 'false'],
    ]);
    fireEvent.click(button);

    for (const [name, value, alert] of [
      ['Manual', 'manual', false], ['Accept edits', 'acceptEdits', false], ['YOLO', 'yolo', true],
    ] as const) {
      fireEvent.click(button);
      fireEvent.click(ui.getByRole('menuitemradio', { name: new RegExp(`^${name}`) }));
      await flush();
      expect(callbacks.onPermissionModeChange).toHaveBeenLastCalledWith(value);
      expect(ui.getByRole('button', { name: `Permission mode: ${name}` })).toBe(button);
      expect(button.classList.contains('claudian-toolbar-chip--alert')).toBe(alert);
    }
  });

  it('is the last control in the toolbar, after the provider mode button', () => {
    const { host, ui } = renderToolbar();
    const anchor = ui.getByRole('button', { name: 'Permission mode: Safe' }).closest('.claudian-permission-toggle');
    expect(anchor?.parentElement?.lastElementChild).toBe(anchor);
    expect(host.querySelector('.claudian-mode-selector')?.nextElementSibling).toBe(anchor);
  });

  it('is absent when the provider has no permission toggle', () => {
    const { ui } = renderToolbar({ permissionToggle: false });
    expect(ui.queryByRole('button', { name: /^Permission mode/ })).toBeNull();
  });
});

describe('provider mode button', () => {
  it('renders only when a provider supplies two modes and changes mode through its menu', async () => {
    expect(renderToolbar().ui.queryByRole('button', { name: /^Mode:/ })).toBeNull();

    const { callbacks, ui } = renderToolbar({ modeSelector: true });
    const buttons = ui.getAllByRole('button');
    expect(buttons.map(button => button.getAttribute('aria-label')))
      .toEqual(['Model: Sonnet, effort High', 'Mode: Build', 'Permission mode: Safe']);
    // The provider's active option keeps its accent.
    expect(buttons[1].classList.contains('claudian-toolbar-chip--accent')).toBe(true);
    fireEvent.click(buttons[1]);
    const plan = within(ui.getByRole('menu', { name: 'Mode' })).getByRole('menuitemradio', { name: /^Plan/ });
    expect(plan.textContent).toBe('PlanPlanning-first agent');
    fireEvent.click(plan);
    await flush();
    expect(callbacks.onModeChange).toHaveBeenCalledWith('plan');
    expect(ui.getByRole('button', { name: 'Mode: Plan' })).toBe(buttons[1]);
    expect(buttons[1].classList.contains('claudian-toolbar-chip--accent')).toBe(false);
  });
});

it('tears down an open menu when the toolbar is destroyed', () => {
  const { outsideEl, toolbar, ui } = renderToolbar();
  const button = ui.getByRole('button', { name: /^Model:/ });
  fireEvent.click(button);
  toolbar.menus.destroy();
  expect(ui.queryByRole('dialog')).toBeNull();
  expect(button.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(button);
  fireEvent.pointerDown(outsideEl);
  expect(ui.queryByRole('dialog')).toBeNull();
});

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

it('mounts the context meter in the toolbar right after the model picker', () => {
  const toolbarEl = document.body.createDiv();
  const callbacks = {
    getSettings: () => ({ model: 'haiku', permissionMode: 'normal' }),
    getUIConfig: () => ({ ...claudeChatUIConfig, getModelOptions: () => [] }),
    getCapabilities: () => ({ reasoningControl: 'none' }),
  } as unknown as ToolbarCallbacks;
  const toolbar = createInputToolbar(toolbarEl, callbacks);
  toolbar.contextUsageMeter.update({ contextTokens: 50000, contextWindow: 200000, percentage: 25 } as UsageInfo);
  const meter = within(toolbarEl).getByRole('progressbar', { name: /^Context usage/ });
  expect(meter.previousElementSibling?.classList.contains('claudian-toolbar-chip-anchor--model')).toBe(true);
  toolbar.menus.destroy();
});
