export type SessionGroupToggleIconState = 'collapse' | 'expand';

const ICON_PATHS: Record<SessionGroupToggleIconState, readonly string[]> = {
  collapse: [
    'M3 5h8',
    'M3 12h8',
    'M3 19h8',
    'm15 5 3 3 3-3',
    'm15 19 3-3 3 3',
  ],
  expand: [
    'M3 5h8',
    'M3 12h8',
    'M3 19h8',
    'm15 8 3-3 3 3',
    'm15 16 3 3 3-3',
  ],
};

export function renderSessionGroupToggleIcon(
  container: HTMLElement,
  state: SessionGroupToggleIconState,
): void {
  container.empty();
  container.dataset.iconState = state;

  const svg = container.createSvg('svg', {
    attr: {
      'aria-hidden': 'true',
      fill: 'none',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'stroke-width': '2',
      stroke: 'currentColor',
      viewBox: '0 0 24 24',
    },
  });
  for (const path of ICON_PATHS[state]) {
    svg.createSvg('path', { attr: { d: path } });
  }
}
