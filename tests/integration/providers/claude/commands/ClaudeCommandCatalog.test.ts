import { DesktopVault } from '@test/helpers/core/DesktopVault';
import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';

const { resetMockMessages, setMockMessages, setMockSupportedCommands } = await vi.importActual<typeof import('@test/__mocks__/claude-agent-sdk')>('@anthropic-ai/claude-agent-sdk');

import { createCatalogCommandDiscoveryStore, toLoaderDiscovery } from '@/core/providers/commands/catalogCommandDiscovery';
import { normalizeProviderCommandDiscoveryItems } from '@/core/providers/commands/ProviderCommandDiscoveryResult';
import { ClaudeCommandCatalog } from '@/providers/claude/commands/ClaudeCommandCatalog';
import { probeRuntimeCommands } from '@/providers/claude/commands/probeRuntimeCommands';
import { SlashCommandSource } from '@/shared/composer-dropdown/SlashCommandSource';

let vault: DesktopVault;
beforeAll(async () => { vault = await DesktopVault.create(); });
afterAll(async () => { await vault.dispose(); });

beforeEach(() => resetMockMessages());

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
  setMockSupportedCommands(commands);
  setMockMessages([{ type: 'system', subtype: 'init', skills: ['debug', 'init', 'simplify', 'new', 'commit', 'documents:pdf', 'review'] }], { appendResult: false });
  const { host: providerHost } = await createProviderHostFixture({ vault,
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
    }))).toEqual([
      { id: 'sdk:debug', label: '/debug', detail: 'My debugging workflow', replacement: '/debug ' },
      { id: 'sdk:init', label: '/init', detail: 'My note initialization', replacement: '/init ' },
    ]);
    // Only a marked snapshot identifies Claude Code's own commands and the custom rows they shadow.
    expect(items.filter(item => item.label === '/cost' || item.label === '/simplify').map(item => item.detail))
      .toEqual(provenance === 'marked' ? [] : ['Native cost display', 'Shadowed custom workflow']);
    expect(items.filter(item => item.label === '/new')).toEqual([
      expect.objectContaining({ id: 'builtin:new' }),
    ]);
    expect(source.resolveCommandKind('/new', true)).toBe('command');
    expect(source.resolveCommandKind('/debug', true)).toBe('skill');
    const snapshot = discovery.getSnapshot();
    if (snapshot.status !== 'ready') throw new Error('Expected settled native command discovery');
    expect(snapshot.items.filter(entry => ['commit', 'compact', 'pdf', 'review'].includes(entry.name)))
      .toEqual([
        ['commit', 'Create a commit', '', 'skill', false],
        ['compact', 'Compact context', '<focus>', 'command', true],
        ['pdf', 'Work with PDFs', '', 'skill', false],
        ['review', 'Review changes', '', 'skill', true],
      ].filter(([, , , , builtin]) => provenance === 'legacy' || !builtin)
        .map(([name, description, argumentHint, kind]) => ({
          id: `sdk:${name}`, name, description, argumentHint, kind, content: '',
          providerId: 'claude', source: 'sdk', scope: 'runtime',
          isEditable: false, isDeletable: false, displayPrefix: '/', insertPrefix: '/',
        })));
    for (const name of provenance === 'marked' ? ['commit', 'pdf'] : ['commit', 'pdf', 'review']) {
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
      .toEqual({ source: 'sdk', isEditable: false, isDeletable: false });
    const debug = items.find(item => item.id === 'sdk:debug');
    expect(debug?.kind === 'value' ? source.select(debug, trigger) : undefined)
      .toEqual({ kind: 'replace', text: '/debug ' });
  } finally {
    source.destroy();
  }
});
