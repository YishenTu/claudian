import { TITLE_GENERATION_SYSTEM_PROMPT } from '@/core/prompts/titleGeneration';

describe('titleGeneration', () => {
  it('exports a non-empty system prompt string', () => {
    expect(typeof TITLE_GENERATION_SYSTEM_PROMPT).toBe('string');
    expect(TITLE_GENERATION_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });

  it('includes the max character constraint', () => {
    expect(TITLE_GENERATION_SYSTEM_PROMPT).toContain('max 50 chars');
  });

  it('instructs to start with a strong verb', () => {
    expect(TITLE_GENERATION_SYSTEM_PROMPT).toContain('strong verb');
  });

  it('instructs to return only the raw title text', () => {
    expect(TITLE_GENERATION_SYSTEM_PROMPT).toContain('ONLY the raw title text');
  });
});
