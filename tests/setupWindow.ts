type TestWindow = typeof globalThis & {
  cancelAnimationFrame?: (handle: number) => void;
  requestAnimationFrame?: (callback: FrameRequestCallback) => number;
  getComputedStyle?: (el: Element) => CSSStyleDeclaration;
};

const testWindow = globalThis as TestWindow;

if (!testWindow.requestAnimationFrame) {
  testWindow.requestAnimationFrame = (callback: FrameRequestCallback): number => (
    Number(setTimeout(() => callback(Date.now()), 0))
  );
}

if (!testWindow.cancelAnimationFrame) {
  testWindow.cancelAnimationFrame = (handle: number): void => {
    clearTimeout(handle);
  };
}

if (!testWindow.getComputedStyle) {
  // Stub returning empty values so callers fall back to their defaults.
  testWindow.getComputedStyle = () => ({
    getPropertyValue: () => '',
  }) as unknown as CSSStyleDeclaration;
}

if (!('window' in globalThis)) {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: testWindow,
    writable: true,
  });
}
