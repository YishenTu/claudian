import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('Ask user question styles', () => {
  it('keeps long approval descriptions inside a bounded scroll area', () => {
    const css = readFileSync(path.resolve('src/style/features/ask-user-question.css'), 'utf8');
    const descriptionRule = css.match(/\.claudian-ask-approval-desc\s*{([^}]*)}/)?.[1];
    const focusRule = css.match(
      /\.claudian-ask-approval-desc:focus-visible\s*{([^}]*)}/,
    )?.[1];

    expect(descriptionRule).toBeDefined();
    expect(descriptionRule).toContain('max-height: min(30vh, 240px);');
    expect(descriptionRule).toContain('overflow-y: auto;');
    expect(descriptionRule).toContain('overscroll-behavior: contain;');
    expect(focusRule).toContain('outline: 2px solid var(--interactive-accent);');
    expect(focusRule).toContain('outline-offset: -2px;');
  });
});
