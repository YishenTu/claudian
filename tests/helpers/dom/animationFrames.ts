import { onTestFinished } from 'vitest';

/**
 * Opt-in scheduling for lifecycle tests that make no frame-rate, layout or geometry claim.
 * Each callback runs on the next macrotask, with the owning window's performance timestamp.
 * Call separately for each window (including a popout's document.defaultView).
 */
export function useNextTaskAnimationFrames(target: Window = window): () => void {
  const methods = ['requestAnimationFrame', 'cancelAnimationFrame'] as const;
  const originals = methods.map(name => Object.getOwnPropertyDescriptor(target, name));
  const pending = new Set<number>();
  let installed = true;
  const requestAnimationFrame = (callback: FrameRequestCallback): number => {
    const handle = target.setTimeout(() => {
      pending.delete(handle);
      callback.call(target, target.performance.now());
    }, 0);
    pending.add(handle);
    return handle;
  };
  const cancelAnimationFrame = (handle: number): void => {
    if (pending.delete(handle)) target.clearTimeout(handle);
  };
  for (const [name, value] of Object.entries({ requestAnimationFrame, cancelAnimationFrame })) {
    Object.defineProperty(target, name, { configurable: true, writable: true, value });
  }
  const restore = (): void => {
    if (!installed) return;
    installed = false;
    for (const handle of pending) target.clearTimeout(handle);
    pending.clear();
    methods.forEach((name, index) => {
      const original = originals[index];
      if (original) Object.defineProperty(target, name, original);
      else Reflect.deleteProperty(target, name);
    });
  };
  onTestFinished(restore);
  return restore;
}
