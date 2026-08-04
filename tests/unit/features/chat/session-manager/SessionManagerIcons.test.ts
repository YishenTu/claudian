import { createMockEl } from '@test/helpers/MockElement';

import { renderSessionGroupToggleIcon } from '@/features/chat/session-manager/SessionManagerIcons';

describe('SessionManagerIcons', () => {
  it.each([
    ['collapse', 'm15 5 3 3 3-3'],
    ['expand', 'm15 8 3-3 3 3'],
  ] as const)('renders the %s icon directly into its container', (state, expectedPath) => {
    const container = createMockEl();

    renderSessionGroupToggleIcon(container, state);

    const svg = container.children[0];
    expect(svg.tagName).toBe('SVG');
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(svg.children.map((path: { getAttribute: (name: string) => string | null }) => (
      path.getAttribute('d')
    ))).toContain(expectedPath);
    expect(container.dataset.iconState).toBe(state);
  });

  it('replaces the previous icon when the state changes', () => {
    const container = createMockEl();

    renderSessionGroupToggleIcon(container, 'collapse');
    renderSessionGroupToggleIcon(container, 'expand');

    expect(container.children).toHaveLength(1);
    expect(container.dataset.iconState).toBe('expand');
  });
});
