import { GrokCommandCatalog } from '@/providers/grok/commands/GrokCommandCatalog';

describe('GrokCommandCatalog', () => {
  it('preserves provider-advertised names, order, and case exactly', async () => {
    const catalog = new GrokCommandCatalog();
    catalog.setRuntimeCommands([
      { id: 'first', name: 'local:review', description: 'Review changes', content: '', source: 'sdk' },
      { id: 'duplicate', name: 'REVIEW', description: 'Duplicate', content: '', source: 'sdk' },
      { id: 'help', name: 'help', argumentHint: '[topic]', content: '', source: 'sdk' },
    ]);

    await expect(catalog.listDropdownEntries({ includeBuiltIns: true })).resolves.toEqual([
      expect.objectContaining({ id: 'first', name: 'local:review' }),
      expect.objectContaining({ id: 'duplicate', name: 'REVIEW' }),
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

  it('is runtime-only and has no hidden discovery mechanism', async () => {
    const catalog = new GrokCommandCatalog();

    expect(catalog).not.toHaveProperty('listVaultEntries');
    expect(catalog).not.toHaveProperty('saveVaultEntry');
    expect(catalog).not.toHaveProperty('deleteVaultEntry');
    expect(catalog).not.toHaveProperty('inspect');
    await expect(catalog.refresh()).resolves.toBeUndefined();
  });
});
