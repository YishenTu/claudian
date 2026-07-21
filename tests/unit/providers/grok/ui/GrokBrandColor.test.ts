import * as fs from 'node:fs';
import * as path from 'node:path';

describe('Grok brand color', () => {
  const variablesCss = fs.readFileSync(
    path.join(process.cwd(), 'src/style/base/variables.css'),
    'utf8',
  );
  const tabsCss = fs.readFileSync(
    path.join(process.cwd(), 'src/style/components/tabs.css'),
    'utf8',
  );

  it('uses white in dark mode and black in light mode', () => {
    expect(variablesCss).toContain('--claudian-brand-grok: #ffffff;');
    expect(variablesCss).toContain('--claudian-brand-grok-rgb: 255, 255, 255;');
    expect(variablesCss).toMatch(
      /body\.theme-light \.claudian-container \{[\s\S]*?--claudian-brand-grok: #000000;[\s\S]*?--claudian-brand-grok-rgb: 0, 0, 0;[\s\S]*?\}/,
    );
  });

  it('routes active and streaming Grok surfaces through its brand token', () => {
    expect(variablesCss).toMatch(
      /\.claudian-container\[data-provider="grok"\] \{[\s\S]*?--claudian-brand: var\(--claudian-brand-grok\);[\s\S]*?--claudian-brand-rgb: var\(--claudian-brand-grok-rgb\);[\s\S]*?\}/,
    );
    expect(tabsCss).toMatch(
      /\.claudian-tab-badge-streaming\[data-provider="grok"\] \{[\s\S]*?border-color: var\(--claudian-brand-grok, #ffffff\);[\s\S]*?\}/,
    );
  });
});
