import { lstat, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';

export interface DurablePrivateFileErrors {
  readonly invalidFile: () => Error;
  readonly writeFailed: () => Error;
}

export async function writeDurablePrivateFile(
  filePath: string,
  contents: string | Uint8Array,
  errors: DurablePrivateFileErrors,
): Promise<void> {
  const partialPath = `${filePath}.partial`;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let invalidFileError: Error | null = null;
  try {
    await rm(partialPath, { force: true });
    handle = await open(partialPath, 'wx', 0o600);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(partialPath, filePath);
    const promoted = await lstat(filePath);
    if (!promoted.isFile() || promoted.isSymbolicLink()) {
      invalidFileError = errors.invalidFile();
      throw invalidFileError;
    }
    const directory = await open(path.dirname(filePath), 'r').catch(() => null);
    await directory?.sync().catch(() => undefined);
    await directory?.close().catch(() => undefined);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(partialPath, { force: true }).catch(() => undefined);
    if (error === invalidFileError) throw error;
    throw errors.writeFailed();
  }
}
