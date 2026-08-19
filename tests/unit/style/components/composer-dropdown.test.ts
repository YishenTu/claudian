import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('Composer dropdown styles', () => {
  it('avoids backdrop-filter compositing when the filtered list shrinks', () => {
    const css = readFileSync(path.resolve('src/style/components/composer-dropdown.css'), 'utf8');
    const dropdownRule = css.match(/\.claudian-composer-dropdown\s*{([^}]*)}/)?.[1];

    expect(dropdownRule).toBeDefined();
    expect(dropdownRule).toContain('background: var(--background-secondary);');
    expect(dropdownRule).not.toContain('backdrop-filter');
  });
});
