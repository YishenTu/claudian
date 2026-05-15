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

  it('keeps expanded composer height fixed', () => {
    expect(getRule('.claudian-input-wrapper.claudian-input-wrapper-expanded'))
      .toMatch(/height:\s*clamp\(260px,\s*46vh,\s*520px\)/);
  });

  it('keeps manual-collapsed textarea bounded at compact height with scroll', () => {
    const rule = getRule(
      '.claudian-input-wrapper.claudian-input-wrapper-manual-collapsed .claudian-input',
    );
    expect(rule).toMatch(/max-height:\s*var\(--claudian-textarea-max-height,\s*96px\)/);
    expect(rule).toMatch(/min-height:\s*var\(--claudian-textarea-min-height,\s*60px\)/);
    expect(rule).toMatch(/overflow-y:\s*auto/);
  });
});
