// @test-ci {"native":true}
import * as fs from 'node:fs/promises';

import { captureShells, createWSLCaptureFixture } from '@test/helpers/WSLCaptureFixture';

for (const { name, executable } of captureShells) {
  it.skipIf(!executable).each(['SHELLOPTS', 'UID', 'EUID'])(`${name}-as-sh survives importing exported readonly %s`, async key => {
    const fixture = await createWSLCaptureFixture(executable);
    try {
      await fixture.startup(`export ${key}\nexport OPENAI_API_KEY=shell-key`);
      const result = await fixture.start().closed;
      expect(result.code).toBe(0);
      expect(result.stdout).toBe(`CLI_OK:${name === 'bash' ? 'base' : 'shell'}-key${process.umask().toString(8).padStart(4, '0')}\n`);
      expect(result.stderr.match(/Unable to capture WSL shell environment/g) ?? []).toHaveLength(name === 'bash' ? 1 : 0);
      await expect(fs.stat(await fixture.captureFile())).rejects.toThrow(/ENOENT/);
    } finally { await fixture.dispose(); }
  });

  it.skipIf(!executable)(`${name}-as-sh attributes a missing CLI diagnostic to claudian`, async () => {
    const fixture = await createWSLCaptureFixture(executable);
    try {
      await fixture.startup('');
      const missing = `${fixture.root}/missing-cli`;
      const result = await fixture.start(missing).closed;
      expect(result.code).not.toBe(0);
      // The shell prefixes its own diagnostics with the script's $0.
      const diagnostics = result.stderr.split('\n').filter(line => line.includes(missing));
      expect(diagnostics.length).toBeGreaterThan(0);
      expect(diagnostics.filter(line => !line.startsWith('claudian: '))).toEqual([]);
    } finally { await fixture.dispose(); }
  });
}
