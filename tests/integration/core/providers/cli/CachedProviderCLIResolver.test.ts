import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CachedProviderCLIResolver,
  type ProviderCLISettingsProjection,
} from '@/core/providers/cli/CachedProviderCLIResolver';

describe('CachedProviderCLIResolver', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'provider-resolution-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });
  function binary(name: string): string {
    const path = join(root, name);
    writeFileSync(path, '', { mode: 0o700 });
    return path;
  }

  it('preserves current-host, legacy, then runtime PATH lookup order', () => {
    const current = binary('current');
    const legacy = binary('legacy');
    const auto = binary('provider');
    const resolver = createResolver();
    const projection = { cliPathsByHost: { current }, legacyCliPath: legacy, environmentText: `PATH=${root}` };
    expect(resolver.resolve(projection)).toBe(current);
    rmSync(current);
    resolver.reset();
    expect(resolver.resolve(projection)).toBe(legacy);
    rmSync(legacy);
    resolver.reset();
    expect(resolver.resolve(projection)).toBe(auto);
  });

  it('caches successful and null resolutions until reset', () => {
    const positiveResolution = vi.fn(() => '/resolved/provider');
    const positive = createResolver(positiveResolution);
    const projection = createProjection();

    expect(positive.resolve(projection)).toBe('/resolved/provider');
    expect(positive.resolve(projection)).toBe('/resolved/provider');
    expect(positiveResolution).toHaveBeenCalledTimes(1);
    positive.reset();
    expect(positive.resolve(projection)).toBe('/resolved/provider');
    expect(positiveResolution).toHaveBeenCalledTimes(2);

    const negativeResolution = vi.fn(() => null);
    const negative = createResolver(negativeResolution);
    expect(negative.resolve(projection)).toBeNull();
    expect(negative.resolve(projection)).toBeNull();
    expect(negativeResolution).toHaveBeenCalledTimes(1);
    negative.reset();
    expect(negative.resolve(projection)).toBeNull();
    expect(negativeResolution).toHaveBeenCalledTimes(2);
  });

  it('invalidates the cache for every resolution input', () => {
    const resolution = vi.fn(() => '/resolved/provider');
    const resolver = createResolver(resolution);
    const baseline = createProjection();

    resolver.resolve(baseline);
    resolver.resolve({ ...baseline, legacyCliPath: '/other/legacy' });
    resolver.resolve({
      ...baseline,
      cliPathsByHost: { current: '/other/current' },
    });
    resolver.resolve({ ...baseline, environmentText: 'PATH=/other/bin' });
    resolver.resolve({
      ...baseline,
      resolutionInputs: { installationMethod: 'wsl' },
    });

    expect(resolution).toHaveBeenCalledTimes(5);
  });

  it('uses provider discovery only after configured paths fail', () => {
    const findBinaryPath = vi.fn(() => '/native/provider');
    const resolver = new CachedProviderCLIResolver({
      binaryName: 'provider',
      getSettingsProjection: () => createProjection(),
      hostnameKey: 'current',
      providerId: 'test-provider',
      findBinaryPath,
    });
    const configured = binary('configured');
    const projection = { ...createProjection(), cliPathsByHost: { current: configured } };
    expect(resolver.resolve(projection)).toBe(configured);
    expect(findBinaryPath).not.toHaveBeenCalled();

    rmSync(configured);
    resolver.reset();
    expect(resolver.resolve(projection)).toBe('/native/provider');
    expect(findBinaryPath).toHaveBeenCalledWith('/provider/bin');
  });

  it('retries uncached misses and refreshes provider targets that disable caching', () => {
    const resolution = vi.fn<(...args: []) => string | null>(() => null);
    const resolver = new CachedProviderCLIResolver({
      binaryName: 'provider',
      getSettingsProjection: () => createProjection(),
      hostnameKey: 'current',
      providerId: 'test-provider',
      resolve: resolution,
      shouldCache: (result, context) => result !== null && context.resolutionInputs?.method !== 'dynamic',
    });

    expect(resolver.resolveFromSettings({})).toBeNull();
    resolution.mockReturnValue('/installed/provider');
    expect(resolver.resolveFromSettings({})).toBe('/installed/provider');
    expect(resolver.resolveFromSettings({})).toBe('/installed/provider');
    expect(resolution).toHaveBeenCalledTimes(2);

    expect(resolver.resolveFromSettings({}, { method: 'dynamic' })).toBe('/installed/provider');
    resolution.mockReturnValue('/updated/provider');
    expect(resolver.resolveFromSettings({}, { method: 'dynamic' })).toBe('/updated/provider');
    expect(resolution).toHaveBeenCalledTimes(4);
  });

  it('projects settings before resolving and ignores unrelated settings fields', () => {
    const resolution = vi.fn(() => '/resolved/provider');
    const resolver = new CachedProviderCLIResolver({
      binaryName: 'provider',
      getSettingsProjection: settings => settings.cli as ProviderCLISettingsProjection,
      hostnameKey: 'current',
      providerId: 'test-provider',
      resolve: resolution,
    });
    const settings = {
      cli: createProjection(),
      unrelated: 'one',
    };

    expect(resolver.resolveFromSettings(settings)).toBe('/resolved/provider');
    expect(resolver.resolveFromSettings({ ...settings, unrelated: 'two' }))
      .toBe('/resolved/provider');
    expect(resolution).toHaveBeenCalledTimes(1);
  });
});

function createResolver(
  resolve?: ConstructorParameters<typeof CachedProviderCLIResolver>[0]['resolve'],
): CachedProviderCLIResolver {
  return new CachedProviderCLIResolver({
    binaryName: 'provider',
    getSettingsProjection: settings => settings as unknown as ProviderCLISettingsProjection,
    hostnameKey: 'current',
    providerId: 'test-provider',
    resolve,
  });
}

function createProjection(): ProviderCLISettingsProjection {
  return {
    cliPathsByHost: { current: '/current/provider' },
    environmentText: 'PATH=/provider/bin',
    legacyCliPath: '/legacy/provider',
    resolutionInputs: { installationMethod: 'native' },
  };
}
