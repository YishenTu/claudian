import { CollabProjectConnection } from '@/app/collab/reconnect/CollabProjectConnection';
import { CollabError } from '@/core/collab/ClaudianCollabError';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(finish => { resolve = finish; });
  return { promise, resolve };
}

describe('CollabProjectConnection', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('keeps backoff until subscribed events and their snapshot converge despite HTTP success', async () => {
    let attempts = 0;
    const connection = new CollabProjectConnection({
      reconnect: async () => {
        attempts += 1;
        connection.observeControlSuccess();
        throw new CollabError({ code: 'operation-failed' });
      },
      onStatusChange: jest.fn(),
    });
    connection.observeEvents('connecting');
    connection.observeSuccess();
    expect(connection.status).toBe('offline');
    connection.observeEvents(new CollabError({ code: 'operation-failed' }));
    await jest.advanceTimersByTimeAsync(1_000);
    expect(attempts).toBe(1);
    expect(connection.status).toBe('offline');
    await jest.advanceTimersByTimeAsync(1_999);
    expect(attempts).toBe(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(attempts).toBe(2);
    connection.observeEvents('connected');
    expect(connection.status).toBe('connected');
    connection.observeEvents(new CollabError({ code: 'endpoint-unreachable' }));
    await jest.advanceTimersByTimeAsync(1_000);
    expect(attempts).toBe(3);
    await connection.close();
  });

  it('converges after a failed old route and a trusted rotation within the same attempt', async () => {
    const connection = new CollabProjectConnection({
      onStatusChange: jest.fn(),
      reconnect: async signal => {
        connection.observeFailure(new CollabError({ code: 'endpoint-unreachable' }));
        connection.invalidate(true);
        expect(signal.aborted).toBe(false);
        connection.observeControlSuccess();
        expect(connection.status).toBe('offline');
        return 'connected';
      },
    });
    await expect(connection.reconnect()).resolves.toBe(true);
    expect(connection.status).toBe('connected');
    await connection.close();
  });

  it('aborts a replaced generation without publishing its late success or abandoning its settlement', async () => {
    const old = deferred<'connected'>();
    let signal!: AbortSignal;
    const connection = new CollabProjectConnection({
      reconnect: async current => { signal = current; return old.promise; },
      onStatusChange: jest.fn(),
    });
    const pending = connection.reconnect();
    await Promise.resolve();
    connection.invalidate();
    expect(signal.aborted).toBe(true);
    expect(connection.reconnect()).toBe(pending);
    old.resolve('connected');
    await expect(pending).resolves.toBe(false);
    expect(connection.status).toBe('offline');
    await connection.close();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('retains a scheduled recovery when another control request succeeds', async () => {
    const connection = new CollabProjectConnection({ onStatusChange: jest.fn(), reconnect: async () => 'connected' });
    connection.observeEvents('connected');
    connection.observeFailure(new CollabError({ code: 'endpoint-unreachable' }));
    connection.observeControlSuccess();
    expect(connection.status).toBe('offline');
    await jest.advanceTimersByTimeAsync(1_000);
    expect(connection.status).toBe('connected');
    await connection.close();
  });

  it('coalesces HTTP and event observations of the same outage without postponing recovery', async () => {
    let recovered = false;
    const connection = new CollabProjectConnection({
      onStatusChange: jest.fn(),
      reconnect: async () => { recovered = true; return 'connected'; },
    });
    connection.observeEvents('connected');
    connection.observeFailure(new CollabError({ code: 'endpoint-unreachable' }));
    await jest.advanceTimersByTimeAsync(500);
    connection.observeFailure(new CollabError({ code: 'endpoint-unreachable' }));
    await jest.advanceTimersByTimeAsync(500);
    expect(recovered).toBe(true);
    await connection.close();
  });

  it('shares one discovery attempt and retries an unavailable endpoint until it reconnects', async () => {
    const first = deferred<'retry'>();
    const reconnect = jest.fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce('retry')
      .mockResolvedValueOnce('connected');
    const status = jest.fn();
    const connection = new CollabProjectConnection({ onStatusChange: status, reconnect });
    connection.observeEvents('connected');
    const pending = connection.reconnect();
    expect(connection.reconnect()).toBe(pending);
    first.resolve('retry');
    await expect(pending).resolves.toBe(false);
    await jest.advanceTimersByTimeAsync(999);
    expect(connection.status).toBe('offline');
    await jest.advanceTimersByTimeAsync(1);
    await jest.advanceTimersByTimeAsync(2_000);
    expect(connection.status).toBe('connected');
    expect(status).toHaveBeenLastCalledWith('connected');
    await connection.close();
  });

  it('returns an offline result for transport failure and retries without user input', async () => {
    const connection = new CollabProjectConnection({
      reconnect: jest.fn().mockRejectedValueOnce(new CollabError({ code: 'endpoint-unreachable' }))
        .mockResolvedValueOnce('connected'),
      onStatusChange: jest.fn(),
    });
    connection.observeEvents('connected');
    await expect(connection.reconnect()).resolves.toBe(false);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(connection.status).toBe('connected');
    await connection.close();
  });

  it('keeps retrying when an old event socket fails during a longer discovery attempt', async () => {
    const attempt = deferred<'retry'>();
    const connection = new CollabProjectConnection({
      reconnect: jest.fn().mockReturnValueOnce(attempt.promise).mockResolvedValueOnce('connected'),
      onStatusChange: jest.fn(),
    });
    connection.observeEvents('connected');
    const pending = connection.reconnect();
    await Promise.resolve();
    connection.observeFailure(new CollabError({ code: 'endpoint-unreachable' }));
    await jest.advanceTimersByTimeAsync(5_000);
    attempt.resolve('retry');
    await pending;
    await jest.advanceTimersByTimeAsync(30_000);
    expect(connection.status).toBe('connected');
    await connection.close();
  });

  it.each(['tls-ca-mismatch', 'tls-untrusted', 'authority-integrity-error'] as const)(
    'stops automatic retry on %s even if an old event socket fails during discovery',
    async code => {
      const settled = deferred<void>();
      const failure = new CollabError({ code });
      const connection = new CollabProjectConnection({
        reconnect: async () => { await settled.promise; throw failure; },
        onStatusChange: jest.fn(),
      });
      const pending = connection.reconnect();
      await Promise.resolve();
      connection.observeFailure(new CollabError({ code: 'endpoint-unreachable' }));
      settled.resolve();
      await expect(pending).rejects.toBe(failure);
      connection.observeFailure(new CollabError({ code: 'endpoint-unreachable' }));
      expect(connection.status).toBe('needs-attention');
      expect(jest.getTimerCount()).toBe(0);
      await expect(connection.reconnect()).resolves.toBe(false);
      await connection.close();
    },
  );

  it('aborts and drains admitted discovery on close and cannot publish a late endpoint', async () => {
    const settled = deferred<'connected'>();
    let signal!: AbortSignal;
    const connection = new CollabProjectConnection({
      reconnect: async current => { signal = current; return settled.promise; },
      onStatusChange: jest.fn(),
    });
    const reconnect = connection.reconnect();
    await Promise.resolve();
    let closed = false;
    const close = connection.close().then(() => { closed = true; });
    expect(signal.aborted).toBe(true);
    await Promise.resolve();
    expect(closed).toBe(false);
    settled.resolve('connected');
    await close;
    await expect(reconnect).resolves.toBe(false);
    expect(connection.status).toBe('offline');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('preserves newer successful connection evidence and stops retrying authority rejection', async () => {
    const failed = deferred<'retry'>();
    const connection = new CollabProjectConnection({
      reconnect: () => failed.promise, onStatusChange: jest.fn(),
    });
    const pending = connection.reconnect();
    connection.observeSuccess();
    failed.resolve('retry');
    await pending;
    expect(connection.status).toBe('connected');
    expect(jest.getTimerCount()).toBe(0);
    connection.observeFailure(new CollabError({ code: 'authority-integrity-error' }));
    expect(connection.status).toBe('needs-attention');
    expect(jest.getTimerCount()).toBe(0);
    await connection.close();
  });
});


it('does not schedule continuing work from an unobserved one-shot failure', async () => {
  jest.useFakeTimers();
  const reconnect = jest.fn(async () => 'connected' as const);
  const connection = new CollabProjectConnection({ onStatusChange: jest.fn(), reconnect });
  try {
    connection.observeFailure(new CollabError({ code: 'endpoint-unreachable' }));
    await jest.advanceTimersByTimeAsync(60_000);
    expect(reconnect).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  } finally { await connection.close(); jest.useRealTimers(); }
});
