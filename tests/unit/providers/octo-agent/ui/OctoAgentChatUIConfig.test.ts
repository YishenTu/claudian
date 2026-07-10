import { octoAgentChatUIConfig } from '@/providers/octo-agent/ui/OctoAgentChatUIConfig';

describe('octoAgentChatUIConfig', () => {
  describe('getModelOptions', () => {
    it('returns cached octo-agent models when available', () => {
      const options = octoAgentChatUIConfig.getModelOptions({
        octoAgentModels: [
          { value: 'octo-agent/kimi-for-coding', label: 'Kimi for Coding' },
          { value: 'octo-agent/claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
        ],
      });

      expect(options.map((option) => option.value)).toEqual([
        'octo-agent/kimi-for-coding',
        'octo-agent/claude-sonnet-4-5',
      ]);
    });

    it('falls back to the built-in default when no models are cached', () => {
      const options = octoAgentChatUIConfig.getModelOptions({});

      expect(options).toEqual([
        {
          description: 'Runs through the local octo-agent server',
          label: 'Octo Agent',
          value: 'octo-agent/kimi-for-coding',
        },
      ]);
    });
  });

  describe('ownsModel', () => {
    it('owns octo-agent prefixed models', () => {
      expect(octoAgentChatUIConfig.ownsModel('octo-agent/kimi-for-coding', {})).toBe(true);
      expect(octoAgentChatUIConfig.ownsModel('octo-agent', {})).toBe(true);
      expect(octoAgentChatUIConfig.ownsModel('octo-agent/octo-agent', {})).toBe(true);
    });

    it('does not own other providers', () => {
      expect(octoAgentChatUIConfig.ownsModel('claude-sonnet-4-5', {})).toBe(false);
      expect(octoAgentChatUIConfig.ownsModel('openai/gpt-4', {})).toBe(false);
    });
  });

  describe('normalizeModelVariant', () => {
    it('keeps a model that is present in the cached list', () => {
      const settings = {
        octoAgentModels: [
          { value: 'octo-agent/kimi-for-coding', label: 'Kimi' },
          { value: 'octo-agent/claude-sonnet-4-5', label: 'Sonnet' },
        ],
      };

      expect(octoAgentChatUIConfig.normalizeModelVariant('octo-agent/claude-sonnet-4-5', settings)).toBe(
        'octo-agent/claude-sonnet-4-5',
      );
    });

    it('falls back to the default when the model is not in the cached list', () => {
      const settings = {
        octoAgentModels: [
          { value: 'octo-agent/kimi-for-coding', label: 'Kimi' },
          { value: 'octo-agent/claude-sonnet-4-5', label: 'Sonnet' },
        ],
      };

      expect(octoAgentChatUIConfig.normalizeModelVariant('octo-agent/unknown-model', settings)).toBe(
        'octo-agent/kimi-for-coding',
      );
    });

    it('falls back to the first cached option when no default is available', () => {
      const settings = {
        octoAgentModels: [
          { value: 'octo-agent/claude-sonnet-4-5', label: 'Sonnet' },
        ],
      };

      expect(octoAgentChatUIConfig.normalizeModelVariant('octo-agent/unknown-model', settings)).toBe(
        'octo-agent/claude-sonnet-4-5',
      );
    });

    it('keeps octo-agent prefixed models when there is no cache', () => {
      expect(octoAgentChatUIConfig.normalizeModelVariant('octo-agent/custom', {})).toBe('octo-agent/custom');
    });

    it('normalizes non-octo-agent models to the default', () => {
      expect(octoAgentChatUIConfig.normalizeModelVariant('claude-sonnet-4-5', {})).toBe('octo-agent/kimi-for-coding');
    });
  });

  describe('getContextWindowSize', () => {
    it('returns the default 200k context window', () => {
      expect(octoAgentChatUIConfig.getContextWindowSize('octo-agent/kimi-for-coding', undefined, {})).toBe(200_000);
    });

    it('returns a custom limit when configured', () => {
      expect(
        octoAgentChatUIConfig.getContextWindowSize('octo-agent/kimi-for-coding', { 'octo-agent': 128_000 }, {}),
      ).toBe(128_000);
    });
  });

  describe('resolvePermissionMode', () => {
    it('returns a Claudian value from an octo-agent value', () => {
      expect(octoAgentChatUIConfig.resolvePermissionMode?.({ permissionMode: 'auto' })).toBe('yolo');
      expect(octoAgentChatUIConfig.resolvePermissionMode?.({ permissionMode: 'interactive' })).toBe('normal');
    });

    it('returns the stored Claudian value directly', () => {
      expect(octoAgentChatUIConfig.resolvePermissionMode?.({ permissionMode: 'yolo' })).toBe('yolo');
      expect(octoAgentChatUIConfig.resolvePermissionMode?.({ permissionMode: 'normal' })).toBe('normal');
      expect(octoAgentChatUIConfig.resolvePermissionMode?.({ permissionMode: 'plan' })).toBe('plan');
    });

    it('falls back to yolo when no value is stored', () => {
      expect(octoAgentChatUIConfig.resolvePermissionMode?.({})).toBe('yolo');
    });
  });

  describe('applyPermissionMode', () => {
    it('normalizes octo-agent values into Claudian values', () => {
      const settings: Record<string, unknown> = {};
      octoAgentChatUIConfig.applyPermissionMode?.('auto', settings);
      expect(settings.permissionMode).toBe('yolo');

      octoAgentChatUIConfig.applyPermissionMode?.('interactive', settings);
      expect(settings.permissionMode).toBe('normal');
    });

    it('stores Claudian values as-is', () => {
      const settings: Record<string, unknown> = {};
      octoAgentChatUIConfig.applyPermissionMode?.('plan', settings);
      expect(settings.permissionMode).toBe('plan');
    });
  });
});
