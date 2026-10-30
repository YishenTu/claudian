/** @vitest-environment jsdom */

import { renderExpandedContent } from '@/features/chat/rendering/tools/toolPresentation';

it('keeps a large tool preview bounded without splitting the undisplayed lines', () => {
  const result = Array.from({ length: 10000 }, (_, index) => `line-${index}`).join('\r\n');
  const split = String.prototype.split;
  let splitWholeOutput = false;
  const spy = vi.spyOn(String.prototype, 'split').mockImplementation(function (this: string, ...args: Parameters<typeof split>) {
    if (String(this) === result && args[1] === undefined) splitWholeOutput = true;
    return split.apply(this, args);
  });
  try {
    const parent = document.createElement('div');
    renderExpandedContent(parent, { name: 'Bash', result, input: { command: 'echo' } });
    expect(parent.querySelectorAll('.claudian-tool-line').length).toBeLessThanOrEqual(20);
    expect(parent.querySelector('.claudian-tool-truncated')?.textContent).toContain('9980 more lines');
    expect(splitWholeOutput).toBe(false);
  } finally { spy.mockRestore(); }
});
