import { TFile, TFolder } from 'obsidian';

import {
  buildDroppedMention,
  extractDroppedPaths,
  resolveDroppedVaultItems,
} from '@/features/chat/ui/dragDrop';

function createDataTransfer(data: Record<string, string>, files: Array<{ path?: string }> = []): DataTransfer {
  return {
    getData: (type: string) => data[type] ?? '',
    files,
  } as unknown as DataTransfer;
}

describe('drag and drop vault context helpers', () => {
  it('extracts paths from Obsidian URI, JSON, and native file payloads', () => {
    const dataTransfer = createDataTransfer(
      {
        'text/uri-list': 'obsidian://open?vault=Creative%20Vault&file=Notes%2FOne.md',
        'application/json': JSON.stringify({ paths: ['Notes/Two.md', 'Projects'] }),
      },
      [{ path: 'C:/Vault/Notes/Three.md' }],
    );

    expect(extractDroppedPaths(dataTransfer)).toEqual([
      'Notes/Two.md',
      'Projects',
      'Notes/One.md',
      'C:/Vault/Notes/Three.md',
    ]);
  });

  it('resolves only files and folders that belong to the current vault', () => {
    const files = {
      'Notes/One.md': new (TFile as any)('Notes/One.md'),
      Projects: new (TFolder as any)('Projects'),
    };
    const app = {
      vault: {
        adapter: { basePath: 'C:/Vault' },
        getAbstractFileByPath: (path: string) => files[path as keyof typeof files] ?? null,
      },
    } as any;

    expect(resolveDroppedVaultItems(app, ['C:/Vault/Notes/One.md', 'Projects', 'C:/Other/nope'])).toEqual([
      { kind: 'file', path: 'Notes/One.md' },
      { kind: 'folder', path: 'Projects' },
    ]);
  });

  it('formats dropped items as composer mentions', () => {
    expect(buildDroppedMention({ kind: 'file', path: 'Notes/One.md' })).toBe('@Notes/One.md ');
    expect(buildDroppedMention({ kind: 'folder', path: 'Projects' })).toBe('@Projects/ ');
  });
});
