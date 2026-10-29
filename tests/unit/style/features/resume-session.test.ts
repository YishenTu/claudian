/** @vitest-environment jsdom */

import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('resume-session.css', () => {
  let style: HTMLStyleElement;

  beforeEach(() => {
    style = document.createElement('style');
    style.textContent = readFileSync(path.resolve('src/style/features/resume-session.css'), 'utf8');
    document.head.appendChild(style);
  });

  afterEach(() => {
    document.body.replaceChildren();
    document.body.className = '';
    style.remove();
  });

  // Translucent macOS windows never clear under a backdrop blur, so the gaps around the zen panel darken
  // to black, and themes can make the secondary background see-through.
  it('paints the dropdown opaque without a backdrop blur or shadow in translucent dark windows', () => {
    document.body.className = 'theme-dark is-translucent';
    document.body.innerHTML = '<div class="claudian-resume-dropdown visible"></div>';
    const dropdownEl = document.querySelector('.claudian-resume-dropdown')!;
    const dropdown = window.getComputedStyle(dropdownEl);
    // jsdom omits backdrop-filter from computed styles, so the matching rules are read directly.
    const backdropFilters = [...style.sheet!.cssRules]
      .filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule && dropdownEl.matches(rule.selectorText))
      .map(rule => rule.style.getPropertyValue('backdrop-filter'))
      .filter(Boolean);

    expect({
      backgroundColor: dropdown.backgroundColor,
      backdropFilters,
      boxShadow: dropdown.boxShadow,
    }).toEqual({ backgroundColor: 'rgb(30, 30, 30)', backdropFilters: [], boxShadow: '' });
  });
});
