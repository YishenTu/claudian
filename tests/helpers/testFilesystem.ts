import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export interface TestFileHandle {
  filePath: string;
  cleanup: () => void;
}

/**
 * Creates a file outside the operating system temp roots without touching the
 * user's home directory. This is useful for path-trust tests that need an
 * intentionally untrusted location.
 */
export function createUntrustedTestFile(fileName: string): TestFileHandle {
  const directory = mkdtempSync(join(process.cwd(), '.claudian-untrusted-'));
  const filePath = join(directory, fileName);
  let cleaned = false;

  return {
    filePath,
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
