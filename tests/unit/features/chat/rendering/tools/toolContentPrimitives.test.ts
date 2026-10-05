import { createMockEl } from '@test/helpers/MockElement';
import { setIcon } from 'obsidian';

import { setToolIcon } from '@/features/chat/rendering/tools/toolContentPrimitives';
import { renderExpandedContent } from '@/features/chat/rendering/tools/toolPresentation';

jest.mock('obsidian', () => ({
  Platform: { resourcePathPrefix: 'app://local/' },
  setIcon: jest.fn(),
}));

describe('toolContentPrimitives', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('setToolIcon', () => {
    it('should call setIcon with the resolved icon name', () => {
      const el = createMockEl() as unknown as HTMLElement;
      setToolIcon(el, 'Read');
      expect(setIcon).toHaveBeenCalledWith(el, expect.any(String));
    });

    it('should set MCP SVG for MCP tools', () => {
      const el = createMockEl();
      setToolIcon(el as unknown as HTMLElement, 'mcp__server__tool');
      expect(el.children[0]?.tagName).toBe('SVG');
    });
  });
});


it('keeps a large tool preview bounded without splitting the undisplayed lines', () => {
  const result = Array.from({ length: 10000 }, (_, index) => `line-${index}`).join('\r\n');
  const split = String.prototype.split;
  let splitWholeOutput = false;
  const spy = jest.spyOn(String.prototype, 'split').mockImplementation(function (this: string, ...args: Parameters<typeof split>) {
    if (String(this) === result && args[1] === undefined) splitWholeOutput = true;
    return split.apply(this, args);
  });
  try {
    const parent = createMockEl();
    renderExpandedContent(parent, { name: 'Bash', result, input: { command: 'echo' } });
    const element = parent;
    expect(element.querySelectorAll('.claudian-tool-line').length).toBeLessThanOrEqual(20);
    expect(element.querySelector('.claudian-tool-truncated')?.textContent).toContain('9980 more lines');
    expect(splitWholeOutput).toBe(false);
  } finally { spy.mockRestore(); }
});
