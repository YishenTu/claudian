/** @vitest-environment jsdom */

import '@/providers';

import { axe } from '@test/helpers/accessibility';
import { fireEvent, within } from '@testing-library/dom';
import { setIcon } from 'obsidian';
import type { Mock } from 'vitest';

import type { ProviderPermissionModeOption } from '@/core/providers/types';
import { createInputToolbar } from '@/features/chat/composer/toolbar/InputToolbar';
import type { ToolbarCallbacks } from '@/features/chat/composer/toolbar/types';
import { claudeChatUIConfig } from '@/providers/claude/ui/ClaudeChatUIConfig';
import { codexChatUIConfig } from '@/providers/codex/ui/CodexChatUIConfig';

// The visibility utility from styles, so role queries skip controls the toolbar hides.
const hiddenStyle = document.head.appendChild(document.createElement('style'));
hiddenStyle.textContent = '.claudian-hidden { display: none; }';

const EFFORT_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Med' },
  { value: 'high', label: 'High', description: 'Deeper reasoning' },
  { value: 'max', label: 'Max' },
];

interface FixtureOptions {
  settings?: Record<string, unknown>;
  models?: Array<Record<string, unknown>>;
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
    getModelOptions: vi.fn(() => fixture.models ?? [
      { value: 'haiku', label: 'Haiku', description: 'Fast and efficient' },
      { value: 'sonnet', label: 'Sonnet' },
      { value: 'opus', label: 'Opus' },
    ]),
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
    onModelChange: vi.fn(async (model: string) => { settings.model = model; }),
    onModeChange: vi.fn(async (mode: string) => { settings.selectedMode = mode; }),
    onEffortLevelChange: vi.fn(async (effort: string) => { settings.reasoning = effort; }),
    onServiceTierChange: vi.fn(async (tier: string) => { settings.serviceTier = tier; }),
    onPermissionModeChange: vi.fn(async (mode: string) => { settings.permissionMode = mode; }),
    getSettings: () => settings,
    getEnvironmentVariables: () => 'ANTHROPIC_MODEL=opus',
    getUIConfig: () => uiConfig,
    getCapabilities: () => ({ reasoningControl: fixture.reasoningControl ?? 'effort' }),
  } as unknown as ToolbarCallbacks & Record<string, Mock>;
  const host = document.body.createDiv();
  const toolbarEl = host.createDiv({ cls: 'claudian-input-toolbar' });
  const outsideEl = host.createEl('button', { text: 'Outside', attr: { type: 'button' } });
  const toolbar = createInputToolbar(toolbarEl, callbacks);
  const ui = within(toolbarEl);
  return { callbacks, host, outsideEl, settings, toolbar, toolbarEl, ui, uiConfig };
}

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

afterEach(() => {
  document.body.replaceChildren();
});

describe('model button', () => {
  it('opens its popover on click rather than hover, with model and thinking columns side by side', async () => {
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
    // Each list is one tab stop: its selected entry.
    expect(within(models).getAllByRole('option').map(option => option.tabIndex)).toEqual([-1, 0, -1]);
    // A model's description is its second line.
    expect(within(models).getByRole('option', { name: 'Haiku' }).textContent).toBe('HaikuFast and efficient');
    // A session's own provider is fixed, so there is no provider column.
    expect(within(dialog).queryByRole('tablist')).toBeNull();

    // Levels run from the deepest at the top to the fastest at the bottom.
    const effort = within(dialog).getByRole('listbox', { name: 'Thinking' });
    const levels = within(effort).getAllByRole('option');
    expect(levels.map(level => [
      level.querySelector('.claudian-toolbar-popover-option-label')?.textContent,
      level.getAttribute('aria-selected'),
      level.tabIndex,
    ])).toEqual([['Max', 'false', -1], ['High', 'true', 0], ['Med', 'false', -1], ['Low', 'false', -1]]);
    // A level's description is announced, not shown.
    const high = within(effort).getByRole('option', { name: 'High' });
    expect(high.textContent).toBe('High');
    expect(high.getAttribute('aria-description')).toBe('Deeper reasoning');
    expect(levels.some(level => level.hasAttribute('title'))).toBe(false);
    expect((await axe(host)).violations).toEqual([]);

    fireEvent.click(button);
    expect(ui.queryByRole('dialog')).toBeNull();
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('moves through every control with Up and Down, keeping Home and End inside each list', () => {
    const { ui } = renderToolbar({ serviceTier: true });
    const button = ui.getByRole('button', { name: /^Model: Sonnet/ });
    fireEvent.keyDown(button, { key: 'ArrowDown' });
    const dialog = ui.getByRole('dialog', { name: 'Model options' });
    const models = within(dialog).getByRole('listbox', { name: 'Model' });
    const effort = within(dialog).getByRole('listbox', { name: 'Thinking' });
    const model = (name: string) => within(models).getByRole('option', { name });
    const level = (name: string) => within(effort).getByRole('option', { name });
    const fastMode = within(dialog).getByRole('switch', { name: 'Fast' });
    expect(document.activeElement).toBe(model('Sonnet'));

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(model('Opus'));
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(document.activeElement).toBe(model('Haiku'));
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(document.activeElement).toBe(model('Opus'));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(level('Max'));
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(document.activeElement).toBe(level('Low'));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(fastMode);
    fireEvent.keyDown(fastMode, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(model('Haiku'));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(fastMode);

    // Tab moves between the popover's controls instead of closing it.
    expect(fireEvent.keyDown(fastMode, { key: 'Tab' })).toBe(true);
    expect(ui.getByRole('dialog')).toBe(dialog);
    expect([level('High').tabIndex, fastMode.tabIndex]).toEqual([0, 0]);

    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(ui.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(button);

    fireEvent.keyDown(button, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(ui.getByRole('switch', { name: 'Fast' }));
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

  it('changes the thinking level from its list and keeps the popover open on the chosen level', async () => {
    const { callbacks, ui } = renderToolbar();
    const button = ui.getByRole('button', { name: /^Model:/ });
    fireEvent.click(button);
    const low = ui.getByRole('option', { name: 'Low' });
    low.focus();
    fireEvent.click(low);
    await flush();
    expect(callbacks.onEffortLevelChange).toHaveBeenCalledWith('low');
    expect(button.getAttribute('aria-label')).toBe('Model: Sonnet, effort Low');
    expect(button.querySelector('.claudian-thinking-current')?.textContent).toBe('Low');
    const chosen = within(ui.getByRole('listbox', { name: 'Thinking' })).getByRole('option', { name: 'Low', selected: true });
    expect(document.activeElement).toBe(chosen);
    expect(chosen.tabIndex).toBe(0);
    expect(ui.getByRole('dialog', { name: 'Model options' })).toBeDefined();
  });

  it('restores focus to the chosen model when another upstream group has a model of the same name', async () => {
    const { callbacks, ui } = renderToolbar({
      settings: { model: 'openai/gpt-5' },
      models: [
        { value: 'openai/gpt-5', label: 'GPT-5', group: 'OpenAI' },
        { value: 'openrouter/gpt-5', label: 'GPT-5', group: 'OpenRouter' },
      ],
    });
    fireEvent.click(ui.getByRole('button', { name: /^Model: GPT-5/ }));
    const routed = within(ui.getByRole('group', { name: 'OpenRouter' })).getByRole('option', { name: 'GPT-5' });
    routed.focus();
    fireEvent.click(routed);
    await flush();
    expect(callbacks.onModelChange).toHaveBeenCalledWith('openrouter/gpt-5');
    const chosen = within(ui.getByRole('group', { name: 'OpenRouter' })).getByRole('option', { name: 'GPT-5', selected: true });
    expect(document.activeElement).toBe(chosen);
  });

  it('keeps one tab stop in the level list when neither the saved nor the default level is listed', () => {
    const { ui } = renderToolbar({ reasoningOptions: [{ value: 'low', label: 'Low' }, { value: 'max', label: 'Max' }] });
    fireEvent.click(ui.getByRole('button', { name: /^Model: Sonnet/ }));
    const levels = within(ui.getByRole('listbox', { name: 'Thinking' })).getAllByRole('option');
    expect(levels.map(level => [level.getAttribute('aria-selected'), level.tabIndex])).toEqual([['false', 0], ['false', -1]]);
  });

  it('keeps a saved level the provider no longer lists on the button without selecting a listed one', () => {
    const { ui } = renderToolbar({ settings: { reasoning: 'ultra' } });
    fireEvent.click(ui.getByRole('button', { name: 'Model: Sonnet, effort Ultra' }));
    const levels = within(ui.getByRole('listbox', { name: 'Thinking' })).getAllByRole('option');
    expect(levels.filter(level => level.getAttribute('aria-selected') === 'true')).toEqual([]);
    // The default level holds the list's tab stop.
    expect(levels.map(level => level.tabIndex)).toEqual([-1, 0, -1, -1]);
  });

  it.each([
    ['provider without reasoning control', { reasoningControl: 'none' }],
    ['no reasoning options', { reasoningOptions: [] }],
    ['only the default reasoning option', { reasoningOptions: [{ value: 'high', label: 'High' }] }],
  ])('omits reasoning for a %s', (_case, fixture) => {
    const { ui } = renderToolbar(fixture);
    fireEvent.click(ui.getByRole('button', { name: 'Model: Sonnet' }));
    expect(ui.getByRole('dialog', { name: 'Model options' })).toBeDefined();
    expect(ui.getByRole('listbox', { name: 'Model' })).toBeDefined();
    expect(ui.queryByRole('listbox', { name: 'Thinking' })).toBeNull();
  });

  it('shows fast mode on the button and switches it from the model menu', async () => {
    const { callbacks, toolbar, ui, settings } = renderToolbar({ serviceTier: true });
    const button = ui.getByRole('button', { name: 'Model: Sonnet, effort High' });
    expect(button.querySelector('.claudian-service-tier-indicator')?.classList.contains('claudian-hidden')).toBe(true);
    fireEvent.click(button);
    const fastMode = ui.getByRole('switch', { name: 'Fast' });
    expect(fastMode.getAttribute('aria-checked')).toBe('false');
    expect(fastMode.getAttribute('title')).toBe('Fast mode: Standard\n1.5x speed, 2x credits');
    fireEvent.click(fastMode);
    await flush();
    expect(callbacks.onServiceTierChange).toHaveBeenCalledWith('fast');
    expect(ui.getByRole('switch', { name: 'Fast' }).getAttribute('aria-checked')).toBe('true');
    expect(ui.getByRole('button', { name: 'Model: Sonnet, effort High, fast mode on' })).toBe(button);
    expect(button.querySelector('.claudian-service-tier-indicator')?.classList.contains('claudian-hidden')).toBe(false);
    fireEvent.click(ui.getByRole('switch', { name: 'Fast' }));
    await flush();
    expect(callbacks.onServiceTierChange).toHaveBeenLastCalledWith('default');
    expect(ui.getByRole('switch', { name: 'Fast' }).getAttribute('aria-checked')).toBe('false');

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

  it('offers fast mode only while the list shows the model in use, as for a model without it', () => {
    const { ui } = renderToolbar({
      serviceTier: true,
      models: [
        { value: 'sonnet', label: 'Sonnet', providerId: 'claude', providerLabel: 'Claude' },
        { value: 'pi-model', label: 'Pi Model', providerId: 'pi', providerLabel: 'Pi' },
      ],
    });
    fireEvent.click(ui.getByRole('button', { name: /^Model: Sonnet/ }));
    expect(ui.getByRole('switch', { name: 'Fast' })).toBeDefined();
    // Browsing another provider chooses no model there, so it has no fast mode to offer.
    fireEvent.click(ui.getByRole('tab', { name: 'Pi' }));
    expect(ui.getByRole('listbox', { name: 'Model' })).toBeDefined();
    expect(ui.queryByRole('switch', { name: 'Fast', hidden: true })).toBeNull();
    fireEvent.click(ui.getByRole('tab', { name: 'Claude' }));
    expect(ui.getByRole('switch', { name: 'Fast' })).toBeDefined();
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
    const models = within(unavailable.ui.getByRole('listbox', { name: 'Model' }));
    expect(models.queryAllByRole('option', { selected: true })).toEqual([]);
    // With nothing selected, the first model is the list's tab stop.
    expect(models.getAllByRole('option').map(option => option.tabIndex)).toEqual([0, -1, -1]);

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
    const { callbacks, host, toolbar, ui, uiConfig } = renderToolbar({
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
    vi.mocked(setIcon).mockClear();
    const { callbacks, host, toolbar, ui } = renderToolbar();
    const button = ui.getByRole('button', { name: 'Permission mode: Safe' });
    const chipIcons = () => vi.mocked(setIcon).mock.calls
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
    vi.mocked(setIcon).mockClear();
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
