import { buildSystemPrompt } from '@/core/prompt/mainAgent';

it('explains how to identify files from aliased wikilinks in user messages', () => {
  const prompt = buildSystemPrompt({ vaultPath: '/vault' });
  expect(prompt).toContain(
    '`[[vault-relative-path|display-name]]`: A Vault file reference. The text before `|` is the file path relative to the Vault root; the text after `|` is only a display label. Use the path, not the label, to identify the file.',
  );
});
