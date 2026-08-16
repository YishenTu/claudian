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
      /\.claudian-tab-badge-action-required \{[\s\S]*?border-color: var\(--text-error\);[\s\S]*?\}/,
    );
  });
});
