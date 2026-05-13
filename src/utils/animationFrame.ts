export interface ScheduledAnimationFrame {
  kind: 'raf' | 'timeout';
  id: number;
  ownerWindow: Window | null;
}

function getRendererWindow(): Window | null {
  return typeof window === 'undefined' ? null : window;
}

export function scheduleAnimationFrame(
  callback: () => void,
  ownerWindow: Window | null = getRendererWindow(),
): ScheduledAnimationFrame {
  const timerWindow = ownerWindow ?? getRendererWindow();
  if (!timerWindow) {
    callback();
    return { kind: 'timeout', id: 0, ownerWindow: null };
  }

  if (typeof timerWindow.requestAnimationFrame === 'function') {
    return {
      kind: 'raf',
      id: timerWindow.requestAnimationFrame(() => callback()),
      ownerWindow: timerWindow,
    };
  }

  return {
    kind: 'timeout',
    id: timerWindow.setTimeout(callback, 16),
    ownerWindow: timerWindow,
  };
}

export function cancelScheduledAnimationFrame(frame: ScheduledAnimationFrame): void {
  const ownerWindow = frame.ownerWindow ?? getRendererWindow();
  if (!ownerWindow) return;

  if (frame.kind === 'raf' && typeof ownerWindow.cancelAnimationFrame === 'function') {
    ownerWindow.cancelAnimationFrame(frame.id);
    return;
  }

  ownerWindow.clearTimeout(frame.id);
}
