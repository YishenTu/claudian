import * as fs from 'node:fs';
import * as path from 'node:path';

describe('tab attention styles', () => {
  const tabsCss = fs.readFileSync(
    path.join(process.cwd(), 'src/style/components/tabs.css'),
    'utf8',
  );

  it('visually distinguishes review from action-required attention', () => {
    expect(tabsCss).toMatch(
      /\.claudian-tab-badge-review \{[\s\S]*?border-color: var\(--color-green\);[\s\S]*?\}/,
    );
    expect(tabsCss).toMatch(
      /\.claudian-tab-badge-review-error \{[\s\S]*?border-color: var\(--text-error\);[\s\S]*?\}/,
    );
    expect(tabsCss).toMatch(
      /\.claudian-tab-badge-action-required \{[\s\S]*?border-color: var\(--color-orange\);[\s\S]*?\}/,
    );
  });

  it('uses theme-neutral working borders without provider overrides', () => {
    expect(tabsCss).toMatch(
      /\.claudian-tab-badge-streaming \{[\s\S]*?border-color: var\(--text-normal\);[\s\S]*?\}/,
    );
    expect(tabsCss).toMatch(
      /body\.theme-light \.claudian-tab-badge-streaming \{[\s\S]*?border-color: #000000;[\s\S]*?\}/,
    );
    expect(tabsCss).toMatch(
      /body\.theme-dark \.claudian-tab-badge-streaming \{[\s\S]*?border-color: #ffffff;[\s\S]*?\}/,
    );
    expect(tabsCss).not.toMatch(
      /\.claudian-tab-badge-streaming\[data-provider=/,
    );
  });
});
