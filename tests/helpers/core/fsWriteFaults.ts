const actualModule0 = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
import type * as FsPromises from 'node:fs/promises';
import * as path from 'node:path';


interface WriteFault {
  folder: string;
  /** Written to the file before the failure, to simulate a torn write. */
  partial?: string;
}

const state = globalThis as typeof globalThis & { __claudianWriteFaults?: WriteFault[] };

/** Makes every `fs.writeFile` under `absoluteFolder` fail until cleared. */
export function failWritesUnder(absoluteFolder: string, partial?: string): void {
  (state.__claudianWriteFaults ??= []).push({ folder: path.resolve(absoluteFolder), partial });
}

export function clearWriteFaults(): void {
  state.__claudianWriteFaults = [];
}

/**
 * An async vi.mock factory can load this module with vi.importActual and call
 * createFsPromisesWithWriteFaults to route writes through the registered faults.
 */
export function createFsPromisesWithWriteFaults(): typeof FsPromises {
  const actual = actualModule0;
  const writeFile: typeof actual.writeFile = async (file, data, options) => {
    const target = path.resolve(String(file));
    const fault = state.__claudianWriteFaults?.find(candidate => target.startsWith(`${candidate.folder}${path.sep}`));
    if (fault) {
      if (fault.partial !== undefined) await actual.writeFile(file, fault.partial);
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    }
    return actual.writeFile(file, data, options);
  };
  return { ...actual, writeFile };
}
