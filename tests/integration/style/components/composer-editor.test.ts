// @test-ci {"inputs":["src/style/**"]}
/** @vitest-environment jsdom */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { axe } from '@test/helpers/accessibility';
import { within } from '@testing-library/dom';
import type { App, Component } from 'obsidian';

import { ComposerEditor } from '@/features/chat/composer/ComposerEditor';

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

  it('gives restored drafts the editor insets and scroll limit before first focus, without doubling them on mount', async () => {
    const parent = document.body.createDiv({ cls: 'claudian-input-wrapper' });
    const editor = new ComposerEditor(parent, {} as App, {} as Component);
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    try {
      editor.element.value = 'First line\nSecond line\nThird line';
      const textbox = within(parent).getByRole('textbox', { name: 'Message' });
      expect(textbox).toBe(editor.element);
      expect(document.activeElement).not.toBe(textbox);
      const restored = getComputedStyle(textbox);
      // Geometry is checked in Chromium; this protects the shared spacing and overflow declarations.
      expect(restored.padding).toBe('var(--claudian-composer-padding-top) var(--claudian-composer-padding-inline) var(--claudian-composer-padding-bottom)');
      expect(restored.maxHeight).toBe('var(--claudian-textarea-max-height, none)');
      expect(restored.overflow).toBe('auto');
      expect(await axe(parent)).toHaveNoViolations();

      editor.element.focus();
      expect(within(parent).getByRole('textbox', { name: 'Message' })).not.toBe(textbox);
      expect(getComputedStyle(editor.element).padding).toBe('');
      expect(editor.element.value).toBe('First line\nSecond line\nThird line');
    } finally {
      editor.destroy();
      parent.remove();
      style.remove();
    }
  });

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
