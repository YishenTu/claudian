import type { ProviderCommandDiscoveryResult } from '@/core/providers/commands/ProviderCommandDiscoveryResult';
import type { ProviderCommandDiscoverySource } from '@/core/providers/commands/ProviderCommandDiscoveryStore';
import type { ProviderCommandEntry } from '@/core/providers/commands/ProviderCommandEntry';
import { SlashCommandSource } from '@/shared/composer-dropdown/SlashCommandSource';

const ENTRY: ProviderCommandEntry = {
  content: '',
  description: 'Review changes',
  displayPrefix: '$',
  id: 'codex:skill:review',
  insertPrefix: '$',
  isDeletable: false,
  isEditable: false,
  kind: 'skill',
  name: 'review',
  providerId: 'codex',
  scope: 'runtime',
  source: 'sdk',
};

function discovery(
  snapshot: ReturnType<ProviderCommandDiscoverySource<ProviderCommandEntry>['getSnapshot']> = {
    status: 'ready',
    items: [ENTRY],
  },
): jest.Mocked<ProviderCommandDiscoverySource<ProviderCommandEntry>> {
  const ready: ProviderCommandDiscoveryResult<ProviderCommandEntry> = {
    status: 'ready',
    items: [ENTRY],
  };
  return {
    getSnapshot: jest.fn(() => snapshot),
    load: jest.fn(async () => snapshot.status === 'idle' || snapshot.status === 'loading'
      ? { status: 'empty' }
      : snapshot as ProviderCommandDiscoveryResult<ProviderCommandEntry>),
    retry: jest.fn(async () => ready),
    subscribe: jest.fn((_listener: () => void) => jest.fn()),
  } as jest.Mocked<ProviderCommandDiscoverySource<ProviderCommandEntry>>;
}

function match(trigger: string, query = '', atInputStart = true) {
  return { atInputStart, end: query.length + 1, query, start: 0, trigger };
}

describe('SlashCommandSource', () => {
  it('preserves provider trigger characters and provider insertion prefixes', async () => {
    const source = new SlashCommandSource({
      includeBuiltIns: false,
      providerConfig: {
        builtInPrefix: '/',
        commandPrefix: '/',
        providerId: 'codex',
        skillPrefix: '$',
        triggerChars: ['/', '$'],
      },
      providerDiscovery: discovery(),
      providerId: 'codex',
    });
    expect(source.match('$rev', 4)).toEqual(expect.objectContaining({
      query: 'rev',
      trigger: '$',
    }));
    const [item] = await source.load(match('$', 'rev'), new AbortController().signal);
    expect(item).toEqual(expect.objectContaining({ label: '$review', replacement: '$review ' }));
    source.destroy();
  });

  it('offers built-ins only for a leading slash and lets built-ins win name collisions', async () => {
    const clearEntry = { ...ENTRY, displayPrefix: '/', id: 'provider:clear', insertPrefix: '/', name: 'clear' };
    const source = new SlashCommandSource({
      providerDiscovery: discovery({ status: 'ready', items: [clearEntry] }),
      providerId: 'claude',
    });
    const leading = await source.load(match('/'), new AbortController().signal);
    expect(leading.filter(item => item.kind === 'value' && item.label === '/clear')).toHaveLength(1);
    const embedded = await source.load(match('/', '', false), new AbortController().signal);
    expect(embedded).toEqual([expect.objectContaining({ id: 'provider:clear' })]);
    source.destroy();
  });

  it('filters hidden provider commands and retries discovery only after explicit selection', async () => {
    const providerDiscovery = discovery({
      message: 'Could not load provider commands',
      retryable: true,
      status: 'error',
    });
    const source = new SlashCommandSource({
      hiddenCommands: new Set(['review']),
      includeBuiltIns: false,
      providerDiscovery,
      providerId: 'codex',
    });
    const items = source.load(match('$'), new AbortController().signal);
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Could not load provider commands', state: 'error' }),
      expect.objectContaining({ label: 'Retry' }),
    ]));
    await Promise.resolve();
    expect(providerDiscovery.retry).not.toHaveBeenCalled();
    const retry = items.find(item => item.kind === 'value' && item.label === 'Retry');
    const action = source.select(
      retry as Extract<typeof retry, { kind: 'value' }>,
      match('$'),
    );
    expect(action.kind).toBe('invoke');
    if (action.kind === 'invoke') action.onApplied();
    await Promise.resolve();
    expect(providerDiscovery.retry).toHaveBeenCalledTimes(1);
    source.destroy();
  });

  it('shows local built-ins immediately while provider discovery starts', async () => {
    const providerDiscovery = discovery({ status: 'idle' });
    const source = new SlashCommandSource({
      providerDiscovery,
      providerId: 'claude',
    });
    const items = source.load(match('/'), new AbortController().signal);
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: '/clear' }),
      expect.objectContaining({ state: 'loading' }),
    ]));
    await Promise.resolve();
    expect(providerDiscovery.load).toHaveBeenCalledTimes(1);
    source.destroy();
  });

  it('runs the selected command callback after returning a pure text replacement', async () => {
    const onSelect = jest.fn();
    const source = new SlashCommandSource({
      includeBuiltIns: false,
      onSelect,
      providerDiscovery: discovery(),
      providerId: 'codex',
    });
    const [item] = await source.load(match('$'), new AbortController().signal);
    const action = source.select(item as Extract<typeof item, { kind: 'value' }>, match('$'));
    expect(action).toEqual(expect.objectContaining({ kind: 'replace', text: '$review ' }));
    if (action.kind === 'replace') action.onApplied?.();
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ name: 'review' }));
    source.destroy();
  });
});
