import type * as osType from 'os';
import type * as pathType from 'path';

const os = jest.requireActual<typeof osType>('os');
const path = jest.requireActual<typeof pathType>('path');

import { normalizeConfiguredCLIPath, parsePathEntries } from '@/core/process/cliPath';

const isWindows = process.platform === 'win32';

describe('parsePathEntries', () => {
  it('returns empty array for undefined', () => {
    expect(parsePathEntries(undefined)).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(parsePathEntries('')).toEqual([]);
  });

  it('splits on platform separator', () => {
    const sep = isWindows ? ';' : ':';
    const entries = isWindows ? ['C:\\alpha', 'D:\\beta', 'E:\\gamma'] : ['/alpha', '/beta', '/gamma'];
    expect(parsePathEntries(entries.join(sep))).toEqual(entries);
  });

  it('filters out empty segments', () => {
    const sep = isWindows ? ';' : ':';
    const result = parsePathEntries(`${sep}/a${sep}${sep}/b${sep}`);
    expect(result).toEqual(isWindows ? ['A:', 'B:'] : ['/a', '/b']);
  });

  it('filters out $PATH placeholder', () => {
    const sep = isWindows ? ';' : ':';
    const result = parsePathEntries(`/a${sep}$PATH${sep}/b`);
    expect(result).toEqual(isWindows ? ['A:', 'B:'] : ['/a', '/b']);
  });

  it('filters out ${PATH} placeholder', () => {
    const sep = isWindows ? ';' : ':';
    const result = parsePathEntries(`/a${sep}\${PATH}${sep}/b`);
    expect(result).toEqual(isWindows ? ['A:', 'B:'] : ['/a', '/b']);
  });

  it('filters out %PATH% placeholder', () => {
    const sep = isWindows ? ';' : ':';
    const result = parsePathEntries(`/a${sep}%PATH%${sep}/b`);
    expect(result).toEqual(isWindows ? ['A:', 'B:'] : ['/a', '/b']);
  });

  it('strips surrounding double quotes', () => {
    const sep = isWindows ? ';' : ':';
    const result = parsePathEntries(`"/quoted/path"${sep}/normal`);
    expect(result[0]).toBe('/quoted/path');
  });

  it('strips surrounding single quotes', () => {
    const sep = isWindows ? ';' : ':';
    const result = parsePathEntries(`'/quoted/path'${sep}/normal`);
    expect(result[0]).toBe('/quoted/path');
  });

  it('expands ~ in entries', () => {
    const result = parsePathEntries('~/bin');
    expect(result[0]).toBe(path.join(os.homedir(), 'bin'));
  });
});

describe('normalizeConfiguredCLIPath', () => {
  it('strips surrounding double quotes from a path containing a space', () => {
    expect(normalizeConfiguredCLIPath('"/opt/my cli/claude"')).toBe('/opt/my cli/claude');
  });

  it('strips surrounding single quotes', () => {
    expect(normalizeConfiguredCLIPath("'/opt/claude'")).toBe('/opt/claude');
  });

  it('leaves an unquoted path unchanged', () => {
    expect(normalizeConfiguredCLIPath('/opt/my cli/claude')).toBe('/opt/my cli/claude');
  });

  it('leaves a path with only a leading quote unchanged', () => {
    expect(normalizeConfiguredCLIPath('"/opt/claude')).toBe('"/opt/claude');
  });

  it('trims surrounding whitespace before unquoting', () => {
    expect(normalizeConfiguredCLIPath('  "/opt/claude"  ')).toBe('/opt/claude');
  });

  it('expands environment variables after unquoting', () => {
    const original = process.env.TEST_QUOTED_CLI_DIR;
    process.env.TEST_QUOTED_CLI_DIR = '/opt/tools';
    try {
      expect(normalizeConfiguredCLIPath('"$TEST_QUOTED_CLI_DIR/my cli"')).toBe('/opt/tools/my cli');
    } finally {
      if (original === undefined) delete process.env.TEST_QUOTED_CLI_DIR;
      else process.env.TEST_QUOTED_CLI_DIR = original;
    }
  });

  it('expands a home-relative path after unquoting', () => {
    expect(normalizeConfiguredCLIPath('"~/bin/my cli"')).toBe(path.join(os.homedir(), 'bin/my cli'));
  });

  it('returns an empty string for blank or missing input', () => {
    expect(normalizeConfiguredCLIPath('   ')).toBe('');
    expect(normalizeConfiguredCLIPath(undefined)).toBe('');
  });
});
