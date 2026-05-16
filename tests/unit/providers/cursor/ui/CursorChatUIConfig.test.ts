import {
  CURSOR_GPT5_MODEL,
  CURSOR_SONNET_MODEL,
  DEFAULT_CURSOR_PRIMARY_MODEL,
} from '@/providers/cursor/types/models';
import { cursorChatUIConfig } from '@/providers/cursor/ui/CursorChatUIConfig';

describe('CursorChatUIConfig', () => {
  describe('getModelOptions', () => {
    it('returns the built-in model list when no env or settings overrides exist', () => {
      const options = cursorChatUIConfig.getModelOptions({});
      const values = options.map(option => option.value);
      expect(values).toContain(DEFAULT_CURSOR_PRIMARY_MODEL);
      expect(values).toContain(CURSOR_GPT5_MODEL);
      expect(values).toContain(CURSOR_SONNET_MODEL);
    });

    it('appends settings-defined custom models after the built-in list', () => {
      const options = cursorChatUIConfig.getModelOptions({
        providerConfigs: {
          cursor: {
            customModels: 'my-custom-model\nmy-custom-model\nclaude-haiku',
          },
        },
      });
      const values = options.map(option => option.value);
      expect(values.slice(-2)).toEqual(['my-custom-model', 'claude-haiku']);
    });

    it('prepends a custom model from CURSOR_MODEL env when not built-in', () => {
      const options = cursorChatUIConfig.getModelOptions({
        environmentVariables: 'CURSOR_MODEL=my-private-model',
      });
      expect(options[0].value).toBe('my-private-model');
      expect(options[0].description).toBe('Custom (env)');
    });

    it('does not duplicate when CURSOR_MODEL matches a built-in model', () => {
      const before = cursorChatUIConfig.getModelOptions({}).length;
      const options = cursorChatUIConfig.getModelOptions({
        environmentVariables: `CURSOR_MODEL=${CURSOR_GPT5_MODEL}`,
      });
      expect(options.length).toBe(before);
    });
  });

  describe('ownsModel', () => {
    it('owns built-in cursor models', () => {
      expect(cursorChatUIConfig.ownsModel(DEFAULT_CURSOR_PRIMARY_MODEL, {})).toBe(true);
      expect(cursorChatUIConfig.ownsModel(CURSOR_GPT5_MODEL, {})).toBe(true);
    });

    it('owns composer-prefixed and auto models even when not in defaults', () => {
      expect(cursorChatUIConfig.ownsModel('composer-2-fast', {})).toBe(true);
      expect(cursorChatUIConfig.ownsModel('auto', {})).toBe(true);
    });

    it('owns custom models registered via settings', () => {
      const settings = {
        providerConfigs: { cursor: { customModels: 'my-private-model' } },
      };
      expect(cursorChatUIConfig.ownsModel('my-private-model', settings)).toBe(true);
    });

    it('does not own unrelated models', () => {
      expect(cursorChatUIConfig.ownsModel('gpt-5.5', {})).toBe(false);
      expect(cursorChatUIConfig.ownsModel('haiku', {})).toBe(false);
    });
  });

  describe('reasoning controls', () => {
    it('reports no adaptive reasoning', () => {
      expect(cursorChatUIConfig.isAdaptiveReasoningModel(DEFAULT_CURSOR_PRIMARY_MODEL, {})).toBe(false);
    });

    it('returns no reasoning options', () => {
      expect(cursorChatUIConfig.getReasoningOptions(DEFAULT_CURSOR_PRIMARY_MODEL, {})).toEqual([]);
    });
  });

  describe('getContextWindowSize', () => {
    it('returns a sensible default context window', () => {
      expect(cursorChatUIConfig.getContextWindowSize(DEFAULT_CURSOR_PRIMARY_MODEL)).toBe(200_000);
    });
  });

  describe('isDefaultModel', () => {
    it('returns true for built-in models', () => {
      expect(cursorChatUIConfig.isDefaultModel(DEFAULT_CURSOR_PRIMARY_MODEL)).toBe(true);
      expect(cursorChatUIConfig.isDefaultModel(CURSOR_GPT5_MODEL)).toBe(true);
    });

    it('returns false for custom models', () => {
      expect(cursorChatUIConfig.isDefaultModel('my-private-model')).toBe(false);
    });
  });

  describe('normalizeModelVariant', () => {
    it('falls back unknown models to the primary cursor model', () => {
      expect(cursorChatUIConfig.normalizeModelVariant('not-a-cursor-model', {})).toBe(DEFAULT_CURSOR_PRIMARY_MODEL);
    });

    it('keeps recognized models as-is', () => {
      expect(cursorChatUIConfig.normalizeModelVariant(CURSOR_GPT5_MODEL, {})).toBe(CURSOR_GPT5_MODEL);
    });
  });

  describe('getCustomModelIds', () => {
    it('returns custom model from env', () => {
      const ids = cursorChatUIConfig.getCustomModelIds({ CURSOR_MODEL: 'my-private-model' });
      expect(ids.has('my-private-model')).toBe(true);
    });

    it('does not include built-in models', () => {
      const ids = cursorChatUIConfig.getCustomModelIds({ CURSOR_MODEL: CURSOR_GPT5_MODEL });
      expect(ids.size).toBe(0);
    });

    it('returns empty set when no CURSOR_MODEL', () => {
      expect(cursorChatUIConfig.getCustomModelIds({}).size).toBe(0);
    });
  });
});
