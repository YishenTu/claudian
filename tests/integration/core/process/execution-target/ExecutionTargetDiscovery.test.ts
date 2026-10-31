// @test-ci {"native":true}
import { createWSLDistroFixture } from '@test/helpers/WSLProcessFixture';

import { resolveExecutionTarget, resolveExecutionTargetAsync } from '@/core/process/execution-target/ExecutionTargetResolver';

it.skipIf(process.platform === 'win32')('discovers the default distro through real sync and async process boundaries and tolerates command failure', async () => {
  const fixture = await createWSLDistroFixture(Buffer.from('\uFEFF  NAME  STATE  VERSION\r\n* My Ubuntu  Running  2\r\n', 'utf16le'));
  const options = { hostPlatform: 'win32' as const, settings: { installationMethod: 'wsl' as const, wslDistroOverride: '' } };
  const expected = { method: 'wsl', platformFamily: 'unix', platformOs: 'linux', distroName: 'My Ubuntu' };
  expect(resolveExecutionTarget(options)).toEqual(expected);
  expect(await resolveExecutionTargetAsync(options)).toEqual(expected);
  await fixture.fail();
  expect(resolveExecutionTarget(options)).toEqual({ ...expected, distroName: undefined });
  expect(await resolveExecutionTargetAsync(options)).toEqual({ ...expected, distroName: undefined });
});

it.skipIf(process.platform === 'win32')('bounds synchronous distro discovery before a late list response', async () => {
  const fixture = await createWSLDistroFixture(Buffer.from('* Ubuntu  Running  2', 'utf16le'));
  await fixture.delay(6_000);
  expect(resolveExecutionTarget({
    hostPlatform: 'win32', settings: { installationMethod: 'wsl', wslDistroOverride: '' },
  }).distroName).toBeUndefined();
}, 10_000);
