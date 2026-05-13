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
  const activeWindow = ownerWindow ?? getRendererWindow();
  if (!activeWindow) {
    callback();
    return { kind: 'timeout', id: 0, ownerWindow: null };
  }

  if (typeof activeWindow.requestAnimationFrame === 'function') {
    return {
      kind: 'raf',
      id: activeWindow.requestAnimationFrame(() => callback()),
      ownerWindow: activeWindow,
    };
  }

  return {
    kind: 'timeout',
    id: activeWindow.setTimeout(callback, 16),
    ownerWindow: activeWindow,
  };
}

export function cancelScheduledAnimationFrame(frame: ScheduledAnimationFrame): void {
  const activeWindow = frame.ownerWindow ?? getRendererWindow();
  if (!activeWindow) return;

  if (frame.kind === 'raf' && typeof activeWindow.cancelAnimationFrame === 'function') {
    activeWindow.cancelAnimationFrame(frame.id);
    return;
  }

  activeWindow.clearTimeout(frame.id);
}
