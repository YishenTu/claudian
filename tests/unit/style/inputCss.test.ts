import { readFileSync } from 'fs';
import path from 'path';

const inputCss = readFileSync(
  path.resolve(__dirname, '../../../src/style/components/input.css'),
  'utf8',
);

function getRule(selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = inputCss.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? '';
}

describe('input composer CSS', () => {
  it('lets compact wrappers grow to fit context chips without fixed-height clipping', () => {
    expect(getRule('.claudian-input-wrapper')).not.toMatch(/^\s*height:/m);
    expect(inputCss).not.toMatch(
      /\.claudian-input-wrapper\.claudian-input-wrapper-manual-collapsed\s*\{[\s\S]*?height:/,
    );
  });

  it('defines composer-max bounds as CSS variables (shared with Tab.ts)', () => {
    const rule = getRule('.claudian-input-wrapper');
    expect(rule).toMatch(/--claudian-composer-max-floor-px:\s*260\b/);
    expect(rule).toMatch(/--claudian-composer-max-ceiling-px:\s*520\b/);
    expect(rule).toMatch(/--claudian-composer-max-vh-ratio:\s*0\.46\b/);
  });

  it('expands composer using the shared CSS variables', () => {
    const rule = getRule('.claudian-input-wrapper.claudian-input-wrapper-expanded');
    expect(rule).toMatch(/height:\s*clamp\(/);
    expect(rule).toMatch(/var\(--claudian-composer-max-floor-px\)/);
    expect(rule).toMatch(/var\(--claudian-composer-max-vh-ratio\)/);
    expect(rule).toMatch(/var\(--claudian-composer-max-ceiling-px\)/);
  });

  it('caps the chip context row in both compact and expanded modes', () => {
    // Bug guard: in expanded mode the wrapper is fixed-height with
    // overflow:hidden, so an uncapped chip row would squeeze out the textarea
    // when many images/files are attached.
    const rule = getRule('.claudian-context-row.has-content');
    expect(rule).toMatch(/max-height:\s*90px/);
    expect(rule).toMatch(/overflow-y:\s*auto/);
    expect(inputCss).not.toMatch(
      /:not\(\.claudian-input-wrapper-expanded\)\s+\.claudian-context-row\.has-content/,
    );
  });

  it('keeps compact textarea sized via CSS variables with internal scroll', () => {
    const rule = getRule('.claudian-input');
    expect(rule).toMatch(/flex:\s*1 1 0/);
    expect(rule).toMatch(/min-height:\s*var\(--claudian-textarea-min-height,\s*60px\)/);
    expect(rule).toMatch(/max-height:\s*var\(--claudian-textarea-max-height,\s*none\)/);
    expect(rule).toMatch(/overflow-y:\s*auto/);
  });
});
