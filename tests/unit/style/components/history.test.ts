import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('Persistent sidebar surface pager styles', () => {
  it('keeps the sidebar footer visible without overlaying or clipping content', () => {
    const css = readFileSync(path.resolve('src/style/components/history.css'), 'utf8');

    expect(css).toMatch(
      /\.claudian-sidebar-surface-switcher\s*{[^}]*flex:\s*0 0 28px;/,
    );
    expect(css).toMatch(
      /\.claudian-session-sidebar \.claudian-sidebar-surface-button::before\s*{[^}]*width:\s*6px;[^}]*height:\s*6px;/,
    );
    expect(css).not.toMatch(
      /\.claudian-sidebar-surface-switcher\s*{[^}]*(?:position:\s*absolute|opacity:\s*0);/,
    );
    expect(css).not.toMatch(
      /\.claudian-session-sidebar:has\([^}]*clip-path:/,
    );
  });
});
