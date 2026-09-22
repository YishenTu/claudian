jest.mock('@/utils/date', () => ({
  getTodayDate: () => 'Mocked Date',
}));

import {
  buildInlineEditPrompt,
  getInlineEditSystemPrompt,
} from '@/core/prompt/inlineEdit';

describe('buildInlineEditPrompt', () => {
  it('serializes selection paths and bodies with canonical XML', () => {
    const prompt = buildInlineEditPrompt({
      instruction: 'Explain this',
      mode: 'selection',
      notePath: 'notes/"draft" & plan.md',
      selectedText: 'if (a < b && marker === "]]>") {\n</editor_selection>\n}',
      startLine: 2,
      lineCount: 3,
    });

    expect(prompt).toBe(
      'Explain this\n\n<editor_selection path="notes/&quot;draft&quot; &amp; plan.md" lines="2-4">\n<![CDATA[if (a < b && marker === "]]]]><![CDATA[>") {\n</editor_selection>\n}]]>\n</editor_selection>',
    );
  });

  it('preserves inline-edit cursor line metadata', () => {
    const prompt = buildInlineEditPrompt({
      instruction: 'Continue',
      mode: 'cursor',
      notePath: 'notes/"draft".md',
      cursorContext: {
        beforeCursor: 'left < right',
        afterCursor: ' && done',
        isInbetween: false,
        line: 4,
        column: 5,
      },
    });

    expect(prompt).toBe(
      'Continue\n\n<editor_cursor path="notes/&quot;draft&quot;.md" line="5">\n<![CDATA[left < right| && done #inline]]>\n</editor_cursor>',
    );
  });
});

describe('getInlineEditSystemPrompt', () => {
  it('injects the current date and Vault absolute path into runtime context', () => {
    const prompt = getInlineEditSystemPrompt('/vault');

    expect(prompt).toContain('## Runtime Context');
    expect(prompt).toContain('Current date: Mocked Date.');
    expect(prompt).toContain('Vault absolute path: /vault');
    expect(prompt).toContain('current working directory is the Vault root');
  });

  it('uses provider-neutral read-only tool guidance with one path-resolution rule', () => {
    const prompt = getInlineEditSystemPrompt('/vault');

    expect(prompt).toContain('available read-only tools');
    expect(prompt).toContain(
      'Resolve Vault-relative context paths against the Vault absolute path before using read-only tools; use already-absolute paths directly.',
    );
    expect(prompt).not.toContain('## Path Conventions');
    expect(prompt).not.toContain('Read, Grep, Glob, LS, WebSearch, WebFetch');
    expect(prompt).not.toContain('Must be RELATIVE');
  });

  it('keeps the editing protocol while removing redundant process instructions', () => {
    const prompt = getInlineEditSystemPrompt('/vault');

    expect(prompt).toContain('<replacement>replacement text</replacement>');
    expect(prompt).toContain('<insertion>inserted text</insertion>');
    expect(prompt).toContain('respond with plain text');
    expect(prompt).toContain('ask one concise, specific question');
    expect(prompt).toContain('Inspect additional content only when needed');
    expect(prompt).not.toContain('## Thinking Process');
    expect(prompt).not.toContain('ABSOLUTE RULE');
    expect(prompt).not.toContain('Always Read the full file');
    expect(prompt).not.toContain('translate to French');
  });

  it('orders runtime, input, editing, and output sections', () => {
    const prompt = getInlineEditSystemPrompt('/vault');

    expect(prompt.indexOf('## Runtime Context')).toBeLessThan(
      prompt.indexOf('## Input Context'),
    );
    expect(prompt.indexOf('## Input Context')).toBeLessThan(
      prompt.indexOf('## Editing Principles'),
    );
    expect(prompt.indexOf('## Editing Principles')).toBeLessThan(
      prompt.indexOf('## Output Contract'),
    );
  });
});
