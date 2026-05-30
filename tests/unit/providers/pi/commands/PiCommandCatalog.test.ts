import { PiCommandCatalog } from '@/providers/pi/commands/PiCommandCatalog';

describe('PiCommandCatalog', () => {
  it('maps deduped runtime commands into slash dropdown entries', async () => {
    const catalog = new PiCommandCatalog();
    catalog.setRuntimeCommands([
      {
        argumentHint: '<topic>',
        content: '',
        description: 'Review changes',
        id: 'pi:prompt:review',
        name: '/review',
        source: 'sdk',
      },
      {
        content: '',
        description: 'Duplicate review',
        id: 'pi:prompt:review-duplicate',
        name: 'review',
        source: 'sdk',
      },
      {
        content: '',
        description: 'Skill command',
        id: 'pi:skill:test',
        kind: 'skill',
        name: 'test',
        source: 'sdk',
      },
    ]);

    await expect(catalog.listDropdownEntries({ includeBuiltIns: false })).resolves.toEqual([
      expect.objectContaining({
        argumentHint: '<topic>',
        description: 'Review changes',
        displayPrefix: '/',
        id: 'pi:prompt:review',
        insertPrefix: '/',
        isDeletable: false,
        isEditable: false,
        kind: 'command',
        name: 'review',
        providerId: 'pi',
        scope: 'runtime',
      }),
      expect.objectContaining({
        id: 'pi:skill:test',
        kind: 'skill',
        name: 'test',
        providerId: 'pi',
      }),
    ]);
  });

  it('uses slash triggers and rejects vault edits', async () => {
    const catalog = new PiCommandCatalog();

    expect(catalog.getDropdownConfig()).toEqual({
      builtInPrefix: '/',
      commandPrefix: '/',
      providerId: 'pi',
      skillPrefix: '/',
      triggerChars: ['/'],
    });
    await expect(catalog.listVaultEntries()).resolves.toEqual([]);
    await expect(catalog.saveVaultEntry({} as any)).rejects.toThrow('not editable');
    await expect(catalog.deleteVaultEntry({} as any)).rejects.toThrow('not deletable');
  });
});
