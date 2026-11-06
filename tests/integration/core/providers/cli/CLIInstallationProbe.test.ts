// @test-ci {"native":true}
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

  it.skipIf(process.platform === 'win32')('probes a shell wrapper whose interpreter directory contains node', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'node-wrapper-'));
    try {
      const interpreter = path.join(directory, 'sh');
      fs.symlinkSync('/bin/sh', interpreter);
      const wrapper = path.join(directory, 'generated-cli');
      fs.writeFileSync(wrapper, `#!${interpreter}\nprintf 'generated-cli 4.5.6\\n'\n`, { mode: 0o755 });
      expect(await probeCLIInstallation({
        path: wrapper, configuredPath: wrapper, args: ['--version'], env: process.env,
      })).toEqual({ path: wrapper, source: 'custom', version: '4.5.6' });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    '#!/usr/bin/env node',
    '#!/usr/bin/env -S NODE_NO_WARNINGS=1 node',
  ])('probes an extensionless Node script through the Node runtime: %s', async (shebang) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'node-cli-probe-'));
    try {
      const script = path.join(directory, 'generated-cli');
      fs.writeFileSync(script, `${shebang}\nprocess.stdout.write("generated-cli 7.8.9\\n");\n`, { mode: 0o644 });
      expect(await probeCLIInstallation({
        path: script, configuredPath: script, args: ['--version'], env: process.env,
      })).toEqual({ path: script, source: 'custom', version: '7.8.9' });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
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
