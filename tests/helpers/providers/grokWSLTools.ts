/** Native payload shapes exercised through both live and history normalization. */
export const grokWSLToolUpdates = [
  { sessionUpdate: 'tool_call', toolCallId: 'directory', title: 'list_dir', status: 'completed', rawInput: { target_directory: '/mnt/c/vault/notes' } },
  { sessionUpdate: 'tool_call', toolCallId: 'edit', title: 'search_replace', status: 'completed',
    rawInput: { file_path: '/mnt/c/vault/note.md', old_string: 'old', new_string: 'new' },
    rawOutput: { type: 'SearchReplace', EditsApplied: { absolute_path: '/mnt/c/vault/note.md',
      edits: { details: [{ old_string: 'old', new_string: 'new', old_line: 1, new_line: 1, context_before: '', context_after: '', line_prefix: '' }] },
    } },
  },
];
