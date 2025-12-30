jest.mock('@/utils/date', () => ({
  getTodayDate: () => 'Mocked Date',
}));

import { getInlineEditSystemPrompt } from '@/core/prompts/inlineEdit';
import { buildSystemPrompt } from '@/core/prompts/mainAgent';

describe('systemPrompt', () => {
  describe('buildSystemPrompt', () => {
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
      expect(prompt).toContain('Mocked Date');
      expect(prompt).toContain('Claudian');
      expect(prompt).toContain('# Critical Path Rules');
      expect(prompt).toContain('# User Message Format');
    });

    it('should include allowed export paths instructions when configured', () => {
      const prompt = buildSystemPrompt({ allowedExportPaths: ['~/Desktop', '/tmp'] });
      expect(prompt).toContain('# Allowed Export Paths');
      expect(prompt).toContain('- ~/Desktop');
      expect(prompt).toContain('- /tmp');
      expect(prompt).toContain('write-only');
    });

    it('should include plan mode instructions when planMode is true', () => {
      const prompt = buildSystemPrompt({ planMode: true });
      expect(prompt).toContain('### Plan Mode');
      expect(prompt).toContain('read-only exploration phase');
      expect(prompt).toContain('EnterPlanMode');
      expect(prompt).toContain('ExitPlanMode');
      expect(prompt).toContain('Disabled tools:');
    });

    it('should not include plan mode instructions when planMode is false', () => {
      const prompt = buildSystemPrompt({ planMode: false });
      expect(prompt).not.toContain('### Plan Mode');
    });

    it('should not include plan mode instructions by default', () => {
      const prompt = buildSystemPrompt({});
      expect(prompt).not.toContain('### Plan Mode');
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
      expect(prompt).toContain('Read:');
      expect(prompt).toContain('Grep:');
      expect(prompt).toContain('Glob:');
      expect(prompt).toContain('LS:');
      expect(prompt).toContain('WebSearch:');
      expect(prompt).toContain('WebFetch:');
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
});
