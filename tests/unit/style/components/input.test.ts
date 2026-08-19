import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('Input navigation button styles', () => {
  const css = readFileSync(path.resolve('src/style/components/input.css'), 'utf8');
  const historyCss = readFileSync(path.resolve('src/style/components/history.css'), 'utf8');

  it('keeps native and non-native navigation buttons chromeless in every state', () => {
    const baseRule = css.match(/\.claudian-input-nav-btn\s*{[^}]*}/)?.[0];
    expect(baseRule).toContain('border: 0;');
    expect(baseRule).toContain('background: transparent;');
    expect(baseRule).toContain('box-shadow: none;');
    expect(baseRule).toContain('color: var(--text-muted);');

    const interactionRule = css.match(
      /\.claudian-input-nav-btn:hover,\s*\.claudian-input-nav-btn:focus-visible,\s*\.claudian-input-nav-btn:active\s*{[^}]*}/,
    )?.[0];
    expect(interactionRule).toContain('border: 0;');
    expect(interactionRule).toContain('background: transparent;');
    expect(interactionRule).toContain('box-shadow: none;');
    expect(interactionRule).toContain('color: var(--text-normal);');

    const disabledRule = css.match(
      /\.claudian-input-nav-btn:disabled,\s*\.claudian-input-nav-btn\[aria-disabled='true'\]\s*{[^}]*}/,
    )?.[0];
    expect(disabledRule).toContain('border: 0;');
    expect(disabledRule).toContain('background: transparent;');
    expect(disabledRule).toContain('box-shadow: none;');
    expect(disabledRule).toContain('color: var(--text-faint);');
    expect(disabledRule).toContain('cursor: default;');

    const nativeButtonRule = css.match(
      /button\.claudian-input-nav-btn\s*{[^}]*}/,
    )?.[0];
    expect(nativeButtonRule).toContain('min-width: 24px;');
    expect(nativeButtonRule).toContain('min-height: 24px;');
    expect(nativeButtonRule).toContain('padding: 0;');
    expect(nativeButtonRule).toContain('border: 0;');
    expect(nativeButtonRule).toContain('background: transparent;');
    expect(nativeButtonRule).toContain('box-shadow: none;');
    expect(nativeButtonRule).toContain('color: var(--text-muted);');

    const nativeInteractionRule = css.match(
      /button\.claudian-input-nav-btn:hover,\s*button\.claudian-input-nav-btn:focus-visible,\s*button\.claudian-input-nav-btn:active\s*{[^}]*}/,
    )?.[0];
    expect(nativeInteractionRule).toContain('padding: 0;');
    expect(nativeInteractionRule).toContain('background: transparent;');
    expect(nativeInteractionRule).toContain('color: var(--text-normal);');
  });

  it('keeps the expanded Collab control muted until interaction', () => {
    const activeRule = historyCss.match(
      /\.claudian-compact-collab-button\.is-active\s*{[^}]*}/,
    )?.[0];
    expect(activeRule).toContain('border: 0;');
    expect(activeRule).toContain('background: transparent;');
    expect(activeRule).toContain('box-shadow: none;');
    expect(activeRule).toContain('color: var(--text-muted);');
  });
});
