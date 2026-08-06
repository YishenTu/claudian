import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('Claudian view container styles', () => {
  it('preserves Obsidian host spacing outside the left sidebar', () => {
    const css = readFileSync(path.resolve('src/style/base/container.css'), 'utf8');

    expect(css).not.toMatch(
      /\.workspace-leaf-content \.view-content\.claudian-container\s*{[^}]*padding:/,
    );
  });

  it('compensates for left-only footer spacing without an ancestor query', () => {
    const css = readFileSync(path.resolve('src/style/base/container.css'), 'utf8');

    expect(css).not.toContain(':has(');
    expect(css).toMatch(
      /\.workspace-split\.mod-left-split \.view-content\.claudian-container\s*{[^}]*padding-bottom:\s*0;[^}]*overflow:\s*hidden;/,
    );
  });
});
