import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  getKimiModelMetadata,
  refreshKimiModelMetadata,
  resetKimiModelMetadataCache,
} from '@/providers/kimi/app/KimiModelMetadata';

const FIXTURE_TOML = `
[models."kimi-code/kimi-for-coding"]
display_name = "K2.7 Coding"
max_context_size = 262144
capabilities = ["thinking", "image_in", "tool_use"]

[models."kimi-code/kimi-for-coding-highspeed"]
display_name = "K2.7 Coding Highspeed"
max_context_size = 262144
capabilities = ["thinking", "tool_use"]

[models."kimi-code/k3"]
display_name = "K3"
max_context_size = 262144
max_input_size = 200000
capabilities = ["thinking", "image_in", "tool_use"]

[models."kimi-code/k3-256k"]
max_context_size = 262144
capabilities = ["always_thinking"]
`;

function settingsWithKimiHome(kimiHome: string): Record<string, unknown> {
  return {
    providerConfigs: {
      kimi: { environmentVariables: `KIMI_CODE_HOME=${kimiHome}` },
    },
  };
}

describe('KimiModelMetadata', () => {
  let kimiHome: string;

  beforeEach(() => {
    resetKimiModelMetadataCache();
    kimiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-metadata-test-'));
  });

  afterEach(() => {
    fs.rmSync(kimiHome, { force: true, recursive: true });
  });

  function writeConfig(contents: string): void {
    fs.writeFileSync(path.join(kimiHome, 'config.toml'), contents);
  }

  it('parses per-model metadata from config.toml under KIMI_CODE_HOME', () => {
    writeConfig(FIXTURE_TOML);

    expect(getKimiModelMetadata(settingsWithKimiHome(kimiHome))).toEqual({
      'kimi-code/kimi-for-coding': {
        capabilities: ['thinking', 'image_in', 'tool_use'],
        displayName: 'K2.7 Coding',
        maxContextSize: 262144,
      },
      'kimi-code/kimi-for-coding-highspeed': {
        capabilities: ['thinking', 'tool_use'],
        displayName: 'K2.7 Coding Highspeed',
        maxContextSize: 262144,
      },
      'kimi-code/k3': {
        capabilities: ['thinking', 'image_in', 'tool_use'],
        displayName: 'K3',
        maxContextSize: 262144,
      },
      'kimi-code/k3-256k': {
        capabilities: ['always_thinking'],
        maxContextSize: 262144,
      },
    });
  });

  it('returns empty metadata when config.toml is missing', () => {
    expect(getKimiModelMetadata(settingsWithKimiHome(kimiHome))).toEqual({});
    expect(getKimiModelMetadata(settingsWithKimiHome(path.join(kimiHome, 'missing')))).toEqual({});
  });

  it('returns empty metadata when config.toml is corrupt', () => {
    writeConfig('this is = = not [toml');

    expect(getKimiModelMetadata(settingsWithKimiHome(kimiHome))).toEqual({});
  });

  it('drops malformed entries and sanitizes field types', () => {
    writeConfig(`
[models."kimi-code/k3"]
display_name = 42
max_context_size = "262144"
capabilities = ["image_in", 7, "thinking"]

[models."kimi-code/k3-256k"]
display_name = "K3-256k"
max_context_size = 262144
capabilities = "image_in"

[models."kimi-code/broken"]

[other]
key = "value"
`);

    expect(getKimiModelMetadata(settingsWithKimiHome(kimiHome))).toEqual({
      'kimi-code/k3': {
        capabilities: ['image_in', 'thinking'],
      },
      'kimi-code/k3-256k': {
        capabilities: [],
        displayName: 'K3-256k',
        maxContextSize: 262144,
      },
    });
  });

  it('serves cached metadata until the file changes on disk', () => {
    writeConfig(FIXTURE_TOML);
    const settings = settingsWithKimiHome(kimiHome);
    expect(getKimiModelMetadata(settings)['kimi-code/k3']?.displayName).toBe('K3');

    writeConfig(FIXTURE_TOML.replace('display_name = "K3"', 'display_name = "K3 Next"'));
    // Force a distinguishable mtime so the cache invalidates deterministically.
    const configPath = path.join(kimiHome, 'config.toml');
    const future = new Date(Date.now() + 10_000);
    fs.utimesSync(configPath, future, future);

    expect(getKimiModelMetadata(settings)['kimi-code/k3']?.displayName).toBe('K3 Next');
  });

  it('force-refreshes metadata on demand', () => {
    writeConfig(FIXTURE_TOML);
    const settings = settingsWithKimiHome(kimiHome);
    getKimiModelMetadata(settings);

    writeConfig(FIXTURE_TOML.replace('display_name = "K3"', 'display_name = "K3 Next"'));

    expect(refreshKimiModelMetadata(settings)['kimi-code/k3']?.displayName).toBe('K3 Next');
    expect(getKimiModelMetadata(settings)['kimi-code/k3']?.displayName).toBe('K3 Next');
  });
});
