import {
  buildSystemPrompt,
  computeSystemPromptKey,
  type SystemPromptSettings,
} from '@/core/prompt/mainAgent';

describe('mainAgent system prompt', () => {
  const baseSettings: SystemPromptSettings = {
    mediaFolder: 'attachments',
    customPrompt: '',
    vaultPath: '/test/vault',
    userName: 'TestUser',
  };

  describe('buildSystemPrompt with memoryAppendix', () => {
    it('includes memory appendix before custom instructions', () => {
      const memoryAppendix = '## Long-term Memory\n\n### User Preferences\n- Prefers dark mode';
      const settings: SystemPromptSettings = {
        ...baseSettings,
        customPrompt: 'Be concise.',
      };

      const prompt = buildSystemPrompt(settings, { memoryAppendix });

      const memoryIndex = prompt.indexOf('## Long-term Memory');
      const customIndex = prompt.indexOf('## Custom Instructions');

      expect(memoryIndex).toBeGreaterThan(-1);
      expect(customIndex).toBeGreaterThan(-1);
      expect(memoryIndex).toBeLessThan(customIndex);
      expect(prompt).toContain('- Prefers dark mode');
    });

    it('does not include memory section when appendix is empty', () => {
      const prompt = buildSystemPrompt(baseSettings, { memoryAppendix: '' });
      expect(prompt).not.toContain('## Long-term Memory');
    });

    it('does not include memory section when appendix is undefined', () => {
      const prompt = buildSystemPrompt(baseSettings, {});
      expect(prompt).not.toContain('## Long-term Memory');
    });

    it('includes memory appendix even without custom instructions', () => {
      const memoryAppendix = '## Long-term Memory\n\n- Test memory';
      const prompt = buildSystemPrompt(baseSettings, { memoryAppendix });
      expect(prompt).toContain('## Long-term Memory');
      expect(prompt).toContain('- Test memory');
    });
  });

  describe('computeSystemPromptKey with memoryAppendix', () => {
    it('produces different keys when memory appendix changes', () => {
      const key1 = computeSystemPromptKey(baseSettings, {
        memoryAppendix: '## Long-term Memory\n\n- Memory A',
      });
      const key2 = computeSystemPromptKey(baseSettings, {
        memoryAppendix: '## Long-term Memory\n\n- Memory B',
      });

      expect(key1).not.toBe(key2);
    });

    it('produces same key when memory appendix is the same', () => {
      const appendix = '## Long-term Memory\n\n- Same memory';
      const key1 = computeSystemPromptKey(baseSettings, { memoryAppendix: appendix });
      const key2 = computeSystemPromptKey(baseSettings, { memoryAppendix: appendix });

      expect(key1).toBe(key2);
    });

    it('produces different key with vs without memory appendix', () => {
      const keyWithMemory = computeSystemPromptKey(baseSettings, {
        memoryAppendix: '## Long-term Memory\n\n- Test',
      });
      const keyWithoutMemory = computeSystemPromptKey(baseSettings, {});

      expect(keyWithMemory).not.toBe(keyWithoutMemory);
    });

    it('ignores empty memory appendix in key computation', () => {
      const keyEmpty = computeSystemPromptKey(baseSettings, { memoryAppendix: '' });
      const keyNone = computeSystemPromptKey(baseSettings, {});

      expect(keyEmpty).toBe(keyNone);
    });
  });
});
