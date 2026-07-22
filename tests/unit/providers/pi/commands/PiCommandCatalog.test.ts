import { PiCommandCatalog } from '@/providers/pi/commands/PiCommandCatalog';

describe('PiCommandCatalog', () => {
  it('maps runtime commands into slash dropdown entries without changing order', async () => {
    const catalog = new PiCommandCatalog();
    catalog.setRuntimeCommands([
      {
        argumentHint: '<topic>',
        content: '',
        description: 'Review changes',
        id: 'pi:prompt:review',
        name: 'review',
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
        description: 'Duplicate review',
        id: 'pi:prompt:review-duplicate',
        name: 'review',
        providerId: 'pi',
      }),
      expect.objectContaining({
        id: 'pi:skill:test',
        kind: 'skill',
        name: 'test',
        providerId: 'pi',
      }),
    ]);
  });

  it('uses slash triggers without exposing editable vault operations', () => {
    const catalog = new PiCommandCatalog();

    expect(catalog.getDropdownConfig()).toEqual({
      builtInPrefix: '/',
      commandPrefix: '/',
      providerId: 'pi',
      skillPrefix: '/',
      triggerChars: ['/'],
    });
    expect('listVaultEntries' in catalog).toBe(false);
    expect('saveVaultEntry' in catalog).toBe(false);
    expect('deleteVaultEntry' in catalog).toBe(false);
  });

  it('preserves provider-advertised names and order', async () => {
    const catalog = new PiCommandCatalog();
    catalog.setRuntimeCommands([
      { content: '', id: 'one', name: 'skill:shared-review', source: 'sdk' },
      { content: '', id: 'two', name: 'scope:qualified', source: 'sdk' },
    ]);

    const entries = await catalog.listDropdownEntries({ includeBuiltIns: false });

    expect(entries.map((entry) => entry.name)).toEqual([
      'skill:shared-review',
      'scope:qualified',
    ]);
  });
});
