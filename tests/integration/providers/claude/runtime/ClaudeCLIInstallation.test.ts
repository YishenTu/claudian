// @test-ci {"native":true}
import '@/providers';

import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';

import { inspectClaudeInstallation } from '@/providers/claude/runtime/ClaudeCLIInstallation';

// The bundled `node` is a POSIX shell script; Windows resolves a bundled Node differently.
it.skipIf(process.platform === 'win32')('inspects a script CLI with the Node bundled beside it, ahead of the system Node', async () => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'claudian-claude-cli-'));
  onTestFinished(() => fs.rm(directory, { recursive: true, force: true }));
  const cli = path.join(directory, 'cli.js');
  // The system Node would run cli.js and report its own version; only the bundled Node reports 2.1.99.
  await fs.writeFile(cli, "console.log('2.1.11');\n");
  await fs.writeFile(path.join(directory, 'node'), "#!/bin/sh\nprintf '2.1.99\\n'\n", { mode: 0o755 });
  const fixture = await createProviderHostFixture({
    settings: { providerConfigs: { claude: { cliPath: cli } } },
    overrides: { getResolvedProviderCliPath: async () => cli },
  });
  onTestFinished(() => fixture.dispose());

  await expect(inspectClaudeInstallation(fixture.host.getRuntimeHost('claude')))
    .resolves.toMatchObject({ path: cli, version: '2.1.99' });
});
