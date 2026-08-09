import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('Persistent sidebar surface pager styles', () => {
  it('keeps the sidebar surface switcher visible at the top', () => {
    const css = readFileSync(path.resolve('src/style/components/history.css'), 'utf8');

    expect(css).toMatch(
      /\.claudian-session-sidebar\s*{[^}]*--claudian-sidebar-surface-footer-height:\s*40px;/,
    );
    expect(css).toMatch(
      /\.claudian-sidebar-surface-switcher\s*{[^}]*position:\s*relative;[^}]*flex:\s*0 0 auto;[^}]*background:\s*var\(--background-primary\);/,
    );
  });
});
