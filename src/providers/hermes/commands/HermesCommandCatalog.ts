import type {
	ProviderCommandCatalog,
	ProviderCommandDropdownConfig,
} from '../../../core/providers/commands/ProviderCommandCatalog';
import type { ProviderCommandEntry } from '../../../core/providers/commands/ProviderCommandEntry';
import type { SlashCommand } from '../../../core/types';
import type { HermesSkillStorage } from '../storage/HermesSkillStorage';

function slashCommandToEntry(cmd: SlashCommand): ProviderCommandEntry {
	const isSkill = cmd.kind === 'skill';
	return {
		id: cmd.id,
		providerId: 'hermes',
		kind: isSkill ? 'skill' : 'command',
		name: cmd.name,
		description: cmd.description,
		content: cmd.content,
		argumentHint: cmd.argumentHint,
		allowedTools: cmd.allowedTools,
		model: cmd.model,
		disableModelInvocation: cmd.disableModelInvocation,
		userInvocable: cmd.userInvocable,
		context: cmd.context,
		agent: cmd.agent,
		hooks: cmd.hooks,
		scope: cmd.source === 'sdk' ? 'runtime' : 'vault',
		source: cmd.source ?? 'user',
		isEditable: false,
		isDeletable: false,
		displayPrefix: '/',
		insertPrefix: '/',
	};
}

export class HermesCommandCatalog implements ProviderCommandCatalog {
	private sdkCommands: SlashCommand[] = [];
	private cachedVaultSkills: ProviderCommandEntry[] | null = null;
	private vaultLoadPromise: Promise<void> | null = null;

	constructor(
		private readonly skillStorage?: HermesSkillStorage,
	) {}

	setRuntimeCommands(commands: SlashCommand[]): void {
		this.sdkCommands = commands;
	}

	async listDropdownEntries(_context: { includeBuiltIns: boolean }): Promise<ProviderCommandEntry[]> {
		const vaultSkills = await this.getVaultEntries();
		const runtimeCommands = this.sdkCommands.map(slashCommandToEntry);

		// Deduplicate by name: vault skills win
		const seen = new Set<string>();
		const merged: ProviderCommandEntry[] = [];

		for (const entry of vaultSkills) {
			seen.add(entry.name);
			merged.push(entry);
		}
		for (const entry of runtimeCommands) {
			if (!seen.has(entry.name)) {
				merged.push(entry);
			}
		}

		return merged;
	}

	async listVaultEntries(): Promise<ProviderCommandEntry[]> {
		return this.getVaultEntries();
	}

	async saveVaultEntry(_entry: ProviderCommandEntry): Promise<void> {
		// Hermes skill management is owned by the Hermes CLI
	}

	async deleteVaultEntry(_entry: ProviderCommandEntry): Promise<void> {
		// Hermes skill management is owned by the Hermes CLI
	}

	getDropdownConfig(): ProviderCommandDropdownConfig {
		return {
			providerId: 'hermes',
			triggerChars: ['/'],
			builtInPrefix: '/',
			skillPrefix: '/',
			commandPrefix: '/',
		};
	}

	async refresh(): Promise<void> {
		this.cachedVaultSkills = null;
	}

	private async getVaultEntries(): Promise<ProviderCommandEntry[]> {
		if (this.cachedVaultSkills !== null) {
			return this.cachedVaultSkills;
		}

		if (!this.skillStorage) {
			return [];
		}

		// Deduplicate concurrent loads
		if (!this.vaultLoadPromise) {
			this.vaultLoadPromise = this.loadVaultSkills().finally(() => {
				this.vaultLoadPromise = null;
			});
		}
		await this.vaultLoadPromise;
		return this.cachedVaultSkills ?? [];
	}

	private async loadVaultSkills(): Promise<void> {
		if (!this.skillStorage) return;
		const skills = await this.skillStorage.loadAll();
		this.cachedVaultSkills = skills.map(slashCommandToEntry);
	}
}
