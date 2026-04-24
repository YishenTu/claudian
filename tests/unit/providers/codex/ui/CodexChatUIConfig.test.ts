import { DEFAULT_CODEX_PRIMARY_MODEL } from '@/providers/codex/types/models';
import { codexChatUIConfig } from '@/providers/codex/ui/CodexChatUIConfig';

describe('CodexChatUIConfig', () => {
  describe('getModelOptions', () => {
    it('should return default models when no env vars', () => {
      const options = codexChatUIConfig.getModelOptions({});
      expect(options).toHaveLength(2);
      expect(options.map(o => o.value)).toContain(DEFAULT_CODEX_PRIMARY_MODEL);
      expect(options.map(o => o.value)).toContain('gpt-5.4-mini');
    });

    it('should prepend custom model from OPENAI_MODEL env var', () => {
      const options = codexChatUIConfig.getModelOptions({
        environmentVariables: 'OPENAI_MODEL=my-custom-model',
      });
      expect(options[0].value).toBe('my-custom-model');
      expect(options[0].description).toBe('Custom (env)');
      expect(options.length).toBe(3);
    });

    it('should not duplicate when OPENAI_MODEL matches a default model', () => {
      const options = codexChatUIConfig.getModelOptions({
        environmentVariables: `OPENAI_MODEL=${DEFAULT_CODEX_PRIMARY_MODEL}`,
      });
      expect(options.length).toBe(2);
    });
  });

  describe('isAdaptiveReasoningModel', () => {
    it('should return true for all models', () => {
      expect(codexChatUIConfig.isAdaptiveReasoningModel(DEFAULT_CODEX_PRIMARY_MODEL)).toBe(true);
      expect(codexChatUIConfig.isAdaptiveReasoningModel('unknown-model')).toBe(true);
    });
  });

  describe('getReasoningOptions', () => {
    it('should return effort levels', () => {
      const options = codexChatUIConfig.getReasoningOptions(DEFAULT_CODEX_PRIMARY_MODEL);
      expect(options).toHaveLength(4);
      expect(options.map(o => o.value)).toEqual(['low', 'medium', 'high', 'xhigh']);
    });
  });

  describe('getDefaultReasoningValue', () => {
    it('should return medium for all models', () => {
      expect(codexChatUIConfig.getDefaultReasoningValue(DEFAULT_CODEX_PRIMARY_MODEL)).toBe('medium');
    });
  });

  describe('getContextWindowSize', () => {
    it('should return 200000 for all models', () => {
      expect(codexChatUIConfig.getContextWindowSize(DEFAULT_CODEX_PRIMARY_MODEL)).toBe(200_000);
    });
  });

  describe('isDefaultModel', () => {
    it('should return true for built-in models', () => {
      expect(codexChatUIConfig.isDefaultModel(DEFAULT_CODEX_PRIMARY_MODEL)).toBe(true);
      expect(codexChatUIConfig.isDefaultModel('gpt-5.4-mini')).toBe(true);
    });

    it('should return false for custom models', () => {
      expect(codexChatUIConfig.isDefaultModel('my-custom-model')).toBe(false);
    });
  });

  describe('normalizeModelVariant', () => {
    it('falls back unavailable Codex models to the current primary model', () => {
      expect(codexChatUIConfig.normalizeModelVariant('gpt-5.4', {})).toBe(DEFAULT_CODEX_PRIMARY_MODEL);
    });

    it('keeps visible models as-is', () => {
      expect(codexChatUIConfig.normalizeModelVariant(DEFAULT_CODEX_PRIMARY_MODEL, {})).toBe(DEFAULT_CODEX_PRIMARY_MODEL);
      expect(codexChatUIConfig.normalizeModelVariant('custom', {
        environmentVariables: 'OPENAI_MODEL=custom',
      })).toBe('custom');
    });
  });

  describe('getCustomModelIds', () => {
    it('should return custom model from env', () => {
      const ids = codexChatUIConfig.getCustomModelIds({ OPENAI_MODEL: 'my-model' });
      expect(ids.has('my-model')).toBe(true);
    });

    it('should not include default models', () => {
      const ids = codexChatUIConfig.getCustomModelIds({ OPENAI_MODEL: DEFAULT_CODEX_PRIMARY_MODEL });
      expect(ids.size).toBe(0);
    });

    it('should return empty set when no OPENAI_MODEL', () => {
      const ids = codexChatUIConfig.getCustomModelIds({});
      expect(ids.size).toBe(0);
    });
  });

  describe('getPermissionModeToggle', () => {
    it('should return yolo/safe toggle config with plan mode', () => {
      const toggle = codexChatUIConfig.getPermissionModeToggle!();
      expect(toggle).toEqual({
        inactiveValue: 'normal',
        inactiveLabel: 'Safe',
        activeValue: 'yolo',
        activeLabel: 'YOLO',
        planValue: 'plan',
        planLabel: 'Plan',
      });
    });
  });
});
