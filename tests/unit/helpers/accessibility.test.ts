/** @vitest-environment jsdom */

import { axe, configureAxe, toHaveNoViolations } from '@test/helpers/accessibility';
import axeCore from 'axe-core';

afterEach(() => {
  document.body.innerHTML = '';
  axeCore.reset();
  configureAxe();
});

describe('accessibility adapter', () => {
  it('rejects a known violation with its rule, help, selector and HTML', async () => {
    const results = await axe('<button id="save"></button>', { runOnly: ['button-name'] });
    expect(results.violations.map(violation => violation.id)).toEqual(['button-name']);
    expect(results).not.toHaveNoViolations();
    const verdict = toHaveNoViolations.toHaveNoViolations(results);
    expect(verdict.pass).toBe(false);
    expect(verdict.message()).toContain('button-name');
    expect(verdict.message()).toContain('Buttons must have discernible text');
    expect(verdict.message()).toContain('#save');
    expect(verdict.message()).toContain('<button id="save"></button>');
  });

  it('accepts a clean fragment through direct and asymmetric matchers', async () => {
    const results = await axe('<main><button>Save</button></main>');
    expect(results).toHaveNoViolations();
    expect({ results }).toEqual({ results: expect.toHaveNoViolations() });
  });

  it('mounts strings and detached elements and restores the original body HTML', async () => {
    document.body.innerHTML = '<main id="original">Existing content</main>';
    const original = document.body.innerHTML;
    const detached = document.createElement('button');
    detached.id = 'detached';
    for (const html of ['<button id="string"></button>', detached]) {
      const results = await axe(html, { runOnly: ['button-name'] });
      expect(results.violations.map(violation => violation.id)).toEqual(['button-name']);
      expect(document.body.innerHTML).toBe(original);
      expect(detached.isConnected).toBe(false);
    }
  });

  it('checks an attached element without replacing its document', async () => {
    document.body.innerHTML = '<main><button id="save">Save</button></main>';
    const button = document.getElementById('save')!;
    expect(await axe(button)).toHaveNoViolations();
    expect(document.getElementById('save')).toBe(button);
  });

  it('disables color rules by default while retaining region checks', async () => {
    const results = await axe('<p>Content outside a landmark</p>');
    expect(results.violations.map(violation => violation.id)).toContain('region');
    const checkedRules = [...results.passes, ...results.incomplete, ...results.inapplicable, ...results.violations]
      .map(result => result.id);
    expect(checkedRules).not.toContain('color-contrast');
    expect(checkedRules).not.toContain('color-contrast-enhanced');
  });

  it('honors global rule configuration and merges nested run options and arrays by index', async () => {
    const globalCheck = configureAxe({
      globalOptions: { rules: [{ id: 'region', enabled: false }] },
    });
    expect(await globalCheck('<p>Content outside a landmark</p>')).toHaveNoViolations();
    const check = configureAxe({
      runOnly: { type: 'rule', values: ['button-name', 'image-alt'] },
      rules: { 'image-alt': { enabled: false } },
    });
    const results = await check('<p>Outside</p><button></button><input><img src="test.png">', {
      runOnly: { type: 'rule', values: ['label'] },
      rules: { 'image-alt': { enabled: true } },
    });
    expect(results.violations.map(violation => violation.id).sort()).toEqual(['image-alt', 'label']);
  });

  it('filters matcher failures by impact without dropping violations from engine results', async () => {
    const check = configureAxe({ impactLevels: ['critical'], runOnly: ['region', 'image-alt'] });
    const results = await check('<p>Content outside a landmark</p><img src="test.png">');
    expect(results.violations.map(violation => violation.id).sort()).toEqual(['image-alt', 'region']);
    const verdict = toHaveNoViolations.toHaveNoViolations(results);
    expect(verdict.pass).toBe(false);
    expect(verdict.message()).toContain('image-alt');
    expect(verdict.message()).not.toContain('(region)');
    const minorOnly = configureAxe({ impactLevels: ['minor'], runOnly: ['button-name', 'image-alt'] });
    expect(await minorOnly('<button></button><img src="test.png">')).toHaveNoViolations();
    const allImpacts = configureAxe({ impactLevels: [], runOnly: ['button-name'] });
    expect(await allImpacts('<button></button>')).not.toHaveNoViolations();
  });
});
