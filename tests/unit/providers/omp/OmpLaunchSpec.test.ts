import { buildOmpEnvironment, buildOmpLaunchSpec } from '@/providers/omp/runtime/OmpLaunchSpec';
import { DEFAULT_OMP_PROVIDER_SETTINGS } from '@/providers/omp/settings';

describe('buildOmpLaunchSpec', () => {
  it('does not inherit Pi configuration directories or profiles', () => {
    expect(buildOmpEnvironment(
      {
        PATH: '/usr/bin',
        PI_CODING_AGENT_DIR: '/Users/lee/.pi/agent',
        PI_PROFILE: 'pi-work',
      },
      {
        OMP_PROFILE: 'omp-work',
        PI_CONFIG_DIR: '/Users/lee/.pi',
      },
    )).toEqual({ PATH: '/usr/bin', OMP_PROFILE: 'omp-work' });
  });

  it('starts OMP in ACP mode with the conversation working directory', () => {
    const spec = buildOmpLaunchSpec({
      command: '/usr/local/bin/omp',
      cwd: '/vault/project',
      env: { OMP_PROFILE: 'test', PATH: '/usr/local/bin' },
      settings: DEFAULT_OMP_PROVIDER_SETTINGS,
    });

    expect(spec).toEqual({
      args: ['acp'],
      command: '/usr/local/bin/omp',
      cwd: '/vault/project',
      env: { OMP_PROFILE: 'test', PATH: '/usr/local/bin' },
    });
  });

  it('makes Bun available for an absolute OMP executable path', () => {
    const spec = buildOmpLaunchSpec({
      command: '/Users/lee/.bun/bin/omp',
      cwd: '/vault/project',
      env: { PATH: '/usr/bin:/bin' },
      settings: DEFAULT_OMP_PROVIDER_SETTINGS,
    });

    expect(spec.env.PATH).toBe('/Users/lee/.bun/bin:/usr/bin:/bin');
  });
});
