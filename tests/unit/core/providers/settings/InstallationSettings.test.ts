import { decodeInstallationSettings, selectInstallationSettings, updateInstallationSettings } from '@/core/providers/settings/InstallationSettings';

it('decodes, selects and updates installation-key maps without changing another installation', () => {
  const stored = decodeInstallationSettings({ installationMethodsByHost: { ' first ': ' wsl ', second: 'invalid' }, wslDistroOverridesByHost: { first: ' Ubuntu ', second: 'Debian', malformed: 42 } });
  expect(selectInstallationSettings(stored, 'first')).toEqual({ installationMethod: 'wsl', wslDistroOverride: 'Ubuntu' });
  expect(selectInstallationSettings(stored, 'new')).toEqual({ installationMethod: 'native-windows', wslDistroOverride: '' });
  const updated = updateInstallationSettings(stored, { installationMethod: 'wsl', wslDistroOverride: ' Fedora ' }, 'second', 'win32');
  expect(updated).toEqual({ installationMethod: 'wsl', wslDistroOverride: 'Fedora', installationMethodsByHost: { first: 'wsl', second: 'wsl' }, wslDistroOverridesByHost: { first: 'Ubuntu', second: 'Fedora' } });
  expect(stored.wslDistroOverridesByHost.second).toBe('Debian');
  expect(updateInstallationSettings(updated, { wslDistroOverride: '' }, 'second', 'win32').wslDistroOverridesByHost).toEqual({ first: 'Ubuntu' });
  expect(updateInstallationSettings(updated, {}, 'second', 'darwin')).toEqual({ installationMethod: 'native-windows', wslDistroOverride: '', installationMethodsByHost: { first: 'wsl' }, wslDistroOverridesByHost: { first: 'Ubuntu' } });
});
