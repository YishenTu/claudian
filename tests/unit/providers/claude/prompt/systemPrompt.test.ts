jest.mock('@/utils/date', () => ({
  getTodayDate: () => 'Mocked Date',
}));

import { getInlineEditSystemPrompt } from '@/core/prompt/inlineEdit';
import {
  buildSystemPrompt,
  computeSystemPromptKey,
} from '@/core/prompt/mainAgent';

describe('systemPrompt', () => {
  describe('buildSystemPrompt', () => {
    it('should produce identical output for the default and explicit Claudian profiles', () => {
      const settings = {
        mediaFolder: 'attachments',
        customPrompt: 'Always be concise.',
        vaultPath: '/vault',
        userName: 'Alice',
      };

      expect(buildSystemPrompt(settings)).toBe(
        buildSystemPrompt(settings, { toolGuidanceProfile: 'claudian' }),
      );
    });

    it('should retain provider-neutral context in the provider-native profile', () => {
      const prompt = buildSystemPrompt(
        {
          customPrompt: 'Use curl if the user explicitly asks for it.',
          vaultPath: '/vault',
          userName: 'Alice',
        },
        { toolGuidanceProfile: 'provider-native' },
      );

      expect(prompt).toContain('## User Context');
      expect(prompt).toContain('You are collaborating with **Alice**.');
      expect(prompt).toContain('## Identity & Role');
      expect(prompt).toContain('The current working directory is the user\'s vault root.');
      expect(prompt).toContain('Vault absolute path: /vault');
      expect(prompt).toContain('## Path Conventions');
      expect(prompt).toContain('## User Message Format');
      expect(prompt).toContain('## Obsidian Context');
      expect(prompt).toContain('## Selection Context');
      expect(prompt).toContain('## Custom Instructions');
      expect(prompt).toContain('Use curl if the user explicitly asks for it.');
    });

    it('should omit Claudian tool recipes from the provider-native profile', () => {
      const prompt = buildSystemPrompt(
        { mediaFolder: 'attachments' },
        { toolGuidanceProfile: 'provider-native' },
      );

      expect(prompt).not.toContain('Use `bash: date`');
      expect(prompt).not.toContain('## Embedded Images in Notes');
      expect(prompt).not.toContain('Read file_path=');
      expect(prompt).not.toContain('WebFetch does NOT support images');
      expect(prompt).not.toContain('curl -sfo');
      expect(prompt).not.toContain('```bash');
    });

    it('should append custom prompt section when provided', () => {
      const prompt = buildSystemPrompt({ customPrompt: 'Always be concise.' });
      expect(prompt).toContain('# Custom Instructions');
      expect(prompt).toContain('Always be concise.');
    });

    it('should not append custom prompt section when empty', () => {
      const prompt = buildSystemPrompt({ customPrompt: '   ' });
      expect(prompt).not.toContain('# Custom Instructions');
    });

    it('should not append custom prompt section when undefined', () => {
      const prompt = buildSystemPrompt({});
      expect(prompt).not.toContain('# Custom Instructions');
    });

    it('should include base system prompt elements', () => {
      const prompt = buildSystemPrompt();
      expect(prompt).toContain('Use `bash: date` to get the current date and time. Never guess or assume.');
      expect(prompt).toContain('Claudian');
      expect(prompt).toContain('## Path Conventions');
      expect(prompt).toContain('# User Message Format');
    });

    it('should omit Claude-specific tool guidance from the shared prompt', () => {
      const prompt = buildSystemPrompt();

      expect(prompt).not.toContain('## Tool Usage Guidelines');
      expect(prompt).not.toContain('### WebSearch');
      expect(prompt).not.toContain('### Agent (Subagents)');
      expect(prompt).not.toContain('### TodoWrite');
      expect(prompt).not.toContain('### Skills');
    });

  });

  describe('userName in system prompt', () => {
    it('should include user context when userName is provided', () => {
      const prompt = buildSystemPrompt({ userName: 'Alice' });
      expect(prompt).toContain('## User Context');
      expect(prompt).toContain('You are collaborating with **Alice**.');
    });

    it('should not include user context when userName is empty', () => {
      const prompt = buildSystemPrompt({ userName: '' });
      expect(prompt).not.toContain('## User Context');
    });

    it('should not include user context when userName is whitespace only', () => {
      const prompt = buildSystemPrompt({ userName: '   ' });
      expect(prompt).not.toContain('## User Context');
    });

    it('should not include user context when userName is undefined', () => {
      const prompt = buildSystemPrompt({});
      expect(prompt).not.toContain('## User Context');
    });

    it('should trim whitespace from userName', () => {
      const prompt = buildSystemPrompt({ userName: '  Bob  ' });
      expect(prompt).toContain('You are collaborating with **Bob**.');
      expect(prompt).not.toContain('**  Bob  **');
    });
  });

  describe('media folder instructions', () => {
    it('should use vault root path when mediaFolder is empty', () => {
      const prompt = buildSystemPrompt({ mediaFolder: '' });
      expect(prompt).toContain('Located in media folder: `.`');
      expect(prompt).toContain('Read file_path="image.jpg"');
    });

    it('should use vault root path when mediaFolder is whitespace only', () => {
      const prompt = buildSystemPrompt({ mediaFolder: '   ' });
      expect(prompt).toContain('Located in media folder: `.`');
    });

    it('should use custom mediaFolder path when provided', () => {
      const prompt = buildSystemPrompt({ mediaFolder: 'attachments' });
      expect(prompt).toContain('Located in media folder: `./attachments`');
      expect(prompt).toContain('Read file_path="attachments/image.jpg"');
    });

    it('should handle mediaFolder with special characters', () => {
      const prompt = buildSystemPrompt({ mediaFolder: '- attachments' });
      expect(prompt).toContain('Located in media folder: `./- attachments`');
      expect(prompt).toContain('Read file_path="- attachments/image.jpg"');
    });

    it('should include external image handling instructions', () => {
      const prompt = buildSystemPrompt({ mediaFolder: 'media' });
      expect(prompt).toContain('WebFetch does NOT support images');
      expect(prompt).toContain('Download to media folder');
      expect(prompt).toContain('curl');
      expect(prompt).toContain('replace the markdown link');
    });
  });

  describe('getInlineEditSystemPrompt', () => {
    it('should include inline edit critical output rules', () => {
      const prompt = getInlineEditSystemPrompt();
      expect(prompt).toContain('ABSOLUTE RULE');
      expect(prompt).toContain('<replacement>');
    });

    it('should include read-only tool descriptions', () => {
      const prompt = getInlineEditSystemPrompt();
      expect(prompt).toContain('Read, Grep, Glob, LS, WebSearch, WebFetch');
      expect(prompt).toContain('read-only');
    });

    it('should include example scenarios', () => {
      const prompt = getInlineEditSystemPrompt();
      expect(prompt).toContain('translate to French');
      expect(prompt).toContain('Bonjour le monde');
      expect(prompt).toContain('asking for clarification');
    });

    it('should include date from utils', () => {
      const prompt = getInlineEditSystemPrompt();
      expect(prompt).toContain('Mocked Date');
    });

  });

  describe('computeSystemPromptKey', () => {
    it('includes the tool guidance profile in the prompt key', () => {
      const settings = {
        mediaFolder: 'attachments',
        customPrompt: 'Be helpful',
        vaultPath: '/vault',
        userName: 'Alice',
      };

      const defaultKey = computeSystemPromptKey(settings);
      const claudianKey = computeSystemPromptKey(settings, {
        toolGuidanceProfile: 'claudian',
      });
      const providerNativeKey = computeSystemPromptKey(settings, {
        toolGuidanceProfile: 'provider-native',
      });

      expect(defaultKey).toBe(claudianKey);
      expect(providerNativeKey).not.toBe(claudianKey);
    });

    it('computes key from all settings', () => {
      const settings = {
        mediaFolder: 'attachments',
        customPrompt: 'Be helpful',
        vaultPath: '/vault',
        userName: 'Alice',
      };

      const key = computeSystemPromptKey(settings);

      expect(key).toBe('attachments::Be helpful::/vault::Alice');
    });

    it('handles empty or undefined values', () => {
      const key = computeSystemPromptKey({
        mediaFolder: '',
        customPrompt: '',
        vaultPath: '',
        userName: '',
      });

      expect(key).toBe('::::::');
    });
  });
});
