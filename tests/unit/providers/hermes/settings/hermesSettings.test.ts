import {
	DEFAULT_HERMES_PROVIDER_SETTINGS,
	getHermesProviderSettings,
	updateHermesProviderSettings,
} from '@/providers/hermes/settings';

function hermesConfig(config: Record<string, unknown>): Record<string, unknown> {
	return { providerConfigs: { hermes: config } };
}

describe('Hermes provider settings — profile', () => {
	it('defaults to empty string', () => {
		expect(DEFAULT_HERMES_PROVIDER_SETTINGS.profile).toBe('');
	});

	it('returns empty profile when not set in config', () => {
		const settings = hermesConfig({});
		const result = getHermesProviderSettings(settings);
		expect(result.profile).toBe('');
	});

	it('returns empty profile when config has no hermes key', () => {
		const settings = {};
		const result = getHermesProviderSettings(settings);
		expect(result.profile).toBe('');
	});

	it('returns profile from config', () => {
		const settings = hermesConfig({ profile: 'my-agent' });
		const result = getHermesProviderSettings(settings);
		expect(result.profile).toBe('my-agent');
	});

	it('trims whitespace from profile', () => {
		const settings = hermesConfig({ profile: '  spaced-agent  ' });
		const result = getHermesProviderSettings(settings);
		expect(result.profile).toBe('spaced-agent');
	});

	it('returns empty string when profile is not a string', () => {
		const settings = hermesConfig({ profile: 123 });
		const result = getHermesProviderSettings(settings);
		expect(result.profile).toBe('');
	});

	it('updates profile via updateHermesProviderSettings', () => {
		const settings: Record<string, unknown> = hermesConfig({});

		const updated = updateHermesProviderSettings(settings, { profile: 'new-profile' });

		expect(updated.profile).toBe('new-profile');
		expect(getHermesProviderSettings(settings).profile).toBe('new-profile');
	});

	it('trims profile on update', () => {
		const settings: Record<string, unknown> = hermesConfig({});

		const updated = updateHermesProviderSettings(settings, { profile: '  trimmed  ' });

		expect(updated.profile).toBe('trimmed');
	});

	it('clears profile when set to empty string', () => {
		const settings: Record<string, unknown> = hermesConfig({ profile: 'existing' });

		const updated = updateHermesProviderSettings(settings, { profile: '' });

		expect(updated.profile).toBe('');
	});

	it('preserves existing profile when not included in updates', () => {
		const settings: Record<string, unknown> = hermesConfig({ profile: 'keep-me' });

		const updated = updateHermesProviderSettings(settings, { enabled: true });

		expect(updated.profile).toBe('keep-me');
	});
});
