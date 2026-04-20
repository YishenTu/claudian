import * as fs from 'fs';

import { OpencodeCliResolver } from '@/providers/opencode/runtime/OpencodeCliResolver';

jest.mock('fs');
jest.mock('@/utils/env', () => ({
  ...jest.requireActual('@/utils/env'),
  getHostnameKey: () => 'current-host',
}));

const mockedExists = fs.existsSync as jest.Mock;
const mockedStat = fs.statSync as jest.Mock;

describe('OpencodeCliResolver', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses the current host path instead of another synced host path', () => {
    mockedExists.mockImplementation((filePath: string) => filePath === '/current/opencode');
    mockedStat.mockReturnValue({ isFile: () => true });

    const resolver = new OpencodeCliResolver();
    const resolved = resolver.resolve(
      {
        'other-host': '/other/opencode',
        'current-host': '/current/opencode',
      },
      '/legacy/opencode',
      '',
    );

    expect(resolved).toBe('/current/opencode');
  });

  it('falls back to the legacy path when the current host has no custom path', () => {
    mockedExists.mockImplementation((filePath: string) => filePath === '/legacy/opencode');
    mockedStat.mockReturnValue({ isFile: () => true });

    const resolver = new OpencodeCliResolver();
    const resolved = resolver.resolve(
      {
        'other-host': '/other/opencode',
      },
      '/legacy/opencode',
      '',
    );

    expect(resolved).toBe('/legacy/opencode');
  });

  it('returns null when neither the current host nor the legacy path resolve to a file', () => {
    mockedExists.mockReturnValue(false);

    const resolver = new OpencodeCliResolver();
    const resolved = resolver.resolve(
      {
        'other-host': '/other/opencode',
      },
      '/legacy/opencode',
      '',
    );

    expect(resolved).toBeNull();
  });
});
