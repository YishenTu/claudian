import { parseInstallationKey } from '@/core/device/InstallationKey';

export const TEST_INSTALLATION_A = parseInstallationKey(`device-${'a'.repeat(64)}`);
export const TEST_INSTALLATION_B = parseInstallationKey(`device-${'b'.repeat(64)}`);
