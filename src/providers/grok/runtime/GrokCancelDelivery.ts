export const GROK_CANCEL_DELIVERY_GRACE_MS = 250;

export interface GrokFlushableTransport {
  flush(): Promise<void>;
}

export function waitForGrokCancelDelivery(
  transport: GrokFlushableTransport | null | undefined,
): Promise<void> {
  const delivery = transport?.flush() ?? Promise.resolve();

  return new Promise(resolve => {
    const timeout = window.setTimeout(resolve, GROK_CANCEL_DELIVERY_GRACE_MS);
    void delivery.then(
      () => {
        window.clearTimeout(timeout);
        resolve();
      },
      () => {
        window.clearTimeout(timeout);
        resolve();
      },
    );
  });
}
