import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { App } from 'obsidian';

import { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';

/**
 * A real temporary vault on disk behind a minimal filesystem-backed Obsidian
 * adapter, for behavior that depends on real folders and links. Adapter methods
 * mirror Obsidian's desktop FileSystemAdapter (recursive mkdir, `fs.rm` rmdir,
 * link-following list).
 */
export class DesktopVault {
  readonly trashed: string[] = [];
  readonly files: VaultFileAdapter;

  private constructor(readonly root: string) {
    const resolve = (relativePath: string) => this.resolve(relativePath);
    const adapter = {
      getBasePath: () => root,
      exists: async (relativePath: string) => fs.lstat(resolve(relativePath)).then(() => true, () => false),
      stat: async (relativePath: string) => {
        const stat = await fs.stat(resolve(relativePath)).catch(() => null);
        return stat ? { type: stat.isDirectory() ? 'folder' : 'file', ctime: 0, mtime: stat.mtimeMs, size: stat.size } : null;
      },
      list: async (relativePath: string) => {
        const listing = { files: [] as string[], folders: [] as string[] };
        for (const name of await fs.readdir(resolve(relativePath))) {
          const child = `${relativePath}/${name}`;
          // Like Obsidian, a dangling link rejects the whole listing.
          const stat = await fs.stat(resolve(child));
          if (stat.isFile()) listing.files.push(child);
          if (stat.isDirectory()) listing.folders.push(child);
        }
        return listing;
      },
      mkdir: async (relativePath: string) => {
        await fs.mkdir(resolve(relativePath), { recursive: true });
      },
      read: async (relativePath: string) => fs.readFile(resolve(relativePath), 'utf8'),
      readBinary: async (relativePath: string) => {
        const bytes = await fs.readFile(resolve(relativePath));
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
      write: async (relativePath: string, content: string) => fs.writeFile(resolve(relativePath), content, 'utf8'),
      remove: async (relativePath: string) => fs.unlink(resolve(relativePath)),
      rmdir: async (relativePath: string, recursive: boolean) => (
        fs.rm(resolve(relativePath), { maxRetries: 5, recursive })
      ),
      rename: async (source: string, target: string) => fs.rename(resolve(source), resolve(target)),
      trashSystem: async (relativePath: string) => {
        this.trashed.push(relativePath);
        await fs.rm(resolve(relativePath), { recursive: true });
        return true;
      },
      trashLocal: async () => {
        throw new Error('Unexpected local trash');
      },
    };
    this.files = new VaultFileAdapter({ vault: { adapter } } as unknown as App);
  }

  static async create(): Promise<DesktopVault> {
    return new DesktopVault(await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-vault-'))));
  }

  resolve(relativePath: string): string {
    return path.join(this.root, ...relativePath.split('/'));
  }

  async write(relativePath: string, content: string): Promise<void> {
    await fs.mkdir(path.dirname(this.resolve(relativePath)), { recursive: true });
    await fs.writeFile(this.resolve(relativePath), content, 'utf8');
  }

  async writeBytes(relativePath: string, bytes: Uint8Array): Promise<void> {
    await fs.mkdir(path.dirname(this.resolve(relativePath)), { recursive: true });
    await fs.writeFile(this.resolve(relativePath), bytes);
  }

  async mkdir(relativePath: string): Promise<void> {
    await fs.mkdir(this.resolve(relativePath), { recursive: true });
  }

  read(relativePath: string): Promise<string> {
    return fs.readFile(this.resolve(relativePath), 'utf8');
  }

  async exists(relativePath: string): Promise<boolean> {
    return fs.lstat(this.resolve(relativePath)).then(() => true, () => false);
  }

  async symlink(relativePath: string, absoluteTarget: string): Promise<void> {
    await fs.mkdir(path.dirname(this.resolve(relativePath)), { recursive: true });
    await fs.symlink(absoluteTarget, this.resolve(relativePath));
  }

  readlink(relativePath: string): Promise<string> {
    return fs.readlink(this.resolve(relativePath));
  }

  async dispose(): Promise<void> {
    await fs.rm(this.root, { recursive: true, force: true });
  }
}
