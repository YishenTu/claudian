import { PiCommandCatalog } from '@/providers/pi/commands/PiCommandCatalog';

describe('PiCommandCatalog', () => {
  it('maps runtime commands into slash dropdown entries without changing order', async () => {
    const catalog = new PiCommandCatalog();
    catalog.setCommandSnapshot([
      {
        argumentHint: '<topic>',
        content: '',
        description: 'Review changes',
        id: 'pi:prompt:review',
        name: 'skill:shared-review',
        source: 'sdk',
      },
      {
        content: '',
        description: 'Duplicate review',
        id: 'pi:prompt:review-duplicate',
        name: 'skill:shared-review',
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
      { content: '', id: 'two', name: 'scope:qualified', source: 'sdk' },
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
        name: 'skill:shared-review',
        providerId: 'pi',
        scope: 'runtime',
      }),
      expect.objectContaining({
        description: 'Duplicate review',
        id: 'pi:prompt:review-duplicate',
        name: 'skill:shared-review',
        providerId: 'pi',
      }),
      expect.objectContaining({
        id: 'pi:skill:test',
        kind: 'skill',
        name: 'test',
        providerId: 'pi',
      }),
      expect.objectContaining({
        id: 'two',
        name: 'scope:qualified',
        providerId: 'pi',
      }),
    ]);
  });

  it('uses slash triggers without exposing editable vault operations', () => {
    const catalog = new PiCommandCatalog();

    expect(catalog.getDropdownConfig()).toEqual({
      builtInPrefix: '/',
      commandPrefix: '/',
      discoveryTimeoutMs: 'provider-owned',
      providerId: 'pi',
      skillPrefix: '/',
      triggerChars: ['/'],
    });
    expect('listVaultEntries' in catalog).toBe(false);
    expect('saveVaultEntry' in catalog).toBe(false);
    expect('deleteVaultEntry' in catalog).toBe(false);
  });
});
