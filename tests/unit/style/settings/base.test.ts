/** @jest-environment jsdom */

import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('Settings styles', () => {
  it('suppresses Obsidian hover tooltips on the settings page and its modals', () => {
    const style = document.createElement('style');
    style.textContent = readFileSync(path.resolve('src/style/settings/base.css'), 'utf8');
    document.head.appendChild(style);
    // Obsidian skips aria-label tooltips when the hovered element computes --no-tooltip to "true";
    // the custom property inherits, and jsdom does not compute it, so check the declaration on the rule.
    const suppressed = Array.from(style.sheet!.cssRules)
      .filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule)
      .filter(rule => rule.style.getPropertyValue('--no-tooltip').trim() === 'true')
      .flatMap(rule => rule.selectorText.split(',').map(selector => selector.trim()));
    expect(suppressed).toEqual(expect.arrayContaining([
      '.claudian-settings',
      '.claudian-skill-sync-modal',
      '.claudian-agent-skill-modal',
      '.claudian-env-snippet-modal',
    ]));
  });
});
