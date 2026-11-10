import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parseDocument, stringify } from 'yaml';

export const ANTIGRAVITY_MAIN_TOOLS = [
  'run_command', 'manage_task', 'read_file', 'write_file', 'edit_file', 'search_web',
  'ask_question', 'generate_image',
] as const;

export const ANTIGRAVITY_INLINE_EDIT_TOOLS = ['read_file', 'search_web', 'run_command'] as const;

const OWNERSHIP_DESCRIPTION = 'Managed by Claudian. Do not edit.';

/** Prepare only for session/new: agy stores the persona and tools in the native session. */
export async function prepareAntigravityAgentFile(
  cwd: string,
  name: string,
  body: string,
  tools: readonly string[],
): Promise<void> {
  const file = path.join(cwd, '.agents', 'agents', name, 'agent.md');
  let temporary: string | undefined;
  try {
    let existing: string | undefined;
    try {
      existing = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (existing !== undefined && !isOwnedAgent(existing, name)) {
      throw new Error('The existing agent file is malformed or is not owned by Claudian.');
    }
    const contents = `---\n${stringify({
      name,
      description: OWNERSHIP_DESCRIPTION,
      mainAgent: true,
      subagent: false,
      excludeDefaultComponents: true,
      tools: [...tools],
    })}---\n${body}`;
    if (existing === contents) return;
    await mkdir(path.dirname(file), { recursive: true });
    temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, contents, { flag: 'wx' });
    await rename(temporary, file);
  } catch (error) {
    throw new Error(`Cannot prepare Antigravity agent file ${file}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally {
    if (temporary) await unlink(temporary).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`Cannot remove temporary Antigravity agent file for ${file}: ${String(error)}`, { cause: error });
      }
    });
  }
}

function isOwnedAgent(contents: string, name: string): boolean {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(contents);
  if (!match) return false;
  const document = parseDocument(match[1]);
  if (document.errors.length > 0) return false;
  const value: unknown = document.toJS();
  if (!value || typeof value !== 'object') return false;
  const fields = value as Record<string, unknown>;
  return fields.name === name && fields.description === OWNERSHIP_DESCRIPTION
    && typeof fields.mainAgent === 'boolean' && typeof fields.subagent === 'boolean'
    && typeof fields.excludeDefaultComponents === 'boolean'
    && Array.isArray(fields.tools) && fields.tools.every(tool => typeof tool === 'string');
}
