import { RuntimeCommandCatalog } from '@/core/providers/commands/RuntimeCommandCatalog';
import type { SlashCommand } from '@/core/types';

function createCatalog(): RuntimeCommandCatalog {
  return new RuntimeCommandCatalog({
    dropdownConfig: {
      builtInPrefix: '/',
      commandPrefix: '/',
      providerId: 'pi',
      skillPrefix: '/',
      triggerChars: ['/'],
    },
    projectEntry: (command) => ({
      content: command.content,
      displayPrefix: '/',
      hooks: command.hooks,
      id: command.id,
      insertPrefix: '/',
      isDeletable: false,
      isEditable: false,
      kind: command.kind ?? 'command',
      name: command.name,
      providerId: 'pi',
      scope: 'runtime',
      source: command.source ?? 'sdk',
    }),
  });
}

describe('RuntimeCommandCatalog', () => {
  it('defensively clones snapshots on input and output', async () => {
    const catalog = createCatalog();
    const command: SlashCommand = {
      allowedTools: ['Read'],
      content: '',
      hooks: { nested: { value: 'original' } },
      id: 'pi:skill:test',
      kind: 'skill',
      name: 'test',
      source: 'sdk',
    };
    catalog.setCommandSnapshot([command]);
    command.name = 'mutated input';
    command.allowedTools?.push('Write');
    (command.hooks?.nested as { value: string }).value = 'mutated input';

    const first = await catalog.listDropdownEntries({ includeBuiltIns: false });
    expect(first).toEqual([
      expect.objectContaining({
        hooks: { nested: { value: 'original' } },
        kind: 'skill',
        name: 'test',
      }),
    ]);
    first[0].name = 'mutated output';
    (first[0].hooks?.nested as { value: string }).value = 'mutated output';

    await expect(catalog.listDropdownEntries({ includeBuiltIns: false })).resolves.toEqual([
      expect.objectContaining({
        hooks: { nested: { value: 'original' } },
        name: 'test',
      }),
    ]);
  });

  it('handles empty, cached, request-scoped, and repeated snapshots stably', async () => {
    const catalog = createCatalog();
    const first = { content: '', id: 'first', name: 'first' };
    const second = { content: '', id: 'second', name: 'second' };

    await expect(catalog.listDropdownEntries({ includeBuiltIns: false })).resolves.toEqual([]);
    catalog.setCommandSnapshot([first, second]);
    catalog.setCommandSnapshot([first, second]);
    await expect(catalog.listDropdownEntries({ includeBuiltIns: false })).resolves.toEqual([
      expect.objectContaining({ id: 'first', name: 'first' }),
      expect.objectContaining({ id: 'second', name: 'second' }),
    ]);
    await expect(catalog.listDropdownEntries({
      allowCachedCommandSnapshot: false,
      includeBuiltIns: false,
    })).resolves.toEqual([]);
    await expect(catalog.listDropdownEntries({
      commandSnapshot: [second, first],
      includeBuiltIns: false,
    })).resolves.toEqual([
      expect.objectContaining({ id: 'second' }),
      expect.objectContaining({ id: 'first' }),
    ]);

    catalog.setCommandSnapshot([]);
    await expect(catalog.listDropdownEntries({ includeBuiltIns: false })).resolves.toEqual([]);
  });

  it('returns a defensive dropdown configuration and keeps refresh a no-op', async () => {
    const catalog = createCatalog();
    const config = catalog.getDropdownConfig();
    config.triggerChars.push('@');

    expect(catalog.getDropdownConfig()).toEqual({
      builtInPrefix: '/',
      commandPrefix: '/',
      providerId: 'pi',
      skillPrefix: '/',
      triggerChars: ['/'],
    });
    await expect(catalog.refresh()).resolves.toBeUndefined();
  });
});
