import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';

import { createCatalogCommandDiscoveryStore, toLoaderDiscovery } from '@/core/providers/commands/catalogCommandDiscovery';
import { normalizeProviderCommandDiscoveryItems } from '@/core/providers/commands/ProviderCommandDiscoveryResult';
import { ClaudeCommandCatalog } from '@/providers/claude/commands/ClaudeCommandCatalog';
import { probeRuntimeCommands } from '@/providers/claude/commands/probeRuntimeCommands';
import { SlashCommandSource } from '@/shared/composer-dropdown/SlashCommandSource';

const mockQuery = vi.fn();
vi.mock('@/providers/claude/loadClaudeAgentSDK', () => ({ loadClaudeAgentQuery: async () => mockQuery }));

it.each(['marked', 'legacy'] as const)('preserves command ownership through the %s native picker snapshot', async provenance => {
  // Current SDK: builtin is true only for native rows; absent for user/project/plugin/MCP rows.
  const nativeMarker = provenance === 'marked' ? { builtin: true } : {};
  const commands = [
    { name: 'debug', description: 'My debugging workflow', argumentHint: '' },
    { name: 'init', description: 'My note initialization', argumentHint: '' },
    { name: 'cost', description: 'Native cost display', argumentHint: '', ...nativeMarker },
    { name: 'simplify', description: 'Shadowed custom workflow', argumentHint: '' },
    { name: 'simplify', description: 'Native workflow owns this name', argumentHint: '', ...nativeMarker },
    { name: 'new', description: 'Custom new workflow', argumentHint: '' },
    { name: 'commit', description: 'Create a commit', argumentHint: '' },
    { name: 'compact', description: 'Compact context', argumentHint: '<focus>', ...nativeMarker },
    { name: 'pdf', description: 'Work with PDFs', argumentHint: '' },
    { name: 'review', description: 'Review changes', argumentHint: '', ...nativeMarker },
  ];
  const nativeQuery = {
    initializationResult: async () => ({ commands: [] }),
    supportedCommands: async () => commands,
    next: vi.fn().mockResolvedValue({ done: false, value: {
      type: 'system', subtype: 'init', skills: ['debug', 'init', 'simplify', 'new', 'commit', 'documents:pdf', 'review'],
    } }),
    close: vi.fn(),
  };
  mockQuery.mockReturnValue(nativeQuery);
  const { host: providerHost } = await createProviderHostFixture({
    overrides: { workingDirectory: '/test/vault', getResolvedProviderCliPath: async () => '/mock/claude' },
  });
  const host = providerHost.getRuntimeHost('claude');
  const catalog = new ClaudeCommandCatalog();
  expect(catalog.getDropdownConfig()).toMatchObject({
    triggerChars: ['/'], builtInPrefix: '/', skillPrefix: '/', commandPrefix: '/',
  });
  const discovery = createCatalogCommandDiscoveryStore(catalog, async signal =>
    toLoaderDiscovery(normalizeProviderCommandDiscoveryItems(await probeRuntimeCommands(host, signal))),
  );
  await discovery.load();
  const source = new SlashCommandSource({ providerConfig: catalog.getDropdownConfig(), providerDiscovery: discovery });
  try {
    const trigger = source.match('/', 1)!;
    const items = source.load(trigger, new AbortController().signal);
    expect(items.filter(item => item.id === 'sdk:debug' || item.id === 'sdk:init').map(item => ({
      id: item.id, label: item.label, detail: item.detail, replacement: item.kind === 'value' ? item.replacement : undefined,
    }))).toEqual(provenance === 'marked' ? [
      { id: 'sdk:debug', label: '/debug', detail: 'My debugging workflow', replacement: '/debug ' },
      { id: 'sdk:init', label: '/init', detail: 'My note initialization', replacement: '/init ' },
    ] : []);
    expect(items.filter(item => item.label === '/cost' || item.label === '/simplify')).toEqual([]);
    expect(items.filter(item => item.label === '/new')).toEqual([
      expect.objectContaining({ id: 'builtin:new' }),
    ]);
    expect(source.resolveCommandKind('/new', true)).toBe('command');
    expect(source.resolveCommandKind('/debug', true)).toBe(provenance === 'marked' ? 'skill' : null);
    const snapshot = discovery.getSnapshot();
    if (snapshot.status !== 'ready') throw new Error('Expected settled native command discovery');
    expect(snapshot.items.filter(entry => ['commit', 'compact', 'pdf', 'review'].includes(entry.name)))
      .toEqual([
        ['commit', 'Create a commit', '', 'skill', false],
        ['compact', 'Compact context', '<focus>', 'command', true],
        ['pdf', 'Work with PDFs', '', 'skill', false],
        ['review', 'Review changes', '', 'skill', true],
      ].map(([name, description, argumentHint, kind, builtin]) => ({
        id: `sdk:${name}`, name, description, argumentHint, kind, content: '',
        providerId: 'claude',
        source: builtin && provenance === 'marked' ? 'builtin' : 'sdk',
        scope: builtin && provenance === 'marked' ? 'builtin' : 'runtime',
        isEditable: false, isDeletable: false, displayPrefix: '/', insertPrefix: '/',
      })));
    for (const name of ['commit', 'pdf', 'review']) {
      const item = items.find(item => item.id === `sdk:${name}`);
      expect(item).toMatchObject({ label: `/${name}`, kind: 'value' });
      expect(item?.kind === 'value' ? source.select(item, trigger) : undefined)
        .toEqual({ kind: 'replace', text: `/${name} ` });
    }
    const newItem = items.find(item => item.id === 'builtin:new');
    expect(newItem?.kind === 'value' ? source.select(newItem, trigger) : undefined)
      .toEqual({ kind: 'replace', text: '/new ' });
    const debugEntry = snapshot.items.find(entry => entry.name === 'debug');
    expect(debugEntry && { source: debugEntry.source, isEditable: debugEntry.isEditable, isDeletable: debugEntry.isDeletable })
      .toEqual(provenance === 'marked' ? { source: 'sdk', isEditable: false, isDeletable: false } : undefined);
    const debug = items.find(item => item.id === 'sdk:debug');
    const selected = debug?.kind === 'value' ? source.select(debug, trigger) : undefined;
    expect(selected).toEqual(provenance === 'marked' ? { kind: 'replace', text: '/debug ' } : undefined);
  } finally {
    source.destroy();
  }
});
