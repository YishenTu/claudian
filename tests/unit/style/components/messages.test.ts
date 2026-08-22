import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('Long conversation message styles', () => {
  const css = readFileSync(path.resolve('src/style/components/messages.css'), 'utf8');

  it('isolates offscreen message layout while preserving role-shaped scroll estimates', () => {
    const messageRule = css.match(/\.claudian-message\s*{[^}]*}/)?.[0];
    expect(messageRule).toContain('flex-shrink: 0;');
    expect(messageRule).toContain('content-visibility: auto;');

    const userRule = css.match(/\.claudian-message-user\s*{[^}]*}/)?.[0];
    expect(userRule).toContain('contain-intrinsic-size: auto 5rem;');

    const assistantRule = css.match(/\.claudian-message-assistant\s*{[^}]*}/)?.[0];
    expect(assistantRule).toContain('contain-intrinsic-size: auto 23.5rem;');
  });
});
