import type { SlashCommand } from '@/core/types';
import { HermesCommandCatalog } from '@/providers/hermes/commands/HermesCommandCatalog';
import type { HermesSkillStorage } from '@/providers/hermes/storage/HermesSkillStorage';

function createMockSkillStorage(skills: SlashCommand[]): HermesSkillStorage {
	return {
		loadAll: jest.fn().mockResolvedValue(skills),
	} as unknown as HermesSkillStorage;
}

describe('HermesCommandCatalog', () => {
	describe('listDropdownEntries', () => {
		it('returns SDK runtime commands as ProviderCommandEntry', async () => {
			const catalog = new HermesCommandCatalog();

			const sdkCommands: SlashCommand[] = [
				{ id: 'acp:search', name: 'search', description: 'Search files', content: '', source: 'sdk' },
				{ id: 'acp:analyze', name: 'analyze', description: 'Analyze code', content: '', source: 'sdk' },
			];
			catalog.setRuntimeCommands(sdkCommands);

			const entries = await catalog.listDropdownEntries({ includeBuiltIns: false });

			expect(entries).toHaveLength(2);

			const searchEntry = entries.find(e => e.name === 'search');
			expect(searchEntry).toBeDefined();
			expect(searchEntry!.providerId).toBe('hermes');
			expect(searchEntry!.kind).toBe('command');
			expect(searchEntry!.scope).toBe('runtime');
			expect(searchEntry!.source).toBe('sdk');
			expect(searchEntry!.isEditable).toBe(false);
			expect(searchEntry!.isDeletable).toBe(false);
			expect(searchEntry!.displayPrefix).toBe('/');
			expect(searchEntry!.insertPrefix).toBe('/');
		});

		it('returns empty when no runtime commands', async () => {
			const catalog = new HermesCommandCatalog();

			const entries = await catalog.listDropdownEntries({ includeBuiltIns: true });

			expect(entries).toHaveLength(0);
		});

		it('includes all commands without filtering', async () => {
			const catalog = new HermesCommandCatalog();

			const sdkCommands: SlashCommand[] = [
				{ id: 'acp:search', name: 'search', description: 'Search', content: '', source: 'sdk' },
				{ id: 'acp:analyze', name: 'analyze', description: 'Analyze', content: '', source: 'sdk' },
				{ id: 'acp:debug', name: 'debug', description: 'Debug', content: '', source: 'sdk' },
			];
			catalog.setRuntimeCommands(sdkCommands);

			const withBuiltins = await catalog.listDropdownEntries({ includeBuiltIns: true });
			const withoutBuiltins = await catalog.listDropdownEntries({ includeBuiltIns: false });

			expect(withBuiltins).toHaveLength(3);
			expect(withoutBuiltins).toHaveLength(3);
		});

		it('replaces commands on subsequent setRuntimeCommands calls', async () => {
			const catalog = new HermesCommandCatalog();

			catalog.setRuntimeCommands([
				{ id: 'acp:old', name: 'old', description: 'Old', content: '', source: 'sdk' },
			]);
			expect(await catalog.listDropdownEntries({ includeBuiltIns: true })).toHaveLength(1);

			catalog.setRuntimeCommands([
				{ id: 'acp:new1', name: 'new1', description: 'New 1', content: '', source: 'sdk' },
				{ id: 'acp:new2', name: 'new2', description: 'New 2', content: '', source: 'sdk' },
			]);

			const entries = await catalog.listDropdownEntries({ includeBuiltIns: true });
			expect(entries).toHaveLength(2);
			expect(entries.find(e => e.name === 'old')).toBeUndefined();
		});
	});

	describe('getDropdownConfig', () => {
		it('returns correct config for Hermes', () => {
			const catalog = new HermesCommandCatalog();

			const config = catalog.getDropdownConfig();

			expect(config.providerId).toBe('hermes');
			expect(config.triggerChars).toEqual(['/']);
			expect(config.builtInPrefix).toBe('/');
			expect(config.skillPrefix).toBe('/');
			expect(config.commandPrefix).toBe('/');
		});
	});

	describe('vault operations', () => {
		it('listVaultEntries returns empty array', async () => {
			const catalog = new HermesCommandCatalog();

			const entries = await catalog.listVaultEntries();

			expect(entries).toEqual([]);
		});

		it('saveVaultEntry does not throw', async () => {
			const catalog = new HermesCommandCatalog();

			await expect(catalog.saveVaultEntry({
				id: 'test',
				providerId: 'hermes',
				kind: 'command',
				name: 'test',
				content: '',
				scope: 'vault',
				source: 'user',
				isEditable: true,
				isDeletable: true,
				displayPrefix: '/',
				insertPrefix: '/',
			})).resolves.toBeUndefined();
		});

		it('deleteVaultEntry does not throw', async () => {
			const catalog = new HermesCommandCatalog();

			await expect(catalog.deleteVaultEntry({
				id: 'test',
				providerId: 'hermes',
				kind: 'command',
				name: 'test',
				content: '',
				scope: 'vault',
				source: 'user',
				isEditable: true,
				isDeletable: true,
				displayPrefix: '/',
				insertPrefix: '/',
			})).resolves.toBeUndefined();
		});
	});

	describe('refresh', () => {
		it('does not throw', async () => {
			const catalog = new HermesCommandCatalog();

			await expect(catalog.refresh()).resolves.toBeUndefined();
		});
	});

	describe('vault skill integration', () => {
		const vaultSkills: SlashCommand[] = [
			{ id: 'hermes-skill:llm-wiki', name: 'llm-wiki', description: 'Wiki builder', content: 'wiki prompt', kind: 'skill', source: 'user' },
			{ id: 'hermes-skill:yuanbao', name: 'yuanbao', description: 'Yuanbao skill', content: 'yuanbao prompt', kind: 'skill', source: 'user' },
		];

		it('includes vault skills in dropdown entries', async () => {
			const storage = createMockSkillStorage(vaultSkills);
			const catalog = new HermesCommandCatalog(storage);

			const entries = await catalog.listDropdownEntries({ includeBuiltIns: false });

			expect(entries).toHaveLength(2);
			const wiki = entries.find(e => e.name === 'llm-wiki');
			expect(wiki).toBeDefined();
			expect(wiki!.kind).toBe('skill');
			expect(wiki!.scope).toBe('vault');
			expect(wiki!.isEditable).toBe(false);
			expect(wiki!.isDeletable).toBe(false);
		});

		it('merges vault skills and runtime commands', async () => {
			const storage = createMockSkillStorage(vaultSkills);
			const catalog = new HermesCommandCatalog(storage);

			catalog.setRuntimeCommands([
				{ id: 'acp:search', name: 'search', description: 'Search', content: '', source: 'sdk' },
			]);

			const entries = await catalog.listDropdownEntries({ includeBuiltIns: false });
			expect(entries).toHaveLength(3);
		});

		it('vault skills win on name conflict with runtime commands', async () => {
			const storage = createMockSkillStorage([
				{ id: 'hermes-skill:search', name: 'search', description: 'Vault search', content: '', kind: 'skill', source: 'user' },
			]);
			const catalog = new HermesCommandCatalog(storage);

			catalog.setRuntimeCommands([
				{ id: 'acp:search', name: 'search', description: 'ACP search', content: '', source: 'sdk' },
			]);

			const entries = await catalog.listDropdownEntries({ includeBuiltIns: false });
			expect(entries).toHaveLength(1);
			expect(entries[0].description).toBe('Vault search');
			expect(entries[0].kind).toBe('skill');
		});

		it('returns runtime commands when vault is empty', async () => {
			const storage = createMockSkillStorage([]);
			const catalog = new HermesCommandCatalog(storage);

			catalog.setRuntimeCommands([
				{ id: 'acp:search', name: 'search', description: 'Search', content: '', source: 'sdk' },
			]);

			const entries = await catalog.listDropdownEntries({ includeBuiltIns: false });
			expect(entries).toHaveLength(1);
			expect(entries[0].kind).toBe('command');
		});

		it('listVaultEntries returns skill entries', async () => {
			const storage = createMockSkillStorage(vaultSkills);
			const catalog = new HermesCommandCatalog(storage);

			const entries = await catalog.listVaultEntries();
			expect(entries).toHaveLength(2);
			expect(entries.every(e => e.kind === 'skill')).toBe(true);
		});

		it('refresh clears vault cache', async () => {
			const storage = createMockSkillStorage(vaultSkills);
			const catalog = new HermesCommandCatalog(storage);

			await catalog.listDropdownEntries({ includeBuiltIns: false });
			expect(storage.loadAll).toHaveBeenCalledTimes(1);

			await catalog.refresh();
			await catalog.listDropdownEntries({ includeBuiltIns: false });
			expect(storage.loadAll).toHaveBeenCalledTimes(2);
		});
	});
});
