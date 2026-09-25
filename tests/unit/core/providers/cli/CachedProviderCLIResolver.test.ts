import {
  CachedProviderCLIResolver,
  type ProviderCLISettingsProjection,
} from '@/core/providers/cli/CachedProviderCLIResolver';
import {
  findCLIBinaryPath,
  resolveConfiguredCLIPath,
} from '@/utils/cliBinaryLocator';

jest.mock('@/utils/cliBinaryLocator', () => ({
  findCLIBinaryPath: jest.fn(),
  resolveConfiguredCLIPath: jest.fn(),
}));

const mockedFindCLIBinaryPath = jest.mocked(findCLIBinaryPath);
const mockedResolveConfiguredCLIPath = jest.mocked(resolveConfiguredCLIPath);

describe('CachedProviderCLIResolver', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedResolveConfiguredCLIPath.mockReturnValue(null);
    mockedFindCLIBinaryPath.mockReturnValue(null);
  });

  it('preserves current-host, legacy, then runtime PATH lookup order', () => {
    mockedResolveConfiguredCLIPath.mockImplementation((candidate) => (
      candidate === '/current/provider' ? '/resolved/current' : null
    ));
    const resolver = createResolver();

    expect(resolver.resolve({
      cliPathsByHost: { current: '/current/provider' },
      environmentText: 'PATH=/provider/bin',
      legacyCliPath: '/legacy/provider',
    })).toBe('/resolved/current');
    expect(mockedResolveConfiguredCLIPath.mock.calls).toEqual([
      ['/current/provider'],
    ]);
    expect(mockedFindCLIBinaryPath).not.toHaveBeenCalled();

    resolver.reset();
    mockedResolveConfiguredCLIPath.mockImplementation((candidate) => (
      candidate === '/legacy/provider' ? '/resolved/legacy' : null
    ));
    expect(resolver.resolve({
      cliPathsByHost: { current: '/missing/current' },
      environmentText: 'PATH=/provider/bin',
      legacyCliPath: '/legacy/provider',
    })).toBe('/resolved/legacy');

    resolver.reset();
    mockedResolveConfiguredCLIPath.mockReturnValue(null);
    mockedFindCLIBinaryPath.mockReturnValue('/provider/bin/provider');
    expect(resolver.resolve({
      cliPathsByHost: {},
      environmentText: 'PATH=/provider/bin',
      legacyCliPath: '',
    })).toBe('/provider/bin/provider');
    expect(mockedFindCLIBinaryPath).toHaveBeenCalledWith('provider', '/provider/bin');
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
