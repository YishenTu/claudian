/** @jest-environment jsdom */

import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('Composer info row styles', () => {
  it('suppresses Obsidian hover tooltips on the linked content chip', () => {
    const style = document.createElement('style');
    style.textContent = readFileSync(path.resolve('src/style/components/composer-info-row.css'), 'utf8');
    document.head.appendChild(style);
    // Obsidian skips aria-label tooltips when the hovered element computes --no-tooltip to "true";
    // jsdom does not compute custom properties, so check the inherited declaration on the chip root.
    const declared = Array.from(style.sheet!.cssRules)
      .filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule)
      .filter(rule => rule.selectorText === '.claudian-input-info-linked')
      .map(rule => rule.style.getPropertyValue('--no-tooltip').trim())
      .filter(Boolean);
    expect(declared).toEqual(['true']);
  });
});
