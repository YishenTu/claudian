// @test-ci {"inputs":["tests/fixtures/providers/models/**","src/providers/{grok,opencode}/{settings,config,models,discoveryState,internal/compareCollections}.ts","src/core/device/InstallationKey.ts","src/core/providers/providerConfig.ts","src/core/providers/{settings,models}/**"]}
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { build } from 'esbuild';

it('retains accepted prototype-named metadata in the production ES2022 configuration artifact', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'claudian-model-dictionaries-'));
  try {
    const bundled = await build({ entryPoints: ['tests/fixtures/providers/models/ProviderModelDictionaryProjection.ts'],
      bundle: true, platform: 'node', target: 'es2022', format: 'cjs', write: false,
      alias: { '@': path.resolve('src') }, logLevel: 'silent' });
    const artifact = path.join(directory, 'artifact.cjs');
    await writeFile(artifact, bundled.outputFiles[0].contents);
    const program = `
      const values = new Map();
      global.window = { localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) } };
      const { roundTripModelMetadata } = require(process.argv[1]);
      process.stdout.write(JSON.stringify(roundTripModelMetadata()));
    `;
    const actual = JSON.parse(execFileSync(process.execPath, ['-e', program, artifact], { encoding: 'utf8' }));
    const expected = { aliases: [['__proto__', 'Gateway alias']], reasoning: [['__proto__', 'high']] };
    expect(actual).toEqual({ grok: expected, opencode: expected });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
