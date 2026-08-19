export interface SystemPromptSettings {
  mediaFolder?: string;
  customPrompt?: string;
  vaultPath?: string;
  userName?: string;
}

export interface SystemPromptBuildOptions {
  dynamicSections?: string[];
}

function getRuntimeContext(
  vaultPath: string | undefined,
  userName: string | undefined,
): string {
  const trimmedUserName = userName?.trim();
  const vaultOwner = trimmedUserName ? `**${trimmedUserName}**'s` : "the user's";
  const lines = [
    `You are Claudian, operating inside ${vaultOwner} Obsidian Vault. The current working directory is the Vault root.`,
  ];
  if (vaultPath) {
    lines.push(`Vault absolute path: ${vaultPath}`);
  }
  lines.push('Use `bash: date` to get the current date and time. Never guess or assume.');

  return `## Runtime Context

${lines.join('\n')}`;
}

function getUserMessageContext(): string {
  return `## User Message Context

The user's query comes first, followed by optional Claudian XML context tags. Treat content inside \`<![CDATA[...]]>\` as the user's literal text.

- \`<linked_content path="path/to/content" />\`: The Conversation's primary file, Note, or directory.
- Inspect only the files needed for the user's request. A linked directory is not an instruction to recursively read or summarize the entire directory.
- Linked content does not change the vault-root working directory, does not grant access outside the existing sandbox, and does not prevent work elsewhere in the Vault.
- Missing Linked content may have been deleted or renamed. Report that state instead of guessing a replacement.
- \`<editor_selection path="path/to/note.md" lines="10-15">\`: Selected editor text.
- \`<editor_cursor path="path/to/note.md" line="8">\`: Text around the editor cursor.
- \`<browser_selection source="browser:https://example.com" title="Example" url="https://example.com">\`: Selected browser-view text.
- \`<canvas_selection path="boards/project.canvas">\`: Selected Canvas node IDs.
- \`<context_files><context_file path="/absolute/context" /></context_files>\`: Additional file or directory references.
- \`@filename.md\`: A Vault file mentioned in the query; read it when relevant.`;
}

function getPathConventions(): string {
  return `## Path Conventions

- Always use absolute paths for filesystem and shell operations.
- Do not rely on the current working directory when constructing an operation path.
- Resolve Vault-relative context paths against the Vault absolute path before using them.
- If a supplied context path is already absolute, use it directly.
- This path rule does not expand the directories available under the active sandbox or permission policy.`;
}

function getReferenceConventions(): string {
  return `## Reference Conventions

- When mentioning Vault files in responses, use Obsidian wikilinks so they are clickable: \`[[folder/note.md]]\` or \`[[note]]\`.
- Use \`![[image.png]]\` to render Vault images directly in chat.`;
}

function getVaultMediaContext(mediaFolder: string): string {
  const folder = mediaFolder.trim();
  const mediaPath = folder || '.';

  return `## Vault Media

- Configured Vault media folder: \`${mediaPath}\`, relative to the Vault root.
- Resolve embedded media through this folder and use its absolute path for file operations.`;
}

function getDynamicSections(dynamicSections?: string[]): string {
  if (!dynamicSections || dynamicSections.length === 0) {
    return '';
  }

  const sections = dynamicSections
    .map((section) => section.trim())
    .filter(Boolean);

  if (sections.length === 0) {
    return '';
  }

  return sections.join('\n\n');
}

function getCustomInstructions(customPrompt: string | undefined): string {
  const instructions = customPrompt?.trim();
  return instructions ? `## Custom Instructions\n\n${instructions}` : '';
}

export function buildSystemPrompt(
  settings: SystemPromptSettings = {},
  options: SystemPromptBuildOptions = {},
): string {
  return [
    getRuntimeContext(settings.vaultPath, settings.userName),
    getUserMessageContext(),
    getPathConventions(),
    getReferenceConventions(),
    getVaultMediaContext(settings.mediaFolder || ''),
    getDynamicSections(options.dynamicSections),
    getCustomInstructions(settings.customPrompt),
  ].filter(Boolean).join('\n\n');
}

export function computeSystemPromptKey(
  settings: SystemPromptSettings,
  options: SystemPromptBuildOptions = {},
): string {
  const dynamicSectionsKey = (options.dynamicSections || [])
    .map((section) => section.trim())
    .filter(Boolean)
    .join('||');

  const parts = [
    settings.mediaFolder || '',
    settings.customPrompt || '',
    settings.vaultPath || '',
    (settings.userName || '').trim(),
  ];

  if (dynamicSectionsKey) {
    parts.push(dynamicSectionsKey);
  }

  return parts.join('::');
}
