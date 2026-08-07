import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('Persistent sidebar surface pager styles', () => {
  it('reveals the native sidebar background by clipping content under the footer', () => {
    const css = readFileSync(path.resolve('src/style/components/history.css'), 'utf8');

    expect(css).toMatch(
      /\.claudian-session-sidebar\s*{[^}]*--claudian-sidebar-surface-footer-height:\s*40px;/,
    );
    expect(css).toMatch(
      /\.claudian-sidebar-surface-switcher\s*{[^}]*height:\s*var\(--claudian-sidebar-surface-footer-height\);[^}]*background:\s*transparent;/,
    );
    expect(css).toMatch(
      /\.claudian-session-sidebar:has\(> \.claudian-sidebar-surface-switcher:(?:hover|focus-within)\)[^{]*> \.claudian-(?:session|files)-surface[^{]*{[^}]*clip-path:\s*inset\(0 0 var\(--claudian-sidebar-surface-footer-height\) 0\);/,
    );
  });
});
