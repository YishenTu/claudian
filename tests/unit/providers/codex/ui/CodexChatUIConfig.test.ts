import { codexChatUIConfig } from '@/providers/codex/ui/CodexChatUIConfig';

describe('CodexChatUIConfig', () => {
  describe('getModelOptions', () => {
    it('should return default models when no env vars', () => {
      const options = codexChatUIConfig.getModelOptions({});
      expect(options.length).toBeGreaterThanOrEqual(3);
      expect(options.map(o => o.value)).toContain('codex-mini');
      expect(options.map(o => o.value)).toContain('gpt-4.1');
      expect(options.map(o => o.value)).toContain('o4-mini');
    });

    it('should prepend custom model from OPENAI_MODEL env var', () => {
      const options = codexChatUIConfig.getModelOptions({
        environmentVariables: 'OPENAI_MODEL=my-custom-model',
      });
      expect(options[0].value).toBe('my-custom-model');
      expect(options[0].description).toBe('Custom (env)');
      expect(options.length).toBe(4);
    });

    it('should not duplicate when OPENAI_MODEL matches a default model', () => {
      const options = codexChatUIConfig.getModelOptions({
        environmentVariables: 'OPENAI_MODEL=codex-mini',
      });
      expect(options.length).toBe(3);
    });
  });

  describe('isAdaptiveReasoningModel', () => {
    it('should return true for all models', () => {
      expect(codexChatUIConfig.isAdaptiveReasoningModel('codex-mini')).toBe(true);
      expect(codexChatUIConfig.isAdaptiveReasoningModel('gpt-4.1')).toBe(true);
      expect(codexChatUIConfig.isAdaptiveReasoningModel('o4-mini')).toBe(true);
      expect(codexChatUIConfig.isAdaptiveReasoningModel('unknown-model')).toBe(true);
    });
  });

  describe('getReasoningOptions', () => {
    it('should return effort levels', () => {
      const options = codexChatUIConfig.getReasoningOptions('codex-mini');
      expect(options).toHaveLength(3);
      expect(options.map(o => o.value)).toEqual(['low', 'medium', 'high']);
    });
  });

  describe('getDefaultReasoningValue', () => {
    it('should return medium for all models', () => {
      expect(codexChatUIConfig.getDefaultReasoningValue('codex-mini')).toBe('medium');
      expect(codexChatUIConfig.getDefaultReasoningValue('gpt-4.1')).toBe('medium');
    });
  });

  describe('getContextWindowSize', () => {
    it('should return 200000 for all models', () => {
      expect(codexChatUIConfig.getContextWindowSize('codex-mini')).toBe(200_000);
      expect(codexChatUIConfig.getContextWindowSize('gpt-4.1')).toBe(200_000);
    });
  });

  describe('isDefaultModel', () => {
    it('should return true for built-in models', () => {
      expect(codexChatUIConfig.isDefaultModel('codex-mini')).toBe(true);
      expect(codexChatUIConfig.isDefaultModel('gpt-4.1')).toBe(true);
      expect(codexChatUIConfig.isDefaultModel('o4-mini')).toBe(true);
    });

    it('should return false for custom models', () => {
      expect(codexChatUIConfig.isDefaultModel('my-custom-model')).toBe(false);
    });
  });

  describe('normalizeModelVariant', () => {
    it('should return model as-is', () => {
      expect(codexChatUIConfig.normalizeModelVariant('codex-mini', {})).toBe('codex-mini');
      expect(codexChatUIConfig.normalizeModelVariant('custom', {})).toBe('custom');
    });
  });

  describe('getCustomModelIds', () => {
    it('should return custom model from env', () => {
      const ids = codexChatUIConfig.getCustomModelIds({ OPENAI_MODEL: 'my-model' });
      expect(ids.has('my-model')).toBe(true);
    });

    it('should not include default models', () => {
      const ids = codexChatUIConfig.getCustomModelIds({ OPENAI_MODEL: 'codex-mini' });
      expect(ids.size).toBe(0);
    });

    it('should return empty set when no OPENAI_MODEL', () => {
      const ids = codexChatUIConfig.getCustomModelIds({});
      expect(ids.size).toBe(0);
    });
  });

  describe('getPermissionModeToggle', () => {
    it('should return null', () => {
      expect(codexChatUIConfig.getPermissionModeToggle!()).toBeNull();
    });
  });
});
