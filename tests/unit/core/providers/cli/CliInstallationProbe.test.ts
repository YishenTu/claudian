import { parseCliVersion } from '@/core/providers/cli/CliInstallationProbe';

describe('parseCliVersion', () => {
  it.each([
    ['cli 1.2.3\n', '1.2.3'],
    ['cli 1.2.3-beta.4+build.7\n', '1.2.3-beta.4+build.7'],
    ['warning: runtime 24\ncli 2.3.4', '2.3.4'],
    ['version unavailable', null],
    ['cli 1.2', null],
    [null, null],
  ])('extracts a complete version from %p', (output, expected) => {
    expect(parseCliVersion(output)).toBe(expected);
  });
});
