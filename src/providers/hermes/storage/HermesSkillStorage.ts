import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { SlashCommand } from '../../../core/types';
import { parseFrontmatter } from '../../../utils/frontmatter';

const HERMES_SKILLS_ROOT = '.hermes/skills';
const SKILL_FILENAME = 'SKILL.md';

function extractSkillName(filePath: string, root: string): string {
	// Derive name from the parent directory: <root>/.../category/<name>/SKILL.md → <name>
	const dir = path.dirname(filePath);
	const relative = path.relative(root, dir);
	const segments = relative.split(path.sep);
	return segments.length > 0 ? segments[segments.length - 1] : '';
}

async function globSkillFiles(rootDir: string): Promise<string[]> {
	const results: string[] = [];

	async function walk(dir: string): Promise<void> {
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(fullPath);
			} else if (entry.isFile() && entry.name === SKILL_FILENAME) {
				results.push(fullPath);
			}
		}
	}

	await walk(rootDir);
	return results;
}

function parseSkillFile(filePath: string, rootDir: string): SlashCommand | null {
	let content: string;
	try {
		content = fs.readFileSync(filePath, 'utf-8');
	} catch {
		return null;
	}

	const parsed = parseFrontmatter(content);
	if (!parsed) return null;

	const fm = parsed.frontmatter;

	// Name from frontmatter, fallback to parent directory
	const dirName = extractSkillName(filePath, rootDir);
	const name = typeof fm.name === 'string' && fm.name.trim()
		? fm.name.trim()
		: dirName;

	if (!name) return null;

	const description = typeof fm.description === 'string' ? fm.description : undefined;

	return {
		argumentHint: undefined,
		content: parsed.body,
		description,
		id: `hermes-skill:${name}`,
		kind: 'skill',
		name,
		source: 'user',
	};
}

export class HermesSkillStorage {
	private readonly homeDir: string;

	constructor(
		private readonly getProfile: () => string,
		homeDir?: string,
	) {
		this.homeDir = homeDir ?? os.homedir();
	}

	async loadAll(): Promise<SlashCommand[]> {
		const skillsByName = new Map<string, SlashCommand>();

		// Scan global skills
		const globalRoot = path.join(this.homeDir, HERMES_SKILLS_ROOT);
		await this.scanRoot(globalRoot, skillsByName);

		// Scan profile skills (profile wins on conflict)
		const profile = this.getProfile();
		if (profile) {
			const profileRoot = path.join(this.homeDir, '.hermes', 'profiles', profile, 'skills');
			await this.scanRoot(profileRoot, skillsByName);
		}

		return Array.from(skillsByName.values());
	}

	private async scanRoot(rootDir: string, skillsByName: Map<string, SlashCommand>): Promise<void> {
		const files = await globSkillFiles(rootDir);

		for (const filePath of files) {
			const skill = parseSkillFile(filePath, rootDir);
			if (skill) {
				skillsByName.set(skill.name, skill);
			}
		}
	}
}
