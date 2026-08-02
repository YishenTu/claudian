import {
  CachedProviderCliResolver,
  type ProviderCliSettingsProjection,
} from '@/core/providers/cli/CachedProviderCliResolver';
import {
  findCliBinaryPath,
  resolveConfiguredCliPath,
} from '@/utils/cliBinaryLocator';

jest.mock('@/utils/cliBinaryLocator', () => ({
  findCliBinaryPath: jest.fn(),
  resolveConfiguredCliPath: jest.fn(),
}));

const mockedFindCliBinaryPath = jest.mocked(findCliBinaryPath);
const mockedResolveConfiguredCliPath = jest.mocked(resolveConfiguredCliPath);

describe('CachedProviderCliResolver', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedResolveConfiguredCliPath.mockReturnValue(null);
    mockedFindCliBinaryPath.mockReturnValue(null);
  });

  it('preserves current-host, legacy, then runtime PATH lookup order', () => {
    mockedResolveConfiguredCliPath.mockImplementation((candidate) => (
      candidate === '/current/provider' ? '/resolved/current' : null
    ));
    const resolver = createResolver();

    expect(resolver.resolve({
      cliPathsByHost: { current: '/current/provider' },
      environmentText: 'PATH=/provider/bin',
      legacyCliPath: '/legacy/provider',
    })).toBe('/resolved/current');
    expect(mockedResolveConfiguredCliPath.mock.calls).toEqual([
      ['/current/provider'],
    ]);
    expect(mockedFindCliBinaryPath).not.toHaveBeenCalled();

    resolver.reset();
    mockedResolveConfiguredCliPath.mockImplementation((candidate) => (
      candidate === '/legacy/provider' ? '/resolved/legacy' : null
    ));
    expect(resolver.resolve({
      cliPathsByHost: { current: '/missing/current' },
      environmentText: 'PATH=/provider/bin',
      legacyCliPath: '/legacy/provider',
    })).toBe('/resolved/legacy');

    resolver.reset();
    mockedResolveConfiguredCliPath.mockReturnValue(null);
    mockedFindCliBinaryPath.mockReturnValue('/provider/bin/provider');
    expect(resolver.resolve({
      cliPathsByHost: {},
      environmentText: 'PATH=/provider/bin',
      legacyCliPath: '',
    })).toBe('/provider/bin/provider');
    expect(mockedFindCliBinaryPath).toHaveBeenCalledWith('provider', '/provider/bin');
  });

  it('caches successful and null resolutions until reset', () => {
    const positiveResolution = jest.fn(() => '/resolved/provider');
    const positive = createResolver(positiveResolution);
    const projection = createProjection();

    expect(positive.resolve(projection)).toBe('/resolved/provider');
    expect(positive.resolve(projection)).toBe('/resolved/provider');
    expect(positiveResolution).toHaveBeenCalledTimes(1);
    positive.reset();
    expect(positive.resolve(projection)).toBe('/resolved/provider');
    expect(positiveResolution).toHaveBeenCalledTimes(2);

    const negativeResolution = jest.fn(() => null);
    const negative = createResolver(negativeResolution);
    expect(negative.resolve(projection)).toBeNull();
    expect(negative.resolve(projection)).toBeNull();
    expect(negativeResolution).toHaveBeenCalledTimes(1);
    negative.reset();
    expect(negative.resolve(projection)).toBeNull();
    expect(negativeResolution).toHaveBeenCalledTimes(2);
  });

  it('invalidates the cache for every resolution input', () => {
    const resolution = jest.fn(() => '/resolved/provider');
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

  it('projects settings before resolving and ignores unrelated settings fields', () => {
    const resolution = jest.fn(() => '/resolved/provider');
    const resolver = new CachedProviderCliResolver({
      binaryName: 'provider',
      getSettingsProjection: settings => settings.cli as ProviderCliSettingsProjection,
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
  resolve?: ConstructorParameters<typeof CachedProviderCliResolver>[0]['resolve'],
): CachedProviderCliResolver {
  return new CachedProviderCliResolver({
    binaryName: 'provider',
    getSettingsProjection: settings => settings as unknown as ProviderCliSettingsProjection,
    hostnameKey: 'current',
    providerId: 'test-provider',
    resolve,
  });
}

function createProjection(): ProviderCliSettingsProjection {
  return {
    cliPathsByHost: { current: '/current/provider' },
    environmentText: 'PATH=/provider/bin',
    legacyCliPath: '/legacy/provider',
    resolutionInputs: { installationMethod: 'native' },
  };
}
