import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { probeCLIInstallation } from '@/core/providers/cli/CLIInstallationProbe';

describe('CLI installation probe', () => {
  it('reports the resolved binary and the version returned by its command', async () => {
    const result = await probeCLIInstallation({
      path: process.execPath,
      configuredPath: process.execPath,
      args: ['-e', 'process.stdout.write("test-cli 1.2.3-beta.4\\n")'],
      env: process.env,
    });
    expect(result).toEqual({ path: process.execPath, source: 'custom', version: '1.2.3-beta.4' });
  });

  it('keeps a found binary when the version command fails', async () => {
    const result = await probeCLIInstallation({
      path: process.execPath,
      configuredPath: '',
      args: ['-e', 'process.exit(1)'],
      env: process.env,
    });
    expect(result).toEqual({ path: process.execPath, source: 'auto', version: null });
  });

  it('does not report a nonexistent configured binary as found', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-installation-'));
    try {
      expect(await probeCLIInstallation({ path: path.join(directory, 'missing'), configuredPath: '', args: ['--version'], env: process.env }))
        .toEqual({ path: null, source: 'auto', version: null });
    } finally {
      fs.rmSync(directory, { recursive: true });
    }
  });
});
