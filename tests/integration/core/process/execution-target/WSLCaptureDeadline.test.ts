// @test-ci {"native":true}
import * as fs from 'node:fs/promises';

import { captureShells, createWSLCaptureFixture } from '@test/helpers/WSLCaptureFixture';

for (const { name, executable } of captureShells) {
  it(`${name}-as-sh bounds a hanging startup and falls back with the original CLI umask`, { concurrent: true, skip: !executable, timeout: 15_000 }, async ({ onTestFinished }) => {
    const fixture = await createWSLCaptureFixture(executable, onTestFinished);
    try {
      await fixture.startup('export OPENAI_API_KEY=shell-key\nsleep 30');
      const result = await fixture.start().closed;
      expect(result.code).toBe(0);
      expect(result.stdout).toBe(`CLI_OK:base-key${process.umask().toString(8).padStart(4, '0')}\n`);
      expect(result.stderr.match(/Unable to capture WSL shell environment/g) ?? []).toHaveLength(1);
      const pid = await fixture.capturePid();
      expect(() => process.kill(pid, 0)).toThrow();
      await expect(fs.stat(await fixture.captureFile())).rejects.toThrow(/ENOENT/);
    } finally { await fixture.dispose(); }
  });
}
