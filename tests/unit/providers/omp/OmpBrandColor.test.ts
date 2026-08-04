import * as fs from 'node:fs';
import * as path from 'node:path';

describe('OMP brand color', () => {
  const variablesCss = fs.readFileSync(
    path.join(process.cwd(), 'src/style/base/variables.css'),
    'utf8',
  );
  const tabsCss = fs.readFileSync(
    path.join(process.cwd(), 'src/style/components/tabs.css'),
    'utf8',
  );

  it('uses OMP cyan instead of the Claude brand token', () => {
    expect(variablesCss).toContain('--claudian-brand-omp: #00B8D9;');
    expect(variablesCss).toContain('--claudian-brand-omp-rgb: 0, 184, 217;');
  });

  it('routes active and streaming OMP surfaces through its brand token', () => {
    expect(variablesCss).toMatch(
      /\.claudian-container\[data-provider="omp"\] \{[\s\S]*?--claudian-brand: var\(--claudian-brand-omp\);[\s\S]*?--claudian-brand-rgb: var\(--claudian-brand-omp-rgb\);[\s\S]*?\}/,
    );
    expect(tabsCss).toMatch(
      /\.claudian-tab-badge-streaming\[data-provider="omp"\] \{[\s\S]*?border-color: var\(--claudian-brand-omp, #00B8D9\);[\s\S]*?\}/,
    );
  });
});
