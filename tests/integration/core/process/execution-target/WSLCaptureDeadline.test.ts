// @test-ci {"native":true}
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { captureShells, createWSLCaptureFixture, hasProcessGroups } from '@test/helpers/WSLCaptureFixture';

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

  it(`${name}-as-sh stops a TERM-resistant startup descendant on deadline`, { concurrent: true, skip: !executable || !hasProcessGroups, timeout: 15_000 }, async ({ onTestFinished }) => {
    const fixture = await createWSLCaptureFixture(executable, onTestFinished);
    try {
      await fixture.startup(`/bin/sh -c 'printf "%s" "$$" > "$HOME/blocking-pid.tmp"; mv "$HOME/blocking-pid.tmp" "$HOME/blocking-pid"; trap "" TERM; exec tail -f /dev/null'`);
      const result = await fixture.start().closed;
      expect(result.code).toBe(0);
      expect(result.stdout).toBe(`CLI_OK:base-key${process.umask().toString(8).padStart(4, '0')}\n`);
      const pid = Number(await fs.readFile(path.join(fixture.root, 'blocking-pid'), 'utf8'));
      await vi.waitFor(async () => {
        const status = await fs.readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
        expect(status === '' || /\) Z /.test(status), `Startup child has not exited: ${status}`).toBe(true);
      });
      await expect(fs.stat(await fixture.captureFile())).rejects.toThrow(/ENOENT/);
    } finally { await fixture.dispose(); }
  });
}
