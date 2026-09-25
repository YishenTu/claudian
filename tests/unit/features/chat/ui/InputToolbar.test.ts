import {
  TEST_CODEX_MODEL,
  TEST_CODEX_MODEL_LABEL,
} from '@test/helpers/codexModels';
import { createMockEl } from '@test/helpers/MockElement';

import type { UsageInfo } from '@/core/types';
import {
  ContextUsageMeter,
  createInputToolbar,
  InputToolbarLayoutController,
  ModelSelector,
  ModeSelector,
  PermissionToggle,
  ServiceTierToggle,
  ThinkingBudgetSelector,
} from '@/features/chat/ui/InputToolbar';

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

const DEFAULT_MODELS = [
  { value: 'haiku', label: 'Haiku', description: 'Fast and efficient' },
  { value: 'sonnet', label: 'Sonnet', description: 'Balanced performance' },
  { value: 'opus', label: 'Opus', description: 'Most capable' },
];

const EFFORT_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Med' },
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Max' },
];

const BUDGET_OPTIONS = [
  { value: 'off', label: 'Off', tokens: 0 },
  { value: 'low', label: 'Low', tokens: 4000 },
  { value: 'medium', label: 'Med', tokens: 8000 },
  { value: 'high', label: 'High', tokens: 16000 },
  { value: 'xhigh', label: 'Ultra', tokens: 32000 },
];

function createMockUIConfig() {
  return {
    getProviderIcon: jest.fn().mockReturnValue(null),
    getModelOptions: jest.fn().mockReturnValue(DEFAULT_MODELS),
    isAdaptiveReasoningModel: jest.fn().mockReturnValue(true),
    getReasoningOptions: jest.fn().mockReturnValue(EFFORT_OPTIONS),
    getDefaultReasoningValue: jest.fn().mockReturnValue('high'),
    getPermissionModeToggle: jest.fn().mockReturnValue({
      inactiveValue: 'normal',
      inactiveLabel: 'Safe',
      activeValue: 'yolo',
      activeLabel: 'YOLO',
    }),
    getServiceTierToggle: jest.fn().mockImplementation((settings: Record<string, unknown>) =>
      settings.model === TEST_CODEX_MODEL
        ? {
          inactiveValue: 'default',
          inactiveLabel: 'Standard',
          activeValue: 'fast',
          activeLabel: 'Fast',
          isActive: settings.serviceTier === 'fast',
          description: '1.5x speed, 2x credits',
        }
        : null
    ),
    getModeSelector: jest.fn().mockImplementation((settings: Record<string, unknown>) => ({
      activeValue: 'build',
      label: 'Mode',
      options: [
        { value: 'build', label: 'Build', description: 'Default editing agent' },
        { value: 'plan', label: 'Plan', description: 'Planning-first agent' },
      ],
      value: typeof settings.selectedMode === 'string' && settings.selectedMode
        ? settings.selectedMode
        : 'build',
    })),
  };
}

function createMockCallbacks(overrides: Record<string, any> = {}) {
  return {
    onModelChange: jest.fn().mockResolvedValue(undefined),
    onModeChange: jest.fn().mockResolvedValue(undefined),
    onThinkingBudgetChange: jest.fn().mockResolvedValue(undefined),
    onEffortLevelChange: jest.fn().mockResolvedValue(undefined),
    onServiceTierChange: jest.fn().mockResolvedValue(undefined),
    onPermissionModeChange: jest.fn().mockResolvedValue(undefined),
    getSettings: jest.fn().mockReturnValue({
      model: 'sonnet',
      reasoning: 'high',
      serviceTier: 'default',
      permissionMode: 'normal',
      selectedMode: 'build',
      enableOpus1M: false,
      enableSonnet1M: false,
    }),
    getEnvironmentVariables: jest.fn().mockReturnValue(''),
    getUIConfig: jest.fn().mockReturnValue(createMockUIConfig()),
    getCapabilities: jest.fn().mockReturnValue({
      providerId: 'claude',
      supportsNativeHistory: true,
      supportsRewind: true,
      supportsFork: true,
      supportsProviderCommands: true,
      reasoningControl: 'effort',
    }),
    ...overrides,
  };
}

describe('ModelSelector', () => {
  let parentEl: any;
  let callbacks: ReturnType<typeof createMockCallbacks>;
  let selector: ModelSelector;

  beforeEach(() => {
    jest.clearAllMocks();
    parentEl = createMockEl();
    callbacks = createMockCallbacks();
    selector = new ModelSelector(parentEl, callbacks);
  });

  it('should display current model label', () => {
    expect(parentEl.querySelector('.claudian-model-selector')).not.toBeNull();
    // Default model is 'sonnet' which maps to 'Sonnet'
    const btn = parentEl.querySelector('.claudian-model-btn');
    expect(btn).not.toBeNull();
    expect(btn?.hasClass('ready')).toBe(false);
    const label = btn?.querySelector('.claudian-model-label');
    expect(label).not.toBeNull();
    expect(label?.textContent).toBe('Sonnet');
  });

  it('should display the selected provider icon before the model label', () => {
    const providerIcon = {
      kind: 'path' as const,
      viewBox: '0 0 16 16',
      path: 'M1 1h14v14H1z',
    };
    const uiConfig = createMockUIConfig();
    uiConfig.getProviderIcon.mockReturnValue(providerIcon);
    callbacks.getUIConfig.mockReturnValue(uiConfig);

    selector.updateDisplay();

    const btn = parentEl.querySelector('.claudian-model-btn');
    const icon = btn?.querySelector('.claudian-model-provider-icon');
    const label = btn?.querySelector('.claudian-model-label');
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute('width')).toBe('12');
    expect(icon?.getAttribute('height')).toBe('12');
    expect(btn?.children).toEqual([icon, label]);
  });

  it('should prefer the selected model provider icon in a mixed-provider picker', () => {
    const selectedProviderIcon = {
      kind: 'path' as const,
      viewBox: '0 0 24 24',
      path: 'M2 2h20v20H2z',
    };
    const uiConfig = createMockUIConfig();
    uiConfig.getModelOptions.mockReturnValue([
      { value: 'sonnet', label: 'Sonnet', providerIcon: selectedProviderIcon },
    ]);
    callbacks.getUIConfig.mockReturnValue(uiConfig);

    selector.updateDisplay();

    const icon = parentEl.querySelector('.claudian-model-btn')
      ?.querySelector('.claudian-model-provider-icon');
    expect(icon?.getAttribute('viewBox')).toBe(selectedProviderIcon.viewBox);
  });

  it('shows an unavailable selection instead of displaying another model', () => {
    callbacks.getSettings.mockReturnValue({
      model: 'nonexistent',
      reasoning: 'low',
      serviceTier: 'default',
      permissionMode: 'normal',
      enableOpus1M: false,
      enableSonnet1M: false,
    });
    selector.updateDisplay();
    const label = parentEl.querySelector('.claudian-model-label');
    expect(label?.textContent).toBe('Model unavailable');
  });

  it('should render model options in reverse order', () => {
    const dropdown = parentEl.querySelector('.claudian-model-dropdown');
    expect(dropdown).not.toBeNull();
    // DEFAULT_CLAUDE_MODELS is [haiku, sonnet, opus] -> reversed is [opus, sonnet, haiku]
    const options = dropdown?.children || [];
    expect(options.length).toBe(3);
    expect(options.filter((option: any) => option.hasClass('claudian-model-group'))).toHaveLength(0);
    // Text is in child span, check first child's textContent
    expect(options[0]?.children[0]?.textContent).toBe('Opus');
    expect(options[1]?.children[0]?.textContent).toBe('Sonnet');
    expect(options[2]?.children[0]?.textContent).toBe('Haiku');
  });

  it('should reread model options before the dropdown becomes visible', () => {
    const uiConfig = callbacks.getUIConfig();
    uiConfig.getModelOptions.mockReturnValue([
      { value: 'gpt-new', label: 'GPT New' },
      { value: 'gpt-fast', label: 'GPT Fast' },
    ]);
    callbacks.getSettings.mockReturnValue({
      model: 'gpt-new',
      reasoning: 'high',
      serviceTier: 'default',
      permissionMode: 'normal',
    });

    parentEl.querySelector('.claudian-model-selector')?.dispatchEvent('mouseenter');

    expect(parentEl.querySelector('.claudian-model-label')?.textContent).toBe('GPT New');
    const options = parentEl.querySelector('.claudian-model-dropdown')?.children ?? [];
    expect(options.map((option: any) => option.children[0]?.textContent)).toEqual([
      'GPT Fast',
      'GPT New',
    ]);
  });

  it('should call onModelChange when option clicked', async () => {
    const dropdown = parentEl.querySelector('.claudian-model-dropdown');
    const options = dropdown?.children || [];
    const sonnetOption = options.find((o: any) => o.children[0]?.textContent === 'Sonnet');
    expect(sonnetOption?.hasClass('selected')).toBe(true);
    const opusOption = options.find((o: any) => o.children[0]?.textContent === 'Opus');

    await opusOption?.dispatchEvent('click', { stopPropagation: () => {} });
    expect(callbacks.onModelChange).toHaveBeenCalledWith('opus');
  });

  it('should forward environment settings and render the supplied custom model', () => {
    callbacks.getEnvironmentVariables.mockReturnValue(
      'CLAUDE_CODE_USE_BEDROCK=1\nANTHROPIC_MODEL=us.anthropic.claude-sonnet-4-20250514-v1:0'
    );
    callbacks.getSettings.mockReturnValue({
      model: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
      reasoning: 'low',
      permissionMode: 'normal',
      enableOpus1M: false,
      enableSonnet1M: false,
    });
    const uiConfig = callbacks.getUIConfig();
    uiConfig.getModelOptions.mockReturnValue([{
      value: 'us.anthropic.claude-sonnet-4-20250514-v1:0', label: 'Gateway model',
    }]);
    selector.renderOptions();
    selector.updateDisplay();
    // Custom models should be available in dropdown
    const label = parentEl.querySelector('.claudian-model-label');
    expect(label?.textContent).toBe('Gateway model');
    expect(uiConfig.getModelOptions).toHaveBeenLastCalledWith({
      ...callbacks.getSettings(), environmentVariables: callbacks.getEnvironmentVariables(),
    });
    const options = parentEl.querySelector('.claudian-model-dropdown')?.children ?? [];
    expect(options.map((option: any) => option.children[0]?.textContent)).toEqual(['Gateway model']);
  });

  it('should render supplied env model without changing provider options', () => {
    callbacks.getEnvironmentVariables.mockReturnValue(
      'ANTHROPIC_MODEL=opus'
    );
    callbacks.getSettings.mockReturnValue({
      model: 'opus',
      reasoning: 'low',
      permissionMode: 'normal',
      enableOpus1M: true,
      enableSonnet1M: true,
    });

    const uiConfig = callbacks.getUIConfig();
    uiConfig.getModelOptions.mockReturnValue([{ value: 'opus', label: 'Opus' }]);
    selector.renderOptions();
    selector.updateDisplay();

    const label = parentEl.querySelector('.claudian-model-label');
    expect(label?.textContent).toBe('Opus');
    expect(uiConfig.getModelOptions).toHaveBeenLastCalledWith({
      ...callbacks.getSettings(), environmentVariables: callbacks.getEnvironmentVariables(),
    });
    const options = parentEl.querySelector('.claudian-model-dropdown')?.children ?? [];
    expect(options.map((option: any) => option.children[0]?.textContent)).toEqual(['Opus']);
  });

  it('should render group separators when models have group field', () => {
    const groupedModels = [
      { value: 'opus', label: 'Opus', group: 'Claude' },
      { value: 'sonnet', label: 'Sonnet', group: 'Claude' },
      { value: TEST_CODEX_MODEL, label: TEST_CODEX_MODEL_LABEL, group: 'Codex' },
    ];
    const uiConfig = createMockUIConfig();
    uiConfig.getModelOptions.mockReturnValue(groupedModels);
    callbacks.getUIConfig.mockReturnValue(uiConfig);
    callbacks.getSettings.mockReturnValue({
      model: 'sonnet',
      reasoning: 'high',
      serviceTier: 'default',
      permissionMode: 'normal',
    });

    selector.renderOptions();

    const dropdown = parentEl.querySelector('.claudian-model-dropdown');
    const children = dropdown?.children || [];
    // Reversed: [Codex group, built-in Codex model, Claude group, Sonnet, Opus]
    const groups = children.filter((c: any) => c.hasClass('claudian-model-group'));
    expect(groups.length).toBe(2);
    expect(groups[0]?.textContent).toBe('Codex');
    expect(groups[1]?.textContent).toBe('Claude');
  });

  it('should render provider-supplied model variants', () => {
    callbacks.getSettings.mockReturnValue({
      model: 'opus[1m]',
      reasoning: 'medium',
      serviceTier: 'default',
      permissionMode: 'normal',
      enableOpus1M: true,
      enableSonnet1M: true,
    });

    const uiConfig = callbacks.getUIConfig();
    uiConfig.getModelOptions.mockReturnValue([
      { value: 'haiku', label: 'Haiku' },
      { value: 'sonnet[1m]', label: 'Sonnet 1M' },
      { value: 'opus[1m]', label: 'Opus 1M' },
    ]);
    selector.renderOptions();
    selector.updateDisplay();

    const dropdown = parentEl.querySelector('.claudian-model-dropdown');
    const options = dropdown?.children || [];
    expect(options.find((o: any) => o.children[0]?.textContent === 'Opus 1M')).toBeDefined();
    expect(options.find((o: any) => o.children[0]?.textContent === 'Sonnet 1M')).toBeDefined();
    expect(options.find((o: any) => o.children[0]?.textContent === 'Opus')).toBeUndefined();
    expect(options.find((o: any) => o.children[0]?.textContent === 'Sonnet')).toBeUndefined();
    expect(parentEl.querySelector('.claudian-model-label')?.textContent).toBe('Opus 1M');
    expect(uiConfig.getModelOptions).toHaveBeenLastCalledWith({
      ...callbacks.getSettings(), environmentVariables: callbacks.getEnvironmentVariables(),
    });
  });
});

describe('ModeSelector', () => {
  let parentEl: any;
  let callbacks: ReturnType<typeof createMockCallbacks>;
  let selector: ModeSelector;

  beforeEach(() => {
    jest.clearAllMocks();
    parentEl = createMockEl();
    callbacks = createMockCallbacks();
    selector = new ModeSelector(parentEl, callbacks);
  });

  it('should call onModeChange when the toggle is clicked', async () => {
    const toggle = parentEl.querySelector('.claudian-toggle-switch');
    await toggle?.dispatchEvent('click');

    expect(callbacks.onModeChange).toHaveBeenCalledWith('plan');
  });

  it('should show the active style when the configured active mode is selected', () => {
    callbacks.getSettings.mockReturnValue({
      model: 'sonnet',
      reasoning: 'high',
      serviceTier: 'default',
      permissionMode: 'normal',
      selectedMode: 'build',
      enableOpus1M: false,
      enableSonnet1M: false,
    });

    const parentEl2 = createMockEl();
    new ModeSelector(parentEl2, callbacks);

    expect(parentEl2.querySelector('.claudian-mode-selector')).not.toBeNull();
    const label = parentEl2.querySelector('.claudian-mode-label');
    const toggle = parentEl2.querySelector('.claudian-toggle-switch');
    expect(label?.textContent).toBe('Build');
    expect(label?.hasClass('active')).toBe(true);
    expect(toggle?.hasClass('active')).toBe(true);
  });

  it('should show the inactive style when the configured inactive mode is selected', () => {
    callbacks.getSettings.mockReturnValue({
      model: 'sonnet',
      reasoning: 'high',
      serviceTier: 'default',
      permissionMode: 'normal',
      selectedMode: 'plan',
      enableOpus1M: false,
      enableSonnet1M: false,
    });

    const parentEl2 = createMockEl();
    new ModeSelector(parentEl2, callbacks);

    const label = parentEl2.querySelector('.claudian-mode-label');
    const toggle = parentEl2.querySelector('.claudian-toggle-switch');
    expect(label?.textContent).toBe('Plan');
    expect(label?.hasClass('active')).toBe(false);
    expect(toggle?.hasClass('active')).toBe(false);
  });

  it('should hide when the provider exposes no mode selector', () => {
    const uiConfig = createMockUIConfig();
    uiConfig.getModeSelector.mockReturnValue(null);
    callbacks.getUIConfig.mockReturnValue(uiConfig);

    selector.updateDisplay();

    const container = parentEl.querySelector('.claudian-mode-selector');
    expect(container?.style?.display).toBe('none');
  });
});

describe('ThinkingBudgetSelector', () => {
  let parentEl: any;
  let callbacks: ReturnType<typeof createMockCallbacks>;
  let selector: ThinkingBudgetSelector;

  describe('adaptive provider configuration', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      parentEl = createMockEl();
      callbacks = createMockCallbacks();
      selector = new ThinkingBudgetSelector(parentEl, callbacks);
    });

    it('should display current effort level for adaptive providers', () => {
      expect(parentEl.querySelector('.claudian-thinking-selector')).not.toBeNull();
      const effort = parentEl.querySelector('.claudian-thinking-effort');
      expect(effort).not.toBeNull();
      expect(effort?.style?.display).not.toBe('none');
      expect(effort?.querySelector('.claudian-thinking-label-text')?.textContent).toBe('Effort:');
      expect(parentEl.querySelector('.claudian-thinking-budget')?.style?.display).toBe('none');
      const current = parentEl.querySelector('.claudian-thinking-current');
      expect(current?.textContent).toBe('High');
    });

  });

  describe('budget provider configuration', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      parentEl = createMockEl();
      callbacks = createMockCallbacks({
        getSettings: jest.fn().mockReturnValue({
          model: 'custom-model',
          reasoning: 'low',
          serviceTier: 'default',
          permissionMode: 'normal',
          enableOpus1M: false,
          enableSonnet1M: false,
        }),
      });
      callbacks.getUIConfig().isAdaptiveReasoningModel.mockReturnValue(false);
      callbacks.getUIConfig().getReasoningOptions.mockReturnValue(BUDGET_OPTIONS);
      selector = new ThinkingBudgetSelector(parentEl, callbacks);
    });

    it('should display current budget label', () => {
      expect(parentEl.querySelector('.claudian-thinking-effort')?.style?.display).toBe('none');
      expect(parentEl.querySelector('.claudian-thinking-budget')?.style?.display).not.toBe('none');
      const current = parentEl.querySelector('.claudian-thinking-current');
      expect(current?.textContent).toBe('Low');
    });

    it('should display Off when budget is off', () => {
      callbacks.getSettings.mockReturnValue({
        model: 'custom-model',
        reasoning: 'off',
        serviceTier: 'default',
        permissionMode: 'normal',
        enableOpus1M: false,
        enableSonnet1M: false,
      });
      selector.updateDisplay();
      const current = parentEl.querySelector('.claudian-thinking-current');
      expect(current?.textContent).toBe('Off');
    });

    it('should render budget options in reverse order', () => {
      const options = parentEl.querySelector('.claudian-thinking-options');
      expect(options).not.toBeNull();
      // THINKING_BUDGETS reversed: [xhigh, high, medium, low, off]
      const gears = options?.children || [];
      expect(gears.length).toBe(5);
      expect(gears[0]?.textContent).toBe('Ultra');
      expect(gears[4]?.textContent).toBe('Off');
      expect(gears.find((gear: any) => gear.textContent === 'Low')?.hasClass('selected')).toBe(true);
      expect(gears.find((gear: any) => gear.textContent === 'High')?.getAttribute('title')).toContain('16,000 tokens');
      expect(gears.find((gear: any) => gear.textContent === 'Off')?.getAttribute('title')).toBe('Disabled');
    });

    it('should call onThinkingBudgetChange when gear clicked', async () => {
      const options = parentEl.querySelector('.claudian-thinking-options');
      const gears = options?.children || [];
      const highGear = gears.find((g: any) => g.textContent === 'High');

      await highGear?.dispatchEvent('click', { stopPropagation: () => {} });
      expect(callbacks.onThinkingBudgetChange).toHaveBeenCalledWith('high');
    });

  });
});

describe('PermissionToggle', () => {
  let parentEl: any;
  let callbacks: ReturnType<typeof createMockCallbacks>;

  beforeEach(() => {
    jest.clearAllMocks();
    parentEl = createMockEl();
    callbacks = createMockCallbacks();
    new PermissionToggle(parentEl, callbacks);
  });

  it('should toggle from normal to yolo on click', async () => {
    expect(parentEl.querySelector('.claudian-permission-toggle')).not.toBeNull();
    expect(parentEl.querySelector('.claudian-permission-label')?.textContent).toBe('Safe');
    const toggle = parentEl.querySelector('.claudian-toggle-switch');
    expect(toggle?.hasClass('active')).toBe(false);
    await toggle?.dispatchEvent('click');
    expect(callbacks.onPermissionModeChange).toHaveBeenCalledWith('yolo');
  });

  it('should toggle from yolo to normal on click', async () => {
    callbacks.getSettings.mockReturnValue({
      model: 'sonnet',
      reasoning: 'low',
      permissionMode: 'yolo',
    });
    const parentEl2 = createMockEl();
    new PermissionToggle(parentEl2, callbacks);

    const toggle = parentEl2.querySelector('.claudian-toggle-switch');
    expect(parentEl2.querySelector('.claudian-permission-label')?.textContent).toBe('YOLO');
    expect(toggle?.hasClass('active')).toBe(true);
    await toggle?.dispatchEvent('click');
    expect(callbacks.onPermissionModeChange).toHaveBeenCalledWith('normal');
  });

  it('should hide the control when provider exposes no permission toggle UI', () => {
    callbacks.getUIConfig.mockReturnValue({
      ...createMockUIConfig(),
      getPermissionModeToggle: jest.fn().mockReturnValue(null),
    });
    const parentEl2 = createMockEl();
    new PermissionToggle(parentEl2, callbacks);

    const container = parentEl2.querySelector('.claudian-permission-toggle');
    expect(container?.style.display).toBe('none');
  });

  it('should hide the control when visibility is disabled explicitly', () => {
    const parentEl2 = createMockEl();
    const toggle = new PermissionToggle(parentEl2, callbacks);

    toggle.setVisible(false);

    const container = parentEl2.querySelector('.claudian-permission-toggle');
    expect(container?.style.display).toBe('none');
  });
});

describe('ServiceTierToggle', () => {
  let parentEl: any;
  let callbacks: ReturnType<typeof createMockCallbacks>;
  let uiConfig: ReturnType<typeof createMockUIConfig>;

  beforeEach(() => {
    jest.clearAllMocks();
    parentEl = createMockEl();
    uiConfig = createMockUIConfig();
    uiConfig.getServiceTierToggle.mockReturnValue({
      inactiveValue: 'default',
      inactiveLabel: 'Standard',
      activeValue: 'fast',
      activeLabel: 'Fast',
      description: '1.5x speed, 2x credits',
      isActive: false,
    });
    callbacks = createMockCallbacks({
      getUIConfig: jest.fn().mockReturnValue(uiConfig),
      getSettings: jest.fn().mockReturnValue({
        model: TEST_CODEX_MODEL,
        reasoning: 'medium',
        serviceTier: 'default',
        permissionMode: 'normal',
      }),
    });
    new ServiceTierToggle(parentEl, callbacks);
  });

  it('toggles from Standard to Fast on click', async () => {
    const container = parentEl.querySelector('.claudian-service-tier-toggle');
    expect(container).not.toBeNull();
    expect(container?.hasClass('claudian-hidden')).toBe(false);
    expect(container?.getAttribute('title')).toBe('Fast mode: Standard');
    expect(parentEl.querySelector('.claudian-service-tier-icon')).not.toBeNull();
    const button = parentEl.querySelector('.claudian-service-tier-button');
    expect(button?.hasClass('active')).toBe(false);
    await button?.dispatchEvent('click');
    expect(callbacks.onServiceTierChange).toHaveBeenCalledWith('fast');
  });

  it('toggles from Fast to Standard on click', async () => {
    uiConfig.getServiceTierToggle.mockReturnValue({
      inactiveValue: 'default',
      inactiveLabel: 'Standard',
      activeValue: 'fast',
      activeLabel: 'Fast',
      description: '1.5x speed, 2x credits',
      isActive: true,
    });
    const parentEl2 = createMockEl();
    new ServiceTierToggle(parentEl2, callbacks);

    const button = parentEl2.querySelector('.claudian-service-tier-button');
    expect(callbacks.getSettings().serviceTier).toBe('default');
    expect(button?.hasClass('active')).toBe(true);
    expect(parentEl2.querySelector('.claudian-service-tier-toggle')?.getAttribute('title')).toBe('Fast mode: Fast');
    await button?.dispatchEvent('click');
    expect(callbacks.onServiceTierChange).toHaveBeenCalledWith('default');
  });

  it('does not toggle when the provider exposes no fast service tier', async () => {
    callbacks.getUIConfig.mockReturnValue({
      ...createMockUIConfig(),
      getServiceTierToggle: jest.fn().mockReturnValue(null),
    });
    const parentEl2 = createMockEl();
    const toggle = new ServiceTierToggle(parentEl2, callbacks);

    expect(parentEl2.querySelector('.claudian-service-tier-toggle')?.style.display).toBe('none');
    await expect(toggle.toggle()).resolves.toBe(false);
    expect(callbacks.onServiceTierChange).not.toHaveBeenCalled();
  });
});

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
    expect(container?.getAttribute('data-tooltip')).toBe('50k / 200k');
    expect(container?.getAttribute('role')).toBe('progressbar');
    expect(container?.getAttribute('aria-label')).toBe('Context usage');
    expect(container?.getAttribute('aria-valuemin')).toBe('0');
    expect(container?.getAttribute('aria-valuemax')).toBe('100');
    expect(container?.getAttribute('aria-valuenow')).toBe('25');
    expect(container?.getAttribute('aria-valuetext')).toBe('50k / 200k');
  });

  it('should remove warning class when usage drops below 80%', () => {
    meter.update(makeUsage({ contextTokens: 170000, contextWindow: 200000, percentage: 85 }));
    const warningContainer = parentEl.querySelector('.claudian-context-meter');
    expect(warningContainer?.hasClass('warning')).toBe(true);
    expect(warningContainer?.getAttribute('data-tooltip')).toBe('170k / 200k (Approaching limit, run `/compact` to continue)');
    meter.update(makeUsage({ contextTokens: 50000, contextWindow: 200000, percentage: 25 }));
    const container = parentEl.querySelector('.claudian-context-meter');
    expect(container?.hasClass('warning')).toBe(false);
  });

  it('should format small token counts without k suffix', () => {
    meter.update(makeUsage({ contextTokens: 500, contextWindow: 200000, percentage: 0 }));
    const container = parentEl.querySelector('.claudian-context-meter');
    expect(container?.getAttribute('data-tooltip')).toBe('500 / 200k');
  });

  it('should not add compact reminder to tooltip when usage ≤ 80%', () => {
    meter.update(makeUsage({ contextTokens: 160000, contextWindow: 200000, percentage: 80 }));
    const container = parentEl.querySelector('.claudian-context-meter');
    expect(container?.getAttribute('data-tooltip')).toBe('160k / 200k');
  });
});

describe('InputToolbarLayoutController', () => {
  function setRect(element: any, top: number, width = 40, height = 24): void {
    element.getBoundingClientRect = jest.fn().mockReturnValue({
      top,
      bottom: top + height,
      left: 0,
      right: width,
      width,
      height,
      x: 0,
      y: top,
      toJSON: jest.fn(),
    });
  }

  it('should show optional labels when all toolbar items fit on one line', () => {
    const toolbarEl = createMockEl();
    const firstItem = toolbarEl.createDiv();
    const secondItem = toolbarEl.createDiv();
    setRect(firstItem, 0, 40, 24);
    setRect(secondItem, 3, 40, 18);
    toolbarEl.addClass('claudian-input-toolbar--compact');

    const controller = new InputToolbarLayoutController(toolbarEl);
    controller.refreshLayout();

    expect(toolbarEl.hasClass('claudian-input-toolbar--compact')).toBe(false);
    controller.destroy();
  });

  it('should remeasure after resize and disconnect its observer on destroy', () => {
    const toolbarEl = createMockEl();
    const firstItem = toolbarEl.createDiv();
    const secondItem = toolbarEl.createDiv();
    setRect(firstItem, 0);
    setRect(secondItem, 0);

    const observerCallbacks: {
      resize?: ResizeObserverCallback;
      frame?: FrameRequestCallback;
    } = {};
    const observe = jest.fn();
    const disconnect = jest.fn();
    toolbarEl.ownerDocument.defaultView.requestAnimationFrame = jest.fn((callback) => {
      observerCallbacks.frame = callback;
      return 1;
    });
    toolbarEl.ownerDocument.defaultView.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) {
        observerCallbacks.resize = callback;
      }
      observe = observe;
      unobserve = jest.fn();
      disconnect = disconnect;
    };

    const controller = new InputToolbarLayoutController(toolbarEl);
    expect(observe).toHaveBeenCalledWith(toolbarEl);
    observerCallbacks.frame?.(0);
    expect(toolbarEl.hasClass('claudian-input-toolbar--compact')).toBe(false);

    setRect(secondItem, 36);
    observerCallbacks.resize?.([], {} as ResizeObserver);
    observerCallbacks.frame?.(0);
    expect(toolbarEl.hasClass('claudian-input-toolbar--compact')).toBe(true);

    controller.destroy();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('should release earlier observers when layout construction fails', () => {
    const toolbarEl = createMockEl();
    const disconnectResize = jest.fn();
    const disconnectMutation = jest.fn();
    const observerError = new Error('mutation observer failed');
    toolbarEl.ownerDocument.defaultView.ResizeObserver = class {
      observe = jest.fn();
      unobserve = jest.fn();
      disconnect = disconnectResize;
    };
    toolbarEl.ownerDocument.defaultView.MutationObserver = class {
      observe = jest.fn(() => {
        throw observerError;
      });
      disconnect = disconnectMutation;
      takeRecords = jest.fn().mockReturnValue([]);
    };

    expect(() => new InputToolbarLayoutController(toolbarEl)).toThrow(observerError);
    expect(disconnectResize).toHaveBeenCalledTimes(1);
    expect(disconnectMutation).toHaveBeenCalledTimes(1);
  });
});

describe('createInputToolbar', () => {

  it('should place the mode selector after the permission toggle in toolbar order', () => {
    const parentEl = createMockEl();
    const callbacks = createMockCallbacks();

    createInputToolbar(parentEl, callbacks);

    const permissionIndex = parentEl.children.findIndex((child: any) => child.hasClass('claudian-permission-toggle'));
    const modeIndex = parentEl.children.findIndex((child: any) => child.hasClass('claudian-mode-selector'));
    expect(permissionIndex).toBeGreaterThanOrEqual(0);
    expect(modeIndex).toBeGreaterThan(permissionIndex);
    expect(modeIndex).toBe(parentEl.children.length - 1);
  });
});
