import * as fs from 'node:fs';
import * as path from 'node:path';

const variablesCss = fs.readFileSync(
  path.resolve(__dirname, '../../../../../src/style/base/variables.css'),
  'utf8',
);
const tabsCss = fs.readFileSync(
  path.resolve(__dirname, '../../../../../src/style/components/tabs.css'),
  'utf8',
);
const modelSelectorCss = fs.readFileSync(
  path.resolve(__dirname, '../../../../../src/style/toolbar/model-selector.css'),
  'utf8',
);

describe('Qoder brand colors', () => {
  it('uses the provider-native dark and light theme accents', () => {
    expect(variablesCss).toContain('--claudian-brand-qoder: #27BD51;');
    expect(variablesCss).toContain('--claudian-brand-qoder-rgb: 39, 189, 81;');
    expect(variablesCss).toMatch(
      /body\.theme-light \.claudian-container \{[\s\S]*?--claudian-brand-qoder: #35CC5F;[\s\S]*?--claudian-brand-qoder-rgb: 53, 204, 95;[\s\S]*?\}/,
    );
  });

  it('routes active and streaming Qoder surfaces through the Qoder accent', () => {
    expect(variablesCss).toMatch(
      /\.claudian-container\[data-provider="qoder"\] \{[\s\S]*?--claudian-brand: var\(--claudian-brand-qoder\);[\s\S]*?--claudian-brand-rgb: var\(--claudian-brand-qoder-rgb\);[\s\S]*?\}/,
    );
    expect(tabsCss).toMatch(
      /\.claudian-tab-badge-streaming\[data-provider="qoder"\] \{[\s\S]*?border-color: var\(--claudian-brand-qoder, #27BD51\);[\s\S]*?\}/,
    );
  });

  it('renders composite provider icons in muted text color when unselected', () => {
    expect(modelSelectorCss).toMatch(
      /\.claudian-model-option:not\(\.selected\) \.claudian-model-provider-icon \* \{[\s\S]*?fill: currentColor;[\s\S]*?\}/,
    );
  });
});
