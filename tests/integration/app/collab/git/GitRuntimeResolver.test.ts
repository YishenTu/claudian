import { stat } from 'node:fs/promises';

import { GitRuntimeResolver } from '@/app/collab/git/GitRuntimeResolver';

jest.setTimeout(30_000);

describe('GitRuntimeResolver integration', () => {
  it('proves the installed Native Git runtime and required capabilities', async () => {
    const resolution = await new GitRuntimeResolver().rescan();

    expect(resolution.status).toBe('available');
    if (resolution.status !== 'available') return;
    expect(resolution.runtime.capabilities).toEqual({
      catFileBatch: true,
      commitTree: true,
      diffTreeNul: true,
      httpBackend: true,
      mergeTreeWriteTree: true,
      statusPorcelainV2Nul: true,
    });
    expect(resolution.runtime.version).toMatchObject({ major: 2 });
    await expect(stat(resolution.runtime.executablePath)).resolves.toMatchObject({});
    await expect(stat(resolution.runtime.httpBackendPath!)).resolves.toMatchObject({});
  });
});
