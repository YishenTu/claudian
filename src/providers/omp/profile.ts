import type { PiFamilyProfile } from '../pi-rpc/PiFamilyProfile';
import { ompFamilyModels } from './models';
import { ompFamilySettings } from './settings';

export const ompFamilyProfile: PiFamilyProfile = {
  agentDirEnvKey: 'PI_CODING_AGENT_DIR',
  agentDirName: '.omp',
  defaultBinaryName: 'omp',
  displayName: 'Oh My Pi',
  envHashKeys: [
    'PI_CODING_AGENT_DIR',
    'PI_CODING_AGENT_SESSION_DIR',
    'PI_PACKAGE_DIR',
    'PI_OFFLINE',
    'PI_SKIP_VERSION_CHECK',
    'PI_TELEMETRY',
    'PI_CACHE_RETENTION',
    'OMP_PROFILE',
    'PATH',
  ],
  envKeyPatterns: [/^PI_/i, /^OMP_/i],
  modelIdPrefix: 'omp:',
  models: ompFamilyModels,
  providerId: 'omp',
  sessionDirEnvKey: 'PI_CODING_AGENT_SESSION_DIR',
  settings: ompFamilySettings,
  windowsBinKey: 'omp',
  windowsPackageName: '@oh-my-pi/pi-coding-agent',
  windowsShimName: 'omp.cmd',
};
