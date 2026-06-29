import * as fs from 'node:fs';

const mockRenderEnvironmentSettingsSection = jest.fn();

interface MockToggleComponent {
	onChangeCallback: ((value: boolean) => Promise<void> | void) | null;
	setValue: jest.Mock;
	value: boolean;
	onChange(callback: (value: boolean) => Promise<void> | void): MockToggleComponent;
}

interface MockTextComponent {
	inputEl: {
		toggleClass: jest.Mock;
	};
	onChangeCallback: ((value: string) => Promise<void> | void) | null;
	setPlaceholder: jest.Mock;
	setValue: jest.Mock;
	value: string;
	onChange(callback: (value: string) => Promise<void> | void): MockTextComponent;
}

class MockSetting {
	heading = false;
	name = '';
	desc = '';
	textComponents: MockTextComponent[] = [];
	toggleComponents: MockToggleComponent[] = [];

	constructor(_container: unknown) {
		createdSettings.push(this);
	}

	setName(name: string): this {
		this.name = name;
		return this;
	}

	setDesc(desc: string): this {
		this.desc = desc;
		return this;
	}

	setHeading(): this {
		this.heading = true;
		return this;
	}

	addToggle(callback: (toggle: MockToggleComponent) => void): this {
		const component = createToggleComponent();
		this.toggleComponents.push(component);
		callback(component);
		return this;
	}

	addText(callback: (text: MockTextComponent) => void): this {
		const component = createTextComponent();
		this.textComponents.push(component);
		callback(component);
		return this;
	}
}

jest.mock('node:fs');
jest.mock('obsidian', () => ({
	Setting: MockSetting,
}));
jest.mock('@/features/settings/ui/EnvironmentSettingsSection', () => ({
	renderEnvironmentSettingsSection: (...args: unknown[]) => mockRenderEnvironmentSettingsSection(...args),
}));
jest.mock('@/utils/env', () => ({
	...jest.requireActual('@/utils/env'),
	getHostnameKey: () => 'current-host',
}));

import { getHermesProviderSettings } from '@/providers/hermes/settings';
import { hermesSettingsTabRenderer } from '@/providers/hermes/ui/HermesSettingsTab';

const createdSettings: MockSetting[] = [];
const mockedExists = fs.existsSync as jest.Mock;
const mockedStat = fs.statSync as jest.Mock;

function createToggleComponent(): MockToggleComponent {
	const component = {} as MockToggleComponent;
	component.onChangeCallback = null;
	component.value = false;
	component.setValue = jest.fn((value: boolean) => {
		component.value = value;
		return component;
	});
	component.onChange = (callback: (value: boolean) => Promise<void> | void): MockToggleComponent => {
		component.onChangeCallback = callback;
		return component;
	};
	return component;
}

function createTextComponent(): MockTextComponent {
	const component = {} as MockTextComponent;
	component.inputEl = { toggleClass: jest.fn() };
	component.onChangeCallback = null;
	component.value = '';
	component.setPlaceholder = jest.fn(() => component);
	component.setValue = jest.fn((value: string) => {
		component.value = value;
		return component;
	});
	component.onChange = (callback: (value: string) => Promise<void> | void): MockTextComponent => {
		component.onChangeCallback = callback;
		return component;
	};
	return component;
}

function createElement(): any {
	return {
		createDiv: jest.fn(() => createElement()),
		createEl: jest.fn(() => ({ addClass: jest.fn() })),
		empty: jest.fn(),
		setText: jest.fn(),
		toggleClass: jest.fn(),
	};
}

function createContext(settings: Record<string, unknown>) {
	return {
		plugin: {
			manifest: { version: '1.0.0' },
			saveSettings: jest.fn().mockResolvedValue(undefined),
			settings,
		},
		refreshModelSelectors: jest.fn(),
		renderHiddenProviderCommandSetting: jest.fn(),
	};
}

function render(settings: Record<string, unknown>) {
	const context = createContext(settings);
	hermesSettingsTabRenderer.render(createElement(), context as any);
	return context;
}

function findSetting(name: string): MockSetting {
	const setting = [...createdSettings].reverse().find(entry => entry.name === name);
	if (!setting) {
		throw new Error(`Setting not found: ${name}`);
	}
	return setting;
}

describe('HermesSettingsTab — profile', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		createdSettings.length = 0;
		mockedExists.mockReturnValue(true);
		mockedStat.mockReturnValue({ isFile: () => true });
	});

	it('renders the agent profile setting', () => {
		render({ providerConfigs: { hermes: {} } });

		expect(() => findSetting('Agent profile')).not.toThrow();
	});

	it('shows current profile value', () => {
		render({ providerConfigs: { hermes: { profile: 'my-agent' } } });

		const profileSetting = findSetting('Agent profile');
		expect(profileSetting.textComponents[0].setValue).toHaveBeenCalledWith('my-agent');
	});

	it('shows empty value when no profile is set', () => {
		render({ providerConfigs: { hermes: {} } });

		const profileSetting = findSetting('Agent profile');
		expect(profileSetting.textComponents[0].setValue).toHaveBeenCalledWith('');
	});

	it('persists profile on change', async () => {
		const settings: Record<string, unknown> = { providerConfigs: { hermes: {} } };
		const context = render(settings);

		await findSetting('Agent profile').textComponents[0].onChangeCallback?.('new-profile');

		expect(getHermesProviderSettings(settings).profile).toBe('new-profile');
		expect(context.plugin.saveSettings).toHaveBeenCalled();
	});

	it('trims profile value before persisting', async () => {
		const settings: Record<string, unknown> = { providerConfigs: { hermes: {} } };
		render(settings);

		await findSetting('Agent profile').textComponents[0].onChangeCallback?.('  spaced  ');

		expect(getHermesProviderSettings(settings).profile).toBe('spaced');
	});
});
