type TestWindow = typeof globalThis & {
  cancelAnimationFrame?: (handle: number) => void;
  requestAnimationFrame?: (callback: FrameRequestCallback) => number;
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

if (!('window' in globalThis)) {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: testWindow,
    writable: true,
  });
}
