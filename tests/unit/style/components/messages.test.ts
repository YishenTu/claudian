import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('Long conversation message styles', () => {
  const css = readFileSync(path.resolve('src/style/components/messages.css'), 'utf8');

  it('isolates assistant layout without containing user message actions', () => {
    const messageRule = css.match(/\.claudian-message\s*{[^}]*}/)?.[0];
    expect(messageRule).not.toContain('content-visibility: auto;');

    const userRule = css.match(/\.claudian-message-user\s*{[^}]*}/)?.[0];
    expect(userRule).not.toContain('content-visibility: auto;');
    expect(userRule).not.toContain('contain-intrinsic-size:');

    const assistantRule = css.match(/\.claudian-message-assistant\s*{[^}]*}/)?.[0];
    expect(assistantRule).toContain('flex-shrink: 0;');
    expect(assistantRule).toContain('content-visibility: auto;');
    expect(assistantRule).toContain('contain-intrinsic-size: auto 23.5rem;');
  });
});
