import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('Persistent sidebar surface pager styles', () => {
  it('keeps the session surface bounded so its nested lists can scroll', () => {
    const css = readFileSync(path.resolve('src/style/components/history.css'), 'utf8');

    expect(css).toMatch(
      /\.claudian-session-surface(?:,\s*\.claudian-collab-surface)?\s*{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/,
    );
  });

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

describe('Single-pane history action styles', () => {
  it('keeps row actions borderless and transparent while using color for interaction', () => {
    const css = readFileSync(path.resolve('src/style/components/history.css'), 'utf8');

    expect(css).toMatch(
      /\.claudian-history-menu \.claudian-history-item-actions \.claudian-action-btn\s*{[^}]*background:\s*transparent;[^}]*border:\s*none;[^}]*box-shadow:\s*none;[^}]*color:\s*var\(--text-muted\);/,
    );
    expect(css).toMatch(
      /\.claudian-history-menu \.claudian-history-item-actions \.claudian-action-btn:hover,[\s\S]*?\.claudian-history-menu \.claudian-history-item-actions \.claudian-action-btn:focus-visible\s*{[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;[^}]*color:\s*var\(--text-normal\);/,
    );
  });
});
