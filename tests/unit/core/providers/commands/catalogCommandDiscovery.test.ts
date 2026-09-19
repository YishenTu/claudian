import { createCatalogCommandDiscoveryStore } from '@/core/providers/commands/catalogCommandDiscovery';
import type {
  ProviderCommandCatalog,
  ProviderCommandDropdownConfig,
} from '@/core/providers/commands/ProviderCommandCatalog';
import type { ProviderCommandEntry } from '@/core/providers/commands/ProviderCommandEntry';

function createPendingCatalog(
  discoveryTimeoutMs?: ProviderCommandDropdownConfig['discoveryTimeoutMs'],
): {
  catalog: ProviderCommandCatalog;
  resolve(entries: ProviderCommandEntry[]): void;
} {
  let resolve!: (entries: ProviderCommandEntry[]) => void;
  const pending = new Promise<ProviderCommandEntry[]>(finish => {
    resolve = finish;
  });
  return {
    catalog: {
      getDropdownConfig: () => ({
        providerId: 'claude',
        triggerChars: ['/'],
        builtInPrefix: '/',
        skillPrefix: '/',
        commandPrefix: '/',
        ...(discoveryTimeoutMs !== undefined ? { discoveryTimeoutMs } : {}),
      }),
      listDropdownEntries: jest.fn(() => pending),
    } as unknown as ProviderCommandCatalog,
    resolve,
  };
}

const reviewEntry = {
  id: 'sdk:review',
  providerId: 'claude',
  kind: 'command',
  name: 'review',
  description: 'Review changes',
  content: '',
  scope: 'runtime',
  source: 'sdk',
  isEditable: false,
  isDeletable: false,
  displayPrefix: '/',
  insertPrefix: '/',
} satisfies ProviderCommandEntry;

const timedOut = {
  status: 'error',
  message: 'Provider command discovery timed out',
  retryable: true,
};

describe('createCatalogCommandDiscoveryStore', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('lets a provider-owned deadline outlive the shared picker deadline', async () => {
    const { catalog, resolve } = createPendingCatalog('provider-owned');
    const discovery = createCatalogCommandDiscoveryStore(catalog);

    const load = discovery.load();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(discovery.getSnapshot()).toEqual({ status: 'loading' });

    resolve([reviewEntry]);
    await expect(load).resolves.toEqual({ status: 'ready', items: [reviewEntry] });
  });

  it('times out at a catalog-declared deadline instead of the shared one', async () => {
    const { catalog } = createPendingCatalog(20_000);
    const discovery = createCatalogCommandDiscoveryStore(catalog);

    const load = discovery.load();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(discovery.getSnapshot()).toEqual({ status: 'loading' });

    await jest.advanceTimersByTimeAsync(10_000);
    await expect(load).resolves.toEqual(timedOut);
  });

  it('keeps the shared picker deadline when the catalog declares none', async () => {
    const { catalog } = createPendingCatalog();
    const discovery = createCatalogCommandDiscoveryStore(catalog);

    const load = discovery.load();
    await jest.advanceTimersByTimeAsync(8_000);

    await expect(load).resolves.toEqual(timedOut);
  });
});
