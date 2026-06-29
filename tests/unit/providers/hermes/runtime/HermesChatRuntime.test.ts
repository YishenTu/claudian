const mockSubprocessInstances: Array<{ args: string[] }> = [];

class MockAcpSubprocess {
	readonly stdin = {};
	readonly stdout = {};
	readonly args: string[];

	constructor(spec: { args: string[] }) {
		this.args = [...spec.args];
		mockSubprocessInstances.push(this);
	}

	start = jest.fn();
	isAlive = jest.fn(() => true);
	getStderrSnapshot = jest.fn(() => '');
	onClose = jest.fn(() => jest.fn());
	shutdown = jest.fn(async () => {});
}

jest.mock('@/providers/acp/AcpSubprocess', () => ({
	AcpSubprocess: MockAcpSubprocess,
}));

const mockTransportInstances: Array<{ initialize: jest.Mock }> = [];

class MockAcpJsonRpcTransport {
	initialize = jest.fn(async () => {});
	start = jest.fn();
	dispose = jest.fn();
	onClose = jest.fn(() => jest.fn());

	constructor() {
		mockTransportInstances.push(this);
	}
}

jest.mock('@/providers/acp/AcpJsonRpcTransport', () => ({
	AcpJsonRpcTransport: MockAcpJsonRpcTransport,
}));

jest.mock('@/providers/acp/AcpClientConnection', () => ({
	AcpClientConnection: jest.fn().mockImplementation(() => ({
		dispose: jest.fn(),
		initialize: jest.fn(async () => {}),
	})),
}));

jest.mock('@/providers/acp/AcpSessionUpdateNormalizer', () => ({
	AcpSessionUpdateNormalizer: jest.fn().mockImplementation(() => ({
		normalize: jest.fn(),
	})),
}));

jest.mock('@/utils/env', () => ({
	...jest.requireActual('@/utils/env'),
	getEnhancedPath: (base: string) => base,
}));

jest.mock('@/utils/path', () => ({
	getVaultPath: () => '/tmp/hermes-vault',
}));

import '@/providers';

import { HermesChatRuntime } from '@/providers/hermes/runtime/HermesChatRuntime';

function createPlugin(profile?: string): any {
	return {
		app: {
			vault: {
				adapter: {
					basePath: '/tmp/hermes-vault',
				},
			},
		},
		getResolvedProviderCliPath: jest.fn(() => 'hermes'),
		manifest: { version: '1.0.0' },
		settings: {
			providerConfigs: {
				hermes: {
					enabled: true,
					...(profile ? { profile } : {}),
				},
			},
		},
	};
}

describe('HermesChatRuntime — profile arg', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockSubprocessInstances.length = 0;
		mockTransportInstances.length = 0;
	});

	it('spawns with bare acp args when no profile is set', async () => {
		const runtime = new HermesChatRuntime(createPlugin());
		await runtime.ensureReady();

		expect(mockSubprocessInstances).toHaveLength(1);
		expect(mockSubprocessInstances[0].args).toEqual(['acp']);
	});

	it('spawns with --profile when profile is configured', async () => {
		const runtime = new HermesChatRuntime(createPlugin('my-agent'));
		await runtime.ensureReady();

		expect(mockSubprocessInstances).toHaveLength(1);
		expect(mockSubprocessInstances[0].args).toEqual(['acp', '--profile', 'my-agent']);
	});

	it('restarts when profile changes between ensureReady calls', async () => {
		const plugin = createPlugin();
		const runtime = new HermesChatRuntime(plugin);
		await runtime.ensureReady();

		expect(mockSubprocessInstances).toHaveLength(1);
		expect(mockSubprocessInstances[0].args).toEqual(['acp']);

		plugin.settings.providerConfigs.hermes.profile = 'new-profile';
		await runtime.ensureReady({ force: true });

		expect(mockSubprocessInstances).toHaveLength(2);
		expect(mockSubprocessInstances[1].args).toEqual(['acp', '--profile', 'new-profile']);
	});
});
