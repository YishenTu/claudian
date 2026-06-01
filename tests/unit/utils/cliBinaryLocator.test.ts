import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { findCliBinaryPath, resolveConfiguredCliPath } from '@/utils/cliBinaryLocator';

describe('cliBinaryLocator', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-binary-locator-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('resolves configured CLI files', () => {
    const cliPath = path.join(tempDir, 'pi');
    fs.writeFileSync(cliPath, '');

    expect(resolveConfiguredCliPath(cliPath)).toBe(cliPath);
  });

  it('finds Windows npm .cmd shims on a PATH entry', () => {
    const binDir = path.join(tempDir, 'bin');
    const shimPath = path.join(binDir, 'pi.cmd');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(shimPath, '');

    expect(findCliBinaryPath('pi', binDir, 'win32')).toBe(shimPath);
  });
});
