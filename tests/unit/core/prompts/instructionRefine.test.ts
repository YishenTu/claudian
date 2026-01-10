import { buildRefineSystemPrompt } from '@/core/prompts/instructionRefine';

describe('buildRefineSystemPrompt', () => {
  describe('without existing instructions', () => {
    it('should return base prompt when existing instructions is empty', () => {
      const result = buildRefineSystemPrompt('');

      expect(result).toContain('You are an expert Prompt Engineer');
      expect(result).toContain('**Your Goal**');
      expect(result).toContain('**Process**');
      expect(result).toContain('**Guidelines**');
      expect(result).toContain('**Output Format**');
      expect(result).toContain('**Examples**');
    });

    it('should not include existing instructions section when empty', () => {
      const result = buildRefineSystemPrompt('');

      expect(result).not.toContain('EXISTING INSTRUCTIONS');
      expect(result).not.toContain('already in the user\'s system prompt');
    });

    it('should not include existing instructions section for whitespace-only input', () => {
      const result = buildRefineSystemPrompt('   \n\t  ');

      expect(result).not.toContain('EXISTING INSTRUCTIONS');
    });
  });

  describe('with existing instructions', () => {
    it('should include existing instructions section', () => {
      const existingInstructions = '- Use TypeScript for all code';

      const result = buildRefineSystemPrompt(existingInstructions);

      expect(result).toContain('EXISTING INSTRUCTIONS');
      expect(result).toContain('already in the user\'s system prompt');
      expect(result).toContain('- Use TypeScript for all code');
    });

    it('should wrap existing instructions in code block', () => {
      const existingInstructions = '- Rule 1\n- Rule 2';

      const result = buildRefineSystemPrompt(existingInstructions);

      expect(result).toContain('```\n- Rule 1\n- Rule 2\n```');
    });

    it('should include conflict avoidance guidance', () => {
      const existingInstructions = '- Some rule';

      const result = buildRefineSystemPrompt(existingInstructions);

      expect(result).toContain('Consider how it fits with existing instructions');
      expect(result).toContain('Avoid duplicating existing instructions');
      expect(result).toContain('conflicts with an existing one');
      expect(result).toContain('Match the format of existing instructions');
    });

    it('should trim whitespace from existing instructions', () => {
      const existingInstructions = '  \n  - Trimmed rule  \n  ';

      const result = buildRefineSystemPrompt(existingInstructions);

      expect(result).toContain('```\n- Trimmed rule\n```');
    });
  });

  describe('prompt structure', () => {
    it('should contain process steps for analyzing intent', () => {
      const result = buildRefineSystemPrompt('');

      expect(result).toContain('**Analyze Intent**');
      expect(result).toContain('**Check Context**');
      expect(result).toContain('**Refine**');
      expect(result).toContain('**Format**');
    });

    it('should include conflict handling guidance', () => {
      const result = buildRefineSystemPrompt('');

      expect(result).toContain('*No Conflict*');
      expect(result).toContain('*Conflict*');
      expect(result).toContain('merged instruction');
    });

    it('should specify output format with instruction tags', () => {
      const result = buildRefineSystemPrompt('');

      expect(result).toContain('<instruction>');
      expect(result).toContain('</instruction>');
      expect(result).toContain('**Success**');
      expect(result).toContain('**Ambiguity**');
    });

    it('should include examples', () => {
      const result = buildRefineSystemPrompt('');

      expect(result).toContain('Input: "typescript for code"');
      expect(result).toContain('Input: "be concise"');
      expect(result).toContain('Input: "organize coding style rules"');
      expect(result).toContain('Input: "use that thing from before"');
    });

    it('should show example outputs with proper tag wrapping', () => {
      const result = buildRefineSystemPrompt('');

      expect(result).toContain('Output: <instruction>');
      expect(result).toContain('**Code Language**');
      expect(result).toContain('**Conciseness**');
      expect(result).toContain('## Coding Standards');
    });

    it('should include ambiguity handling example', () => {
      const result = buildRefineSystemPrompt('');

      expect(result).toContain('I\'m not sure what you\'re referring to');
      expect(result).toContain('Could you please clarify');
    });
  });

  describe('guidelines', () => {
    it('should specify clarity guideline', () => {
      const result = buildRefineSystemPrompt('');

      expect(result).toContain('**Clarity**');
      expect(result).toContain('Use precise language');
    });

    it('should specify scope guideline', () => {
      const result = buildRefineSystemPrompt('');

      expect(result).toContain('**Scope**');
      expect(result).toContain('Keep it focused');
    });

    it('should specify format guideline', () => {
      const result = buildRefineSystemPrompt('');

      expect(result).toContain('**Format**');
      expect(result).toContain('Valid Markdown');
    });

    it('should specify no header guideline', () => {
      const result = buildRefineSystemPrompt('');

      expect(result).toContain('**No Header**');
      expect(result).toContain('# Custom Instructions');
    });

    it('should specify conflict handling guideline', () => {
      const result = buildRefineSystemPrompt('');

      expect(result).toContain('**Conflict Handling**');
      expect(result).toContain('directly contradicts');
    });
  });

  describe('multiline existing instructions', () => {
    it('should handle multi-line existing instructions', () => {
      const existingInstructions = `## Code Style
- Use TypeScript
- Prefer functional patterns

## Documentation
- Add JSDoc comments
- Include examples`;

      const result = buildRefineSystemPrompt(existingInstructions);

      expect(result).toContain('## Code Style');
      expect(result).toContain('## Documentation');
      expect(result).toContain('- Use TypeScript');
      expect(result).toContain('- Add JSDoc comments');
    });

    it('should preserve formatting within existing instructions', () => {
      const existingInstructions = '- Item 1\n  - Nested item\n- Item 2';

      const result = buildRefineSystemPrompt(existingInstructions);

      expect(result).toContain('- Item 1\n  - Nested item\n- Item 2');
    });
  });
});
