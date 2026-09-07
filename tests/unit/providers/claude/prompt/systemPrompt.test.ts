import {
  buildSystemPrompt,
  computeSystemPromptKey,
} from '@/core/prompt/mainAgent';

describe('systemPrompt', () => {
  describe('buildSystemPrompt', () => {
    it('should produce identical output when dynamic sections are omitted or empty', () => {
      const settings = {
        mediaFolder: 'attachments',
        customPrompt: 'Always be concise.',
        vaultPath: '/vault',
        userName: 'Alice',
      };

      expect(buildSystemPrompt(settings)).toBe(
        buildSystemPrompt(settings, { dynamicSections: [] }),
      );
    });

    it('should retain the complete Claudian context with custom instructions', () => {
      const prompt = buildSystemPrompt(
        {
          customPrompt: 'Use curl if the user explicitly asks for it.',
          vaultPath: '/vault',
          userName: 'Alice',
        },
      );

      expect(prompt).not.toContain('## User Context');
      expect(prompt).toContain(
        "You are Claudian, operating inside **Alice**'s Obsidian Vault. The current working directory is the Vault root.",
      );
      expect(prompt).toContain('## Runtime Context');
      expect(prompt).toContain('Vault absolute path: /vault');
      expect(prompt).toContain('## Path Conventions');
      expect(prompt).toContain('## Reference Conventions');
      expect(prompt).toContain('## User Message Context');
      expect(prompt).not.toContain('## Claudian Response Formatting');
      expect(prompt).not.toContain('## Obsidian Context');
      expect(prompt).not.toContain('## Selection Context');
      expect(prompt).not.toContain('## Current Date');
      expect(prompt).not.toContain('Knowledge Status');
      expect(prompt).toContain('Use `bash: date`');
      expect(prompt).toContain('## Vault Media');
      expect(prompt).toContain('## Custom Instructions');
      expect(prompt).toContain('Use curl if the user explicitly asks for it.');
    });

    it('should append custom prompt section when provided', () => {
      const prompt = buildSystemPrompt({ customPrompt: 'Always be concise.' });
      expect(prompt).toContain('# Custom Instructions');
      expect(prompt).toContain('Always be concise.');
    });

    it('should not append custom prompt section when empty', () => {
      const prompt = buildSystemPrompt({ customPrompt: '   ' });
      expect(prompt).not.toContain('# Custom Instructions');
    });

    it('should not append custom prompt section when undefined', () => {
      const prompt = buildSystemPrompt({});
      expect(prompt).not.toContain('# Custom Instructions');
    });

    it('should include base system prompt elements', () => {
      const prompt = buildSystemPrompt();
      expect(prompt).toContain('Use `bash: date` to get the current date and time. Never guess or assume.');
      expect(prompt).not.toContain('## Current Date');
      expect(prompt).toContain('Claudian');
      expect(prompt).toContain('## Path Conventions');
      expect(prompt).toContain('# User Message Context');
      expect(prompt).not.toContain('Knowledge Status');
      expect(prompt).not.toContain('Core Principles');
    });

    it('should require absolute paths for every filesystem operation', () => {
      const prompt = buildSystemPrompt({ vaultPath: '/vault' });

      expect(prompt).toContain('Always use absolute paths for filesystem and shell operations.');
      expect(prompt).toContain(
        'Resolve Vault-relative context paths against the Vault absolute path before using them.',
      );
      expect(prompt).not.toContain('You always use relative paths.');
      expect(prompt).not.toContain('A leading slash or absolute path will FAIL');
      expect(prompt).not.toContain('External context paths');
    });

    it('should document only current live context shapes', () => {
      const prompt = buildSystemPrompt();

      expect(prompt).toContain('<linked_content path="path/to/content" />');
      expect(prompt).toContain('<editor_cursor path="path/to/note.md" line="8">');
      expect(prompt).toContain('<canvas_selection path="boards/project.canvas">');
      expect(prompt).toContain('<context_file path="/absolute/context" />');
      expect(prompt).not.toContain('Legacy messages may');
      expect(prompt).not.toContain('<linked_note>');
      expect(prompt).not.toContain('<current_note>');
      expect(prompt).toContain('file, Note, or directory');
      expect(prompt).toContain('Inspect only the files needed');
      expect(prompt).toContain('not an instruction to recursively read');
      expect(prompt).toContain('does not change the vault-root working directory');
      expect(prompt).toContain('does not grant access');
      expect(prompt).toContain('Missing Linked content');
    });

    it('should document selection context and image embeds without duplicate sections', () => {
      const prompt = buildSystemPrompt();

      expect(prompt).not.toContain('## Selection Context');
      expect(prompt.match(/<editor_selection path=/g)).toHaveLength(1);
      expect(prompt.match(/<browser_selection source=/g)).toHaveLength(1);
      expect(prompt.match(/Use `!\[\[image\.png\]\]`/g)).toHaveLength(1);
    });

    it('should place both convention sections after user message context', () => {
      const prompt = buildSystemPrompt();

      expect(prompt.indexOf('## User Message Context')).toBeLessThan(
        prompt.indexOf('## Path Conventions'),
      );
      expect(prompt.indexOf('## Path Conventions')).toBeLessThan(
        prompt.indexOf('## Reference Conventions'),
      );
      expect(prompt).toContain('use Obsidian wikilinks so they are clickable');
      expect(prompt).toContain('Use `![[image.png]]` to render Vault images directly in chat.');
      expect(prompt).not.toContain('**Structure**');
      expect(prompt).not.toContain('**Frontmatter**');
      expect(prompt).not.toContain('**Tags**');
      expect(prompt).not.toContain('Dataview');
      expect(prompt).not.toContain('**Vault Config**');
    });

    it('should omit Claude-specific tool guidance from the shared prompt', () => {
      const prompt = buildSystemPrompt();

      expect(prompt).not.toContain('## Tool Usage Guidelines');
      expect(prompt).not.toContain('### WebSearch');
      expect(prompt).not.toContain('### Agent (Subagents)');
      expect(prompt).not.toContain('### TodoWrite');
      expect(prompt).not.toContain('### Skills');
    });

  });

  describe('userName in runtime context', () => {
    it('should identify the named user as the Vault owner', () => {
      const prompt = buildSystemPrompt({ userName: 'Alice' });
      expect(prompt).toContain('## Runtime Context');
      expect(prompt).not.toContain('## User Context');
      expect(prompt).toContain(
        "You are Claudian, operating inside **Alice**'s Obsidian Vault. The current working directory is the Vault root.",
      );
      expect(prompt).not.toContain('You are collaborating with');
    });

    it('should use the generic user when userName is empty', () => {
      const prompt = buildSystemPrompt({ userName: '' });
      expect(prompt).toContain("operating inside the user's Obsidian Vault.");
    });

    it('should use the generic user when userName is whitespace only', () => {
      const prompt = buildSystemPrompt({ userName: '   ' });
      expect(prompt).toContain("operating inside the user's Obsidian Vault.");
    });

    it('should use the generic user when userName is undefined', () => {
      const prompt = buildSystemPrompt({});
      expect(prompt).toContain("operating inside the user's Obsidian Vault.");
    });

    it('should trim whitespace from userName', () => {
      const prompt = buildSystemPrompt({ userName: '  Bob  ' });
      expect(prompt).toContain("operating inside **Bob**'s Obsidian Vault.");
      expect(prompt).not.toContain('**  Bob  **');
    });
  });

  describe('media folder instructions', () => {
    it('should use vault root path when mediaFolder is empty', () => {
      const prompt = buildSystemPrompt({ mediaFolder: '' });
      expect(prompt).toContain('Configured Vault media folder: `.`');
      expect(prompt).toContain('relative to the Vault root');
      expect(prompt).toContain('use its absolute path for file operations');
    });

    it('should use vault root path when mediaFolder is whitespace only', () => {
      const prompt = buildSystemPrompt({ mediaFolder: '   ' });
      expect(prompt).toContain('Configured Vault media folder: `.`');
    });

    it('should use custom mediaFolder path when provided', () => {
      const prompt = buildSystemPrompt({ mediaFolder: 'attachments' });
      expect(prompt).toContain('Configured Vault media folder: `attachments`');
    });

    it('should handle mediaFolder with special characters', () => {
      const prompt = buildSystemPrompt({ mediaFolder: '- attachments' });
      expect(prompt).toContain('Configured Vault media folder: `- attachments`');
    });

    it('should omit generic image recipes and relative operation paths', () => {
      const prompt = buildSystemPrompt({ mediaFolder: 'media' });
      expect(prompt).not.toContain('WebFetch');
      expect(prompt).not.toContain('curl');
      expect(prompt).not.toContain('Read file_path=');
      expect(prompt).not.toContain('**Benefits**');
    });
  });

  describe('computeSystemPromptKey', () => {
    it('includes dynamic sections in the prompt key', () => {
      const settings = {
        mediaFolder: 'attachments',
        customPrompt: 'Be helpful',
        vaultPath: '/vault',
        userName: 'Alice',
      };

      const defaultKey = computeSystemPromptKey(settings);
      const dynamicKey = computeSystemPromptKey(settings, {
        dynamicSections: ['## Collab Mode\nRuntime guidance.'],
      });

      expect(dynamicKey).not.toBe(defaultKey);
    });

    it('computes key from all settings', () => {
      const settings = {
        mediaFolder: 'attachments',
        customPrompt: 'Be helpful',
        vaultPath: '/vault',
        userName: 'Alice',
      };

      const key = computeSystemPromptKey(settings);

      expect(key).toBe('attachments::Be helpful::/vault::Alice');
    });

    it('handles empty or undefined values', () => {
      const key = computeSystemPromptKey({
        mediaFolder: '',
        customPrompt: '',
        vaultPath: '',
        userName: '',
      });

      expect(key).toBe('::::::');
    });
  });
});
