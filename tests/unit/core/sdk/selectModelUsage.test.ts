import { selectModelUsage } from '@/core/sdk/selectModelUsage';
import type { ModelUsageInfo } from '@/core/types';

describe('selectModelUsage', () => {
  describe('empty usage record', () => {
    it('should return null for empty usage record', () => {
      const result = selectModelUsage({});

      expect(result).toBeNull();
    });

    it('should return null for empty usage record with messageModel', () => {
      const result = selectModelUsage({}, 'claude-sonnet-4-5');

      expect(result).toBeNull();
    });

    it('should return null for empty usage record with intendedModel', () => {
      const result = selectModelUsage({}, undefined, 'claude-sonnet-4-5');

      expect(result).toBeNull();
    });
  });

  describe('priority 1: message.model exact match', () => {
    it('should return matching entry when messageModel exists in usage', () => {
      const usageByModel: Record<string, ModelUsageInfo> = {
        'claude-sonnet-4-5': { inputTokens: 100, contextWindow: 200000 },
        'claude-haiku-4-5': { inputTokens: 50, contextWindow: 200000 },
      };

      const result = selectModelUsage(usageByModel, 'claude-sonnet-4-5');

      expect(result).toEqual({
        modelName: 'claude-sonnet-4-5',
        usage: { inputTokens: 100, contextWindow: 200000 },
      });
    });

    it('should prioritize messageModel over intendedModel', () => {
      const usageByModel: Record<string, ModelUsageInfo> = {
        'claude-sonnet-4-5': { inputTokens: 100 },
        'claude-haiku-4-5': { inputTokens: 50 },
      };

      const result = selectModelUsage(usageByModel, 'claude-sonnet-4-5', 'claude-haiku-4-5');

      expect(result?.modelName).toBe('claude-sonnet-4-5');
    });

    it('should prioritize messageModel over higher token count', () => {
      const usageByModel: Record<string, ModelUsageInfo> = {
        'claude-sonnet-4-5': { inputTokens: 100 },
        'claude-haiku-4-5': { inputTokens: 10000 }, // Higher tokens
      };

      const result = selectModelUsage(usageByModel, 'claude-sonnet-4-5');

      expect(result?.modelName).toBe('claude-sonnet-4-5');
    });
  });

  describe('priority 2: intendedModel fallback', () => {
    it('should fall back to intendedModel when messageModel is undefined', () => {
      const usageByModel: Record<string, ModelUsageInfo> = {
        'claude-sonnet-4-5': { inputTokens: 100 },
        'claude-haiku-4-5': { inputTokens: 50 },
      };

      const result = selectModelUsage(usageByModel, undefined, 'claude-haiku-4-5');

      expect(result).toEqual({
        modelName: 'claude-haiku-4-5',
        usage: { inputTokens: 50 },
      });
    });

    it('should fall back to intendedModel when messageModel not in usage', () => {
      const usageByModel: Record<string, ModelUsageInfo> = {
        'claude-sonnet-4-5': { inputTokens: 100 },
        'claude-haiku-4-5': { inputTokens: 50 },
      };

      const result = selectModelUsage(usageByModel, 'non-existent-model', 'claude-haiku-4-5');

      expect(result).toEqual({
        modelName: 'claude-haiku-4-5',
        usage: { inputTokens: 50 },
      });
    });

    it('should prioritize intendedModel over higher token count', () => {
      const usageByModel: Record<string, ModelUsageInfo> = {
        'claude-sonnet-4-5': { inputTokens: 10000 }, // Higher tokens
        'claude-haiku-4-5': { inputTokens: 100 },
      };

      const result = selectModelUsage(usageByModel, undefined, 'claude-haiku-4-5');

      expect(result?.modelName).toBe('claude-haiku-4-5');
    });
  });

  describe('priority 3: highest contextTokens', () => {
    it('should select model with highest contextTokens when no matches', () => {
      const usageByModel: Record<string, ModelUsageInfo> = {
        'model-a': { inputTokens: 100 },
        'model-b': { inputTokens: 500 },
        'model-c': { inputTokens: 200 },
      };

      const result = selectModelUsage(usageByModel);

      expect(result?.modelName).toBe('model-b');
    });

    it('should calculate contextTokens as sum of input tokens', () => {
      const usageByModel: Record<string, ModelUsageInfo> = {
        'model-a': {
          inputTokens: 100,
          cacheCreationInputTokens: 200,
          cacheReadInputTokens: 300,
        },
        'model-b': {
          inputTokens: 500,
          // No cache tokens
        },
      };

      // model-a: 100 + 200 + 300 = 600
      // model-b: 500 + 0 + 0 = 500
      const result = selectModelUsage(usageByModel);

      expect(result?.modelName).toBe('model-a');
    });

    it('should handle models with only cacheCreationInputTokens', () => {
      const usageByModel: Record<string, ModelUsageInfo> = {
        'model-a': { cacheCreationInputTokens: 1000 },
        'model-b': { inputTokens: 500 },
      };

      const result = selectModelUsage(usageByModel);

      expect(result?.modelName).toBe('model-a');
    });

    it('should handle models with only cacheReadInputTokens', () => {
      const usageByModel: Record<string, ModelUsageInfo> = {
        'model-a': { cacheReadInputTokens: 1000 },
        'model-b': { inputTokens: 500 },
      };

      const result = selectModelUsage(usageByModel);

      expect(result?.modelName).toBe('model-a');
    });

    it('should handle undefined token values as 0', () => {
      const usageByModel: Record<string, ModelUsageInfo> = {
        'model-a': {}, // All undefined
        'model-b': { inputTokens: 100 },
      };

      const result = selectModelUsage(usageByModel);

      expect(result?.modelName).toBe('model-b');
    });

    it('should select first model when all have zero tokens', () => {
      const usageByModel: Record<string, ModelUsageInfo> = {
        'model-a': {},
        'model-b': {},
      };

      const result = selectModelUsage(usageByModel);

      // Returns first entry that exceeds maxTokens (-1)
      expect(result).not.toBeNull();
      expect(['model-a', 'model-b']).toContain(result?.modelName);
    });
  });

  describe('subagent model filtering', () => {
    it('should filter out subagent models using intendedModel', () => {
      // Scenario: Main model is claude-sonnet-4-5, but a subagent used claude-haiku-4-5
      const usageByModel: Record<string, ModelUsageInfo> = {
        'claude-sonnet-4-5': { inputTokens: 1000 },
        'claude-haiku-4-5': { inputTokens: 5000 }, // Subagent with more tokens
      };

      // By passing intendedModel, we ensure the main model is selected
      // even though the subagent has higher token usage
      const result = selectModelUsage(usageByModel, undefined, 'claude-sonnet-4-5');

      expect(result?.modelName).toBe('claude-sonnet-4-5');
    });
  });

  describe('edge cases', () => {
    it('should handle single entry', () => {
      const usageByModel: Record<string, ModelUsageInfo> = {
        'only-model': { inputTokens: 100 },
      };

      const result = selectModelUsage(usageByModel);

      expect(result).toEqual({
        modelName: 'only-model',
        usage: { inputTokens: 100 },
      });
    });

    it('should handle models with contextWindow property', () => {
      const usageByModel: Record<string, ModelUsageInfo> = {
        'model-a': { inputTokens: 100, contextWindow: 200000 },
        'model-b': { inputTokens: 200, contextWindow: 100000 },
      };

      // contextWindow is not used for selection, only token counts
      const result = selectModelUsage(usageByModel);

      expect(result?.modelName).toBe('model-b');
      expect(result?.usage.contextWindow).toBe(100000);
    });

    it('should return full usage object', () => {
      const usageByModel: Record<string, ModelUsageInfo> = {
        'claude-sonnet-4-5': {
          inputTokens: 100,
          cacheCreationInputTokens: 50,
          cacheReadInputTokens: 25,
          contextWindow: 200000,
        },
      };

      const result = selectModelUsage(usageByModel, 'claude-sonnet-4-5');

      expect(result?.usage).toEqual({
        inputTokens: 100,
        cacheCreationInputTokens: 50,
        cacheReadInputTokens: 25,
        contextWindow: 200000,
      });
    });
  });
});
