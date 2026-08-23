import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('Image preview button styles', () => {
  const contextCss = readFileSync(
    path.resolve('src/style/features/image-context.css'),
    'utf8',
  );
  const modalCss = readFileSync(
    path.resolve('src/style/features/image-modal.css'),
    'utf8',
  );

  it('keeps the native thumbnail button on the existing image surface in every state', () => {
    const baseRule = contextCss.match(
      /button\.claudian-message-image,\s*button\.claudian-message-image:active\s*{[^}]*}/,
    )?.[0];
    expect(baseRule).toContain('padding: 0;');
    expect(baseRule).toContain('border: 1px solid var(--background-modifier-border);');
    expect(baseRule).toContain('background: var(--background-secondary);');
    expect(baseRule).toContain('background-image: none;');
    expect(baseRule).toContain('box-shadow: none;');

    const interactionRule = contextCss.match(
      /button\.claudian-message-image:hover,\s*button\.claudian-message-image:focus-visible\s*{[^}]*}/,
    )?.[0];
    expect(interactionRule).toContain('border: 1px solid var(--background-modifier-border);');
    expect(interactionRule).toContain('background: var(--background-secondary);');
    expect(interactionRule).toContain('background-image: none;');
    expect(interactionRule).toContain('box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);');
  });

  it('keeps the native close button on the existing circular surface in every state', () => {
    const baseRule = modalCss.match(
      /button\.claudian-image-modal-close,\s*button\.claudian-image-modal-close:focus,\s*button\.claudian-image-modal-close:active\s*{[^}]*}/,
    )?.[0];
    expect(baseRule).toContain('padding: 0;');
    expect(baseRule).toContain('border: 0;');
    expect(baseRule).toContain('background: var(--background-secondary);');
    expect(baseRule).toContain('background-image: none;');
    expect(baseRule).toContain('box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);');

    const hoverRule = modalCss.match(
      /button\.claudian-image-modal-close:hover\s*{[^}]*}/,
    )?.[0];
    expect(hoverRule).toContain('border: 0;');
    expect(hoverRule).toContain('background: var(--background-modifier-error);');
    expect(hoverRule).toContain('background-image: none;');
    expect(hoverRule).toContain('box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);');
  });
});
