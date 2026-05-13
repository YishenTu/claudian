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
  const targetWindow = ownerWindow ?? getRendererWindow();
  if (!targetWindow) {
    callback();
    return { kind: 'timeout', id: 0, ownerWindow: null };
  }

  if (typeof targetWindow.requestAnimationFrame === 'function') {
    return {
      kind: 'raf',
      id: targetWindow.requestAnimationFrame(() => callback()),
      ownerWindow: targetWindow,
    };
  }

  return {
    kind: 'timeout',
    id: targetWindow.setTimeout(callback, 16),
    ownerWindow: targetWindow,
  };
}

export function cancelScheduledAnimationFrame(frame: ScheduledAnimationFrame): void {
  const targetWindow = frame.ownerWindow ?? getRendererWindow();
  if (!targetWindow) return;

  if (frame.kind === 'raf' && typeof targetWindow.cancelAnimationFrame === 'function') {
    targetWindow.cancelAnimationFrame(frame.id);
    return;
  }

  targetWindow.clearTimeout(frame.id);
}
