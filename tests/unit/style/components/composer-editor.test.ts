/** @jest-environment jsdom */

import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('Composer editor styles', () => {
  const css = readFileSync(path.resolve('src/style/components/composer-editor.css'), 'utf8');

  function rules(): CSSStyleRule[] {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    const found = Array.from(style.sheet!.cssRules).filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule);
    style.remove();
    return found;
  }

  // CodeMirror mounts on first focus; before that a CSS placeholder stands in for it.
  it('lays out the pre-mount placeholder and the mounted editor with one line height', () => {
    const all = rules();
    const host = all.find(rule => rule.selectorText === '.claudian-input-wrapper .claudian-composer-editor')!;
    expect(host.style.getPropertyValue('line-height')).toBe('1.4');

    // CodeMirror's base theme sets its own .cm-scroller line height; the composer must not follow it.
    const scroller = all.find(rule => rule.selectorText === '.claudian-composer-editor .cm-scroller')!;
    expect(scroller.style.getPropertyValue('line-height')).toBe('inherit');

    const placeholder = all.find(rule => rule.selectorText === '.claudian-composer-editor:empty::before')!;
    expect(placeholder.style.getPropertyValue('line-height')).toBe('');
  });
});
