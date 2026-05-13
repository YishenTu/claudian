type NativeTimers = {
  clearInterval: typeof clearInterval;
  clearTimeout: typeof clearTimeout;
  setInterval: typeof setInterval;
  setTimeout: typeof setTimeout;
};

function getNativeTimers(): NativeTimers {
  return {
    clearInterval,
    clearTimeout,
    setInterval,
    setTimeout,
  };
}

export function clearNativeInterval(handle: ReturnType<typeof setInterval>): void {
  getNativeTimers().clearInterval(handle);
}

export function clearNativeTimeout(handle: ReturnType<typeof setTimeout>): void {
  getNativeTimers().clearTimeout(handle);
}

export function setNativeInterval(...args: Parameters<typeof setInterval>): ReturnType<typeof setInterval> {
  return getNativeTimers().setInterval(...args);
}

export function setNativeTimeout(...args: Parameters<typeof setTimeout>): ReturnType<typeof setTimeout> {
  return getNativeTimers().setTimeout(...args);
}
