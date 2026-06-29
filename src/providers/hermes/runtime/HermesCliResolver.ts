import * as os from 'os';
import * as path from 'path';

import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import { findCliBinaryPath, isExistingFile, resolveConfiguredCliPath } from '../../../utils/cliBinaryLocator';
import { getHostnameKey, parseEnvironmentVariables } from '../../../utils/env';
import { expandHomePath } from '../../../utils/path';
import { getHermesProviderSettings } from '../settings';

const HERMES_COMMON_INSTALL_PATHS = [
	'~/.local/bin/hermes',
	'~/.hermes/hermes-agent/.venv/bin/hermes',
];

export class HermesCliResolver {
	private readonly cachedHostname = getHostnameKey();
	private lastCliPath = '';
	private lastHostnamePath = '';
	private lastEnvText = '';
	private resolvedPath: string | null = null;

	resolveFromSettings(settings: Record<string, unknown>): string | null {
		const hermesSettings = getHermesProviderSettings(settings);
		const cliPath = hermesSettings.cliPath.trim();
		const hostnamePath = (hermesSettings.cliPathsByHost[this.cachedHostname] ?? '').trim();
		const envText = getRuntimeEnvironmentText(settings, 'hermes');

		if (
			this.resolvedPath !== null
			&& cliPath === this.lastCliPath
			&& hostnamePath === this.lastHostnamePath
			&& envText === this.lastEnvText
		) {
			return this.resolvedPath;
		}

		this.lastCliPath = cliPath;
		this.lastHostnamePath = hostnamePath;
		this.lastEnvText = envText;
		this.resolvedPath = this.resolve(
			hermesSettings.cliPathsByHost,
			cliPath,
			envText,
		);
		return this.resolvedPath;
	}

	resolve(
		hostnamePaths: Record<string, string> | undefined,
		legacyPath: string,
		envText: string,
	): string | null {
		const hostnamePath = (hostnamePaths?.[this.cachedHostname] ?? '').trim();
		const customEnv = parseEnvironmentVariables(envText || '');
		return resolveConfiguredCliPath(hostnamePath)
			?? resolveConfiguredCliPath(legacyPath.trim())
			?? resolveCommonInstallPath()
			?? findCliBinaryPath('hermes', customEnv.PATH);
	}

	reset(): void {
		this.lastCliPath = '';
		this.lastHostnamePath = '';
		this.lastEnvText = '';
		this.resolvedPath = null;
	}
}

function resolveCommonInstallPath(): string | null {
	const home = os.homedir();
	for (const candidate of HERMES_COMMON_INSTALL_PATHS) {
		const expanded = candidate.startsWith('~')
			? path.join(home, candidate.slice(1))
			: expandHomePath(candidate);
		if (isExistingFile(expanded)) {
			return expanded;
		}
	}
	return null;
}
