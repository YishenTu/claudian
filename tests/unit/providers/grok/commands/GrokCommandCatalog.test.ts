import type { ProviderCommandEntry } from '@/core/providers/commands/ProviderCommandEntry';
import { GrokCommandCatalog } from '@/providers/grok/commands/GrokCommandCatalog';

describe('GrokCommandCatalog', () => {
  it('deduplicates runtime commands case-insensitively and strips leading slashes', async () => {
    const catalog = new GrokCommandCatalog();
    catalog.setRuntimeCommands([
      { id: 'first', name: '/review', description: 'Review changes', content: '', source: 'sdk' },
      { id: 'duplicate', name: 'REVIEW', description: 'Duplicate', content: '', source: 'sdk' },
      { id: 'help', name: '///help', argumentHint: '[topic]', content: '', source: 'sdk' },
      { id: 'empty', name: '///', content: '', source: 'sdk' },
    ]);

    await expect(catalog.listDropdownEntries({ includeBuiltIns: true })).resolves.toEqual([
      expect.objectContaining({ id: 'first', name: 'review' }),
      expect.objectContaining({ id: 'help', name: 'help', argumentHint: '[topic]' }),
    ]);
  });

  it('exposes runtime-only non-editable command entries and slash dropdown behavior', async () => {
    const catalog = new GrokCommandCatalog();
    catalog.setRuntimeCommands([
      { id: 'acp:compact', name: 'compact', description: 'Compact context', content: '' },
    ]);

    const entries = await catalog.listDropdownEntries({ includeBuiltIns: false });
    expect(entries).toEqual([{
      id: 'acp:compact',
      providerId: 'grok',
      kind: 'command',
      name: 'compact',
      description: 'Compact context',
      content: '',
      argumentHint: undefined,
      allowedTools: undefined,
      model: undefined,
      disableModelInvocation: undefined,
      userInvocable: undefined,
      context: undefined,
      agent: undefined,
      hooks: undefined,
      scope: 'runtime',
      source: 'sdk',
      isEditable: false,
      isDeletable: false,
      displayPrefix: '/',
      insertPrefix: '/',
    }]);
    expect(catalog.getDropdownConfig()).toEqual({
      providerId: 'grok',
      triggerChars: ['/'],
      builtInPrefix: '/',
      skillPrefix: '/',
      commandPrefix: '/',
    });
  });

  it('has no vault persistence or hidden discovery session', async () => {
    const catalog = new GrokCommandCatalog();
    const entry = {} as ProviderCommandEntry;

    await expect(catalog.listVaultEntries()).resolves.toEqual([]);
    await expect(catalog.saveVaultEntry(entry)).rejects.toThrow(
      'Grok runtime commands are not editable from Claudian.',
    );
    await expect(catalog.deleteVaultEntry(entry)).rejects.toThrow(
      'Grok runtime commands are not deletable from Claudian.',
    );
    await expect(catalog.refresh()).resolves.toBeUndefined();
  });
});
