import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { HermesSkillStorage } from '@/providers/hermes/storage/HermesSkillStorage';

function createTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-skill-test-'));
}

const SKILLS_DIR = ['.hermes', 'skills'];

function writeSkill(homeDir: string, ...categoryAndName: string[]): void {
	const segments = [...SKILLS_DIR, ...categoryAndName];
	const skillPath = path.join(homeDir, ...segments, 'SKILL.md');
	fs.mkdirSync(path.dirname(skillPath), { recursive: true });
	fs.writeFileSync(skillPath, `---
name: ${categoryAndName[categoryAndName.length - 1]}
description: "A test skill"
---

Skill content here.
`);
}

function writeSkillWithCustomName(homeDir: string, categoryAndName: string[], name: string, description?: string): void {
	const segments = [...SKILLS_DIR, ...categoryAndName];
	const skillPath = path.join(homeDir, ...segments, 'SKILL.md');
	fs.mkdirSync(path.dirname(skillPath), { recursive: true });
	const desc = description ?? 'Custom skill';
	fs.writeFileSync(skillPath, `---
name: ${name}
description: "${desc}"
---

Custom content.
`);
}

function writeNonSkillFile(homeDir: string, ...segments: string[]): void {
	const filePath = path.join(homeDir, ...SKILLS_DIR, ...segments, 'README.md');
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, 'Not a skill file');
}

describe('HermesSkillStorage', () => {
	let homeDir: string;

	beforeEach(() => {
		homeDir = createTempDir();
	});

	afterEach(() => {
		fs.rmSync(homeDir, { recursive: true, force: true });
	});

	it('discovers nested skills', async () => {
		writeSkill(homeDir, 'research', 'llm-wiki');
		const storage = new HermesSkillStorage(() => '', homeDir);

		const skills = await storage.loadAll();

		expect(skills).toHaveLength(1);
		expect(skills[0].name).toBe('llm-wiki');
		expect(skills[0].description).toBe('A test skill');
		expect(skills[0].kind).toBe('skill');
		expect(skills[0].source).toBe('user');
		expect(skills[0].id).toBe('hermes-skill:llm-wiki');
	});

	it('discovers flat skills without category', async () => {
		writeSkill(homeDir, 'yuanbao');
		const storage = new HermesSkillStorage(() => '', homeDir);

		const skills = await storage.loadAll();

		expect(skills).toHaveLength(1);
		expect(skills[0].name).toBe('yuanbao');
	});

	it('discovers deeply nested skills', async () => {
		writeSkill(homeDir, 'mlops', 'training', 'peft');
		const storage = new HermesSkillStorage(() => '', homeDir);

		const skills = await storage.loadAll();

		expect(skills).toHaveLength(1);
		expect(skills[0].name).toBe('peft');
	});

	it('discovers multiple skills across categories', async () => {
		writeSkill(homeDir, 'research', 'llm-wiki');
		writeSkill(homeDir, 'creative', 'story-gen');
		writeSkill(homeDir, 'devops', 'deploy');
		const storage = new HermesSkillStorage(() => '', homeDir);

		const skills = await storage.loadAll();

		expect(skills).toHaveLength(3);
		const names = skills.map(s => s.name).sort();
		expect(names).toEqual(['deploy', 'llm-wiki', 'story-gen']);
	});

	it('returns empty when directory does not exist', async () => {
		const missingDir = path.join(homeDir, 'nonexistent');
		const storage = new HermesSkillStorage(() => '', missingDir);

		const skills = await storage.loadAll();

		expect(skills).toEqual([]);
	});

	it('ignores non-SKILL.md files', async () => {
		writeSkill(homeDir, 'research', 'llm-wiki');
		writeNonSkillFile(homeDir, 'research');
		const storage = new HermesSkillStorage(() => '', homeDir);

		const skills = await storage.loadAll();

		expect(skills).toHaveLength(1);
		expect(skills[0].name).toBe('llm-wiki');
	});

	it('uses frontmatter name over directory name', async () => {
		writeSkillWithCustomName(homeDir, ['tools', 'my-dir'], 'custom-name', 'Custom description');
		const storage = new HermesSkillStorage(() => '', homeDir);

		const skills = await storage.loadAll();

		expect(skills).toHaveLength(1);
		expect(skills[0].name).toBe('custom-name');
		expect(skills[0].description).toBe('Custom description');
	});

	it('falls back to directory name when frontmatter has no name', async () => {
		const skillPath = path.join(homeDir, '.hermes', 'skills', 'tools', 'fallback-name', 'SKILL.md');
		fs.mkdirSync(path.dirname(skillPath), { recursive: true });
		fs.writeFileSync(skillPath, `---
description: "No name field"
---

Content.
`);
		const storage = new HermesSkillStorage(() => '', homeDir);

		const skills = await storage.loadAll();

		expect(skills).toHaveLength(1);
		expect(skills[0].name).toBe('fallback-name');
	});

	it('skips files without frontmatter', async () => {
		const skillPath = path.join(homeDir, '.hermes', 'skills', 'broken', 'SKILL.md');
		fs.mkdirSync(path.dirname(skillPath), { recursive: true });
		fs.writeFileSync(skillPath, 'No frontmatter here');
		const storage = new HermesSkillStorage(() => '', homeDir);

		const skills = await storage.loadAll();

		expect(skills).toEqual([]);
	});

	it('scans profile skills when profile is set', async () => {
		writeSkill(homeDir, 'research', 'llm-wiki');

		// Profile skill
		const profileSkillPath = path.join(homeDir, '.hermes', 'profiles', 'coding', 'skills', 'code-gen', 'SKILL.md');
		fs.mkdirSync(path.dirname(profileSkillPath), { recursive: true });
		fs.writeFileSync(profileSkillPath, `---
name: code-gen
description: "Code gen skill"
---

Content
`);

		const storage = new HermesSkillStorage(() => 'coding', homeDir);
		const skills = await storage.loadAll();

		expect(skills).toHaveLength(2);
		const names = skills.map(s => s.name).sort();
		expect(names).toEqual(['code-gen', 'llm-wiki']);
	});

	it('profile skills override global skills on name conflict', async () => {
		// Global skill
		writeSkill(homeDir, 'my-skill');

		// Profile skill with same name
		const profileSkillPath = path.join(homeDir, '.hermes', 'profiles', 'coding', 'skills', 'my-skill', 'SKILL.md');
		fs.mkdirSync(path.dirname(profileSkillPath), { recursive: true });
		fs.writeFileSync(profileSkillPath, `---
name: my-skill
description: "Profile version"
---

Profile
`);

		const storage = new HermesSkillStorage(() => 'coding', homeDir);
		const skills = await storage.loadAll();

		expect(skills).toHaveLength(1);
		expect(skills[0].description).toBe('Profile version');
	});

	it('returns global skills only when profile is empty', async () => {
		writeSkill(homeDir, 'global-skill');
		const storage = new HermesSkillStorage(() => '', homeDir);
		const skills = await storage.loadAll();

		expect(skills).toHaveLength(1);
		expect(skills[0].name).toBe('global-skill');
	});

	it('does not error when profile directory is missing', async () => {
		writeSkill(homeDir, 'my-skill');
		const storage = new HermesSkillStorage(() => 'nonexistent-profile', homeDir);
		const skills = await storage.loadAll();

		expect(skills).toHaveLength(1);
		expect(skills[0].name).toBe('my-skill');
	});
});
