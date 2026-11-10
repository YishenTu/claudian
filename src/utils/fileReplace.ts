import { rename } from 'node:fs/promises';

// Windows refuses a replacement while a reader, scanner, sync client or exiting process briefly holds the file.
const TRANSIENT_LOCK_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const MAX_ATTEMPTS = 5;

/** Renames `temporary` over `target`, retrying briefly while another process holds either file. */
export async function replaceFile(temporary: string, target: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await rename(temporary, target);
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS || !TRANSIENT_LOCK_CODES.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
      await new Promise(resolve => window.setTimeout(resolve, 20 * attempt));
    }
  }
}
