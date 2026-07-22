import { OpencodeCommandCatalog } from '@/providers/opencode/commands/OpencodeCommandCatalog';

describe('OpencodeCommandCatalog', () => {
  it('maps runtime commands into slash dropdown entries', async () => {
    const catalog = new OpencodeCommandCatalog();
    catalog.setRuntimeCommands([
      {
        id: 'acp:review',
        name: 'review',
        description: 'Review the current changes',
        argumentHint: '$1',
        content: '',
        source: 'sdk',
      },
      {
        id: 'acp:review-duplicate',
        name: 'review',
        description: 'Duplicate entry',
        content: '',
        source: 'sdk',
      },
      {
        id: 'acp:fix',
        name: 'fix',
        description: 'Apply a fix',
        content: '',
        source: 'sdk',
      },
    ]);

    await expect(catalog.listDropdownEntries({ includeBuiltIns: false })).resolves.toEqual([
      {
        id: 'acp:review',
        providerId: 'opencode',
        kind: 'command',
        name: 'review',
        description: 'Review the current changes',
        content: '',
        argumentHint: '$1',
        scope: 'runtime',
        source: 'sdk',
        isEditable: false,
        isDeletable: false,
        displayPrefix: '/',
        insertPrefix: '/',
      },
      {
        id: 'acp:review-duplicate',
        providerId: 'opencode',
        kind: 'command',
        name: 'review',
        description: 'Duplicate entry',
        content: '',
        scope: 'runtime',
        source: 'sdk',
        isEditable: false,
        isDeletable: false,
        displayPrefix: '/',
        insertPrefix: '/',
      },
      {
        id: 'acp:fix',
        providerId: 'opencode',
        kind: 'command',
        name: 'fix',
        description: 'Apply a fix',
        content: '',
        scope: 'runtime',
        source: 'sdk',
        isEditable: false,
        isDeletable: false,
        displayPrefix: '/',
        insertPrefix: '/',
      },
    ]);
  });

  it('uses slash triggers for the shared dropdown', () => {
    const catalog = new OpencodeCommandCatalog();

    expect(catalog.getDropdownConfig()).toEqual({
      providerId: 'opencode',
      triggerChars: ['/'],
      builtInPrefix: '/',
      skillPrefix: '/',
      commandPrefix: '/',
    });
    expect('listVaultEntries' in catalog).toBe(false);
    expect('saveVaultEntry' in catalog).toBe(false);
    expect('deleteVaultEntry' in catalog).toBe(false);
  });

  it('preserves ACP names and ordering', async () => {
    const catalog = new OpencodeCommandCatalog();
    catalog.setRuntimeCommands([
      { content: '', id: 'one', name: 'local:shared-review', source: 'sdk' },
      { content: '', id: 'two', name: 'shared-review', source: 'sdk' },
    ]);

    const entries = await catalog.listDropdownEntries({ includeBuiltIns: false });

    expect(entries.map((entry) => entry.name)).toEqual([
      'local:shared-review',
      'shared-review',
    ]);
  });
});
