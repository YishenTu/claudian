import type { PiFamilyProfile } from '../pi-rpc/PiFamilyProfile';
import { piFamilyModels } from './models';
import { piFamilySettings } from './settings';

export const piFamilyProfile: PiFamilyProfile = {
  agentDirEnvKey: 'PI_CODING_AGENT_DIR',
  agentDirName: '.pi',
  defaultBinaryName: 'pi',
  displayName: 'Pi',
  envHashKeys: [
    'PI_CODING_AGENT_DIR',
    'PI_CODING_AGENT_SESSION_DIR',
    'PI_PACKAGE_DIR',
    'PI_OFFLINE',
    'PI_SKIP_VERSION_CHECK',
    'PI_TELEMETRY',
    'PI_CACHE_RETENTION',
    'PATH',
  ],
  envKeyPatterns: [/^PI_/i],
  modelIdPrefix: 'pi:',
  models: piFamilyModels,
  providerId: 'pi',
  sessionDirEnvKey: 'PI_CODING_AGENT_SESSION_DIR',
  settings: piFamilySettings,
  windowsBinKey: 'pi',
  windowsPackageName: '@earendil-works/pi-coding-agent',
  windowsShimName: 'pi.cmd',
};
