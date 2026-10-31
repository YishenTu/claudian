// @test-ci {"native":true}
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { captureShells, createWSLCaptureFixture, hasProcessGroups } from '@test/helpers/WSLCaptureFixture';

import { runProcessProbe } from '@/core/process/ProcessProbe';

for (const { name, executable } of captureShells) {
  describe.skipIf(!executable)(`${name}-as-sh capture cancellation`, () => {
    it('reaps capture on a production probe timeout before removing its private file', async () => {
      const fixture = await createWSLCaptureFixture(executable);
      try {
        await fixture.startup('export OPENAI_API_KEY=fixture-key-only\nsleep 0.8');
        expect(await runProcessProbe(fixture.launchOptions(), 300)).toBeNull();
        const pid = await fixture.capturePid();
        expect(() => process.kill(pid, 0)).toThrow();
        await expect(fs.stat(await fixture.captureFile())).rejects.toThrow(/ENOENT/);
      } finally { await fixture.dispose(); }
    });

    it.each(['SIGHUP', 'SIGINT', 'SIGTERM'] as const)('cleans up capture on %s without leaving a late writer', async signal => {
      const fixture = await createWSLCaptureFixture(executable);
      try {
        await fixture.startup('sleep 0.5');
        const { child, closed } = fixture.start();
        const file = await fixture.captureFile();
        child.kill(signal);
        await closed;
        const pid = await fixture.capturePid();
        expect(() => process.kill(pid, 0)).toThrow();
        await expect(fs.stat(file)).rejects.toThrow(/ENOENT/);
      } finally { await fixture.dispose(); }
    });

    it.skipIf(!hasProcessGroups)('stops a TERM-resistant startup descendant on cancellation', async () => {
      const fixture = await createWSLCaptureFixture(executable);
      try {
        await fixture.startup(`/bin/sh -c 'printf "%s" "$$" > "$HOME/blocking-pid.tmp"; mv "$HOME/blocking-pid.tmp" "$HOME/blocking-pid"; trap "" TERM; exec tail -f /dev/null'`);
        expect(await runProcessProbe(fixture.launchOptions(), 300)).toBeNull();
        const pid = Number(await fs.readFile(path.join(fixture.root, 'blocking-pid'), 'utf8'));
        // Observe kernel exit; PID 1 may retain an already dead orphan as a zombie.
        await vi.waitFor(async () => {
          const status = await fs.readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
          expect(status === '' || /\) Z /.test(status), `Startup child has not exited: ${status}`).toBe(true);
        });
        await expect(fs.stat(await fixture.captureFile())).rejects.toThrow(/ENOENT/);
      } finally { await fixture.dispose(); }
    });
  });
}
