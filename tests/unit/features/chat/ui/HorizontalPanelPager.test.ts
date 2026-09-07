/** @jest-environment jsdom */

import {
  HorizontalPanelPager,
  type HorizontalPanelPagerPanel,
} from '@/features/chat/ui/HorizontalPanelPager';

type PanelId = 'sessions' | 'files' | 'collab';

const VIEWPORT_WIDTH = 240;

function createPanels<Id extends PanelId>(ids: readonly Id[]): {
  readonly panels: readonly HorizontalPanelPagerPanel<Id>[];
  readonly trackEl: HTMLDivElement;
} {
  const trackEl = document.createElement('div');
  const panels = ids.map(id => {
    const element = document.createElement('section');
    element.dataset.panel = id;
    trackEl.appendChild(element);
    return { element, id };
  });
  Object.defineProperty(trackEl, 'clientWidth', {
    configurable: true,
    value: VIEWPORT_WIDTH,
  });
  document.body.appendChild(trackEl);
  return { panels, trackEl };
}

function panelOrder(trackEl: HTMLElement): string[] {
  return [...trackEl.children].map(element => (
    (element as HTMLElement).dataset.panel ?? ''
  ));
}

function wheel(
  target: HTMLElement,
  deltaX: number,
  deltaY = 0,
  ctrlKey = false,
): WheelEvent {
  const event = new WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    ctrlKey,
    deltaMode: WheelEvent.DOM_DELTA_PIXEL,
    deltaX,
    deltaY,
  });
  target.dispatchEvent(event);
  return event;
}

function scrollTo(trackEl: HTMLElement, scrollLeft: number): void {
  trackEl.scrollLeft = scrollLeft;
  trackEl.dispatchEvent(new Event('scroll'));
}

function endScroll(trackEl: HTMLElement): void {
  trackEl.dispatchEvent(new Event('scrollend'));
}

describe('HorizontalPanelPager', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('uses the native scrollport to follow one long wheel operation and settle once', () => {
    const { panels, trackEl } = createPanels(['sessions', 'files', 'collab']);
    const onDragTarget = jest.fn();
    const onIndicatorChange = jest.fn();
    const onSettle = jest.fn();
    const pager = new HorizontalPanelPager<PanelId>({
      onDragTarget,
      onIndicatorChange,
      onSettle,
      trackEl,
    });

    pager.update({
      activePanel: 'sessions',
      enabled: true,
      panels,
      viewportWidth: VIEWPORT_WIDTH,
    });

    expect(panelOrder(trackEl)).toEqual(['collab', 'sessions', 'files']);
    expect(trackEl.scrollLeft).toBe(VIEWPORT_WIDTH);

    wheel(trackEl, 140);
    scrollTo(trackEl, 310);
    expect(onIndicatorChange).toHaveBeenLastCalledWith('files');
    wheel(trackEl, 120);
    scrollTo(trackEl, 430);
    wheel(trackEl, 80);
    scrollTo(trackEl, VIEWPORT_WIDTH * 2);
    wheel(trackEl, 30);
    wheel(trackEl, 10);

    expect(onDragTarget).toHaveBeenCalledWith('files');
    expect(onIndicatorChange).toHaveBeenLastCalledWith('files');
    expect(onSettle).not.toHaveBeenCalled();

    endScroll(trackEl);

    expect(onSettle).toHaveBeenCalledTimes(1);
    expect(onSettle).toHaveBeenLastCalledWith('files');
    expect(panelOrder(trackEl)).toEqual(['sessions', 'files', 'collab']);
    expect(trackEl.scrollLeft).toBe(VIEWPORT_WIDTH);

    // The scrollend emitted by the programmatic recenter is not a second commit.
    endScroll(trackEl);
    expect(onSettle).toHaveBeenCalledTimes(1);

    pager.destroy();
  });

  it('accepts stationary-cursor same-direction swipes without pointer events and cycles panels', () => {
    const { panels, trackEl } = createPanels(['sessions', 'files', 'collab']);
    const onSettle = jest.fn();
    const pager = new HorizontalPanelPager<PanelId>({
      onDragTarget: jest.fn(),
      onIndicatorChange: jest.fn(),
      onSettle,
      trackEl,
    });
    pager.update({
      activePanel: 'sessions',
      enabled: true,
      panels,
      viewportWidth: VIEWPORT_WIDTH,
    });

    const swipeNext = () => {
      wheel(trackEl, 900);
      scrollTo(trackEl, VIEWPORT_WIDTH * 2);
      endScroll(trackEl);
      endScroll(trackEl);
    };

    swipeNext();
    swipeNext();
    swipeNext();

    expect(onSettle.mock.calls.map(([panel]) => panel)).toEqual([
      'files',
      'collab',
      'sessions',
    ]);
    expect(panelOrder(trackEl)).toEqual(['collab', 'sessions', 'files']);

    pager.destroy();
  });

  it('clamps an oversized native scroll result to one adjacent panel', () => {
    const { panels, trackEl } = createPanels(['sessions', 'files', 'collab']);
    const onSettle = jest.fn();
    const pager = new HorizontalPanelPager<PanelId>({
      onDragTarget: jest.fn(),
      onIndicatorChange: jest.fn(),
      onSettle,
      trackEl,
    });
    pager.update({
      activePanel: 'sessions',
      enabled: true,
      panels,
      viewportWidth: VIEWPORT_WIDTH,
    });

    wheel(trackEl, 2_000);
    scrollTo(trackEl, 10_000);
    endScroll(trackEl);

    expect(onSettle).toHaveBeenCalledTimes(1);
    expect(onSettle).toHaveBeenCalledWith('files');

    pager.destroy();
  });

  it('announces a Collab drag target before scroll settlement without activating it', () => {
    const { panels, trackEl } = createPanels(['sessions', 'files', 'collab']);
    const onDragTarget = jest.fn();
    const onIndicatorChange = jest.fn();
    const onSettle = jest.fn();
    const pager = new HorizontalPanelPager<PanelId>({
      onDragTarget,
      onIndicatorChange,
      onSettle,
      trackEl,
    });
    pager.update({
      activePanel: 'files',
      enabled: true,
      panels,
      viewportWidth: VIEWPORT_WIDTH,
    });

    wheel(trackEl, 40);

    expect(onDragTarget).toHaveBeenCalledWith('collab');
    expect(onSettle).not.toHaveBeenCalled();

    scrollTo(trackEl, VIEWPORT_WIDTH * 2);
    expect(onIndicatorChange).toHaveBeenLastCalledWith('collab');
    expect(onSettle).not.toHaveBeenCalled();

    endScroll(trackEl);
    expect(onSettle).toHaveBeenCalledWith('collab');

    pager.destroy();
  });

  it('does not cancel vertical scrolling or pinch zoom', () => {
    const { panels, trackEl } = createPanels(['sessions', 'files', 'collab']);
    const onDragTarget = jest.fn();
    const onSettle = jest.fn();
    const pager = new HorizontalPanelPager<PanelId>({
      onDragTarget,
      onIndicatorChange: jest.fn(),
      onSettle,
      trackEl,
    });
    pager.update({
      activePanel: 'sessions',
      enabled: true,
      panels,
      viewportWidth: VIEWPORT_WIDTH,
    });

    const vertical = wheel(trackEl, 4, 60);
    const pinch = wheel(trackEl, 0, -100, true);

    expect(vertical.defaultPrevented).toBe(false);
    expect(pinch.defaultPrevented).toBe(false);
    expect(onDragTarget).not.toHaveBeenCalled();
    expect(onSettle).not.toHaveBeenCalled();

    pager.destroy();
  });

  it('keeps the active panel centered across repeated swipes in either direction', () => {
    const { panels, trackEl } = createPanels(['sessions', 'collab']);
    const onSettle = jest.fn();
    const pager = new HorizontalPanelPager<'sessions' | 'collab'>({
      onDragTarget: jest.fn(),
      onIndicatorChange: jest.fn(),
      onSettle,
      trackEl,
    });
    pager.update({
      activePanel: 'sessions',
      enabled: true,
      panels,
      viewportWidth: VIEWPORT_WIDTH,
    });

    const swipe = (direction: -1 | 1) => {
      const childrenBeforeWheel = [...trackEl.children];

      wheel(trackEl, direction * 90);

      // Starting a wheel transaction must not move its DOM target or jump the
      // scroll position to an edge. Both directions scroll away from center.
      expect([...trackEl.children]).toEqual(childrenBeforeWheel);
      expect(trackEl.scrollLeft).toBe(VIEWPORT_WIDTH);

      scrollTo(trackEl, direction > 0 ? VIEWPORT_WIDTH * 2 : 0);
      endScroll(trackEl);
      endScroll(trackEl);
    };

    swipe(1);
    swipe(1);
    swipe(-1);
    swipe(-1);

    expect(onSettle.mock.calls.map(([panel]) => panel)).toEqual([
      'collab',
      'sessions',
      'collab',
      'sessions',
    ]);

    pager.destroy();
  });

  it('renders the other logical panel on both sides with an inert replica', () => {
    const { panels, trackEl } = createPanels(['sessions', 'collab']);
    panels[1].element.innerHTML = '<button id="collab-action">Collab action</button>';
    const pager = new HorizontalPanelPager<'sessions' | 'collab'>({
      onDragTarget: jest.fn(),
      onIndicatorChange: jest.fn(),
      onSettle: jest.fn(),
      trackEl,
    });
    pager.update({
      activePanel: 'sessions',
      enabled: true,
      panels,
      viewportWidth: VIEWPORT_WIDTH,
    });

    const replica = trackEl.querySelector('.claudian-sidebar-surface-replica');
    const before = trackEl.querySelector('.claudian-sidebar-surface-page--before');
    const active = trackEl.querySelector('.claudian-sidebar-surface-page--active');
    const after = trackEl.querySelector('.claudian-sidebar-surface-page--after');

    expect(replica).not.toBeNull();
    expect(replica?.getAttribute('aria-hidden')).toBe('true');
    expect(replica?.hasAttribute('inert')).toBe(true);
    expect(replica?.textContent).toContain('Collab action');
    expect(replica?.querySelector('#collab-action')).toBeNull();
    expect(document.querySelectorAll('#collab-action')).toHaveLength(1);
    expect(before).toBe(replica);
    expect(active).toBe(panels[0].element);
    expect(after).toBe(panels[1].element);
    expect(replica?.querySelector('[data-panel="collab"]')).not.toBeNull();

    const replicaContent = replica?.firstElementChild;
    wheel(trackEl, -90);
    expect(replica?.firstElementChild).toBe(replicaContent);

    pager.destroy();
  });

  it('copies runtime visual state into the two-panel replica', () => {
    const { panels, trackEl } = createPanels(['sessions', 'collab']);
    panels[1].element.innerHTML = `
      <div data-scroll-container>
        <input data-runtime-value value="initial">
      </div>
    `;
    const sourceScroller = panels[1].element.querySelector<HTMLElement>(
      '[data-scroll-container]',
    )!;
    const sourceInput = panels[1].element.querySelector<HTMLInputElement>(
      '[data-runtime-value]',
    )!;
    sourceScroller.scrollTop = 72;
    sourceInput.value = 'runtime value';

    const pager = new HorizontalPanelPager<'sessions' | 'collab'>({
      onDragTarget: jest.fn(),
      onIndicatorChange: jest.fn(),
      onSettle: jest.fn(),
      trackEl,
    });
    pager.update({
      activePanel: 'sessions',
      enabled: true,
      panels,
      viewportWidth: VIEWPORT_WIDTH,
    });

    const replica = trackEl.querySelector('.claudian-sidebar-surface-replica')!;
    expect(replica.querySelector<HTMLElement>('[data-scroll-container]')?.scrollTop).toBe(72);
    expect(replica.querySelector<HTMLInputElement>('[data-runtime-value]')?.value).toBe(
      'runtime value',
    );

    pager.destroy();
  });

  it('refreshes the replica from the newly inactive panel after settlement', () => {
    const { panels, trackEl } = createPanels(['sessions', 'collab']);
    panels[0].element.textContent = 'Session snapshot';
    panels[1].element.textContent = 'Collab snapshot';
    const pager = new HorizontalPanelPager<'sessions' | 'collab'>({
      onDragTarget: jest.fn(),
      onIndicatorChange: jest.fn(),
      onSettle: jest.fn(),
      trackEl,
    });
    pager.update({
      activePanel: 'sessions',
      enabled: true,
      panels,
      viewportWidth: VIEWPORT_WIDTH,
    });

    wheel(trackEl, 90);
    scrollTo(trackEl, VIEWPORT_WIDTH * 2);
    endScroll(trackEl);

    const replica = trackEl.querySelector('.claudian-sidebar-surface-replica');
    expect(replica?.textContent).toContain('Session snapshot');
    expect(replica?.textContent).not.toContain('Collab snapshot');

    pager.destroy();
  });

  it('adds and retires the two-panel replica as enabled panels change', () => {
    const { panels, trackEl } = createPanels(['sessions', 'files', 'collab']);
    const pager = new HorizontalPanelPager<PanelId>({
      onDragTarget: jest.fn(),
      onIndicatorChange: jest.fn(),
      onSettle: jest.fn(),
      trackEl,
    });
    pager.update({
      activePanel: 'sessions',
      enabled: true,
      panels,
      viewportWidth: VIEWPORT_WIDTH,
    });

    pager.update({
      activePanel: 'sessions',
      enabled: true,
      panels: panels.filter(panel => panel.id !== 'files'),
      viewportWidth: VIEWPORT_WIDTH,
    });

    const replica = trackEl.querySelector('.claudian-sidebar-surface-replica');
    expect(replica).not.toBeNull();
    expect(replica?.getAttribute('aria-hidden')).toBe('true');
    expect(replica?.hasAttribute('inert')).toBe(true);
    expect(replica?.classList.contains('claudian-hidden')).toBe(false);
    expect(trackEl.scrollLeft).toBe(VIEWPORT_WIDTH);

    pager.update({
      activePanel: 'sessions',
      enabled: true,
      panels,
      viewportWidth: VIEWPORT_WIDTH,
    });

    expect(replica?.classList.contains('claudian-hidden')).toBe(true);
    expect(replica?.children).toHaveLength(0);
    for (const panel of panels) {
      expect(panel.element.className).not.toContain('claudian-sidebar-surface-page--');
    }

    pager.destroy();
  });

  it('positions the real neighbor when native scrolling starts without wheel', () => {
    const { panels, trackEl } = createPanels(['sessions', 'collab']);
    const onSettle = jest.fn();
    const pager = new HorizontalPanelPager<'sessions' | 'collab'>({
      onDragTarget: jest.fn(),
      onIndicatorChange: jest.fn(),
      onSettle,
      trackEl,
    });
    pager.update({
      activePanel: 'sessions',
      enabled: true,
      panels,
      viewportWidth: VIEWPORT_WIDTH,
    });

    const childrenBeforeScroll = [...trackEl.children];
    scrollTo(trackEl, VIEWPORT_WIDTH - 40);

    const replica = trackEl.querySelector('.claudian-sidebar-surface-replica');
    expect([...trackEl.children]).toEqual(childrenBeforeScroll);
    expect(panels[1].element.classList).toContain(
      'claudian-sidebar-surface-page--before',
    );
    expect(panels[0].element.classList).toContain(
      'claudian-sidebar-surface-page--active',
    );
    expect(replica?.classList).toContain('claudian-sidebar-surface-page--after');

    scrollTo(trackEl, 0);
    endScroll(trackEl);
    expect(onSettle).toHaveBeenCalledWith('collab');

    pager.destroy();
  });
});
