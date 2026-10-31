import type { ExecutionTarget } from '@/core/process/execution-target/types';
import type { ToolCallInfo, ToolResultDetails } from '@/core/types';
import {
  mapClaudeHistoryToolPaths, mapClaudeToolInputPaths, mapClaudeToolResultPaths, toClaudeHostPath,
} from '@/providers/claude/normalization/claudePaths';

const wsl: ExecutionTarget = { method: 'wsl', platformFamily: 'unix', platformOs: 'linux', distroName: 'Ubuntu' };
const native: ExecutionTarget = { method: 'host-native', platformFamily: 'unix', platformOs: 'linux' };
const linuxFile = '/home/me/note.md';
const hostFile = '\\\\wsl$\\Ubuntu\\home\\me\\note.md';

describe('Claude WSL host paths', () => {
  it.each([
    ['/mnt/c/Vault/note.md', 'C:\\Vault\\note.md'],
    [linuxFile, hostFile],
    ['notes/relative.md', 'notes/relative.md'],
  ])('maps native %s to %s', (value, expected) => {
    expect(toClaudeHostPath(value, wsl)).toBe(expected);
  });

  it('keeps native paths without a WSL target and refuses an unmappable distro path', () => {
    expect(toClaudeHostPath(linuxFile, native)).toBe(linuxFile);
    expect(toClaudeHostPath(linuxFile)).toBe(linuxFile);
    // Without a known distro, a Linux-only path has no host location.
    expect(() => toClaudeHostPath(linuxFile, { ...wsl, distroName: undefined }))
      .toThrow('Unable to map Claude Code path to the host');
  });

  it.each([
    ['Read', 'file_path'], ['Write', 'file_path'], ['Edit', 'file_path'], ['MultiEdit', 'file_path'],
    ['NotebookEdit', 'notebook_path'], ['Glob', 'path'], ['Grep', 'path'], ['LS', 'path'],
  ])('maps the %s %s field and leaves literal text alone', (name, field) => {
    const input = { [field]: linuxFile, pattern: linuxFile, other: 1 };
    expect(mapClaudeToolInputPaths(name, input, wsl)).toEqual({ ...input, [field]: hostFile });
    expect(input[field]).toBe(linuxFile);
  });

  it('leaves unknown tools, non-string fields and host-native inputs unchanged', () => {
    const bash = { command: `cat ${linuxFile}`, file_path: linuxFile };
    expect(mapClaudeToolInputPaths('Bash', bash, wsl)).toEqual(bash);
    expect(mapClaudeToolInputPaths('Read', { file_path: 42 }, wsl)).toEqual({ file_path: 42 });
    const read = { file_path: linuxFile };
    expect(mapClaudeToolInputPaths('Read', read, native)).toBe(read);
  });

  it('maps a result diff path only for WSL', () => {
    const diff = { diffLines: [], stats: { added: 0, removed: 0 } };
    const details: ToolResultDetails = { diff: { ...diff, filePath: linuxFile } };
    expect(mapClaudeToolResultPaths(details, wsl)).toEqual({ diff: { ...diff, filePath: hostFile } });
    expect(details.diff?.filePath).toBe(linuxFile);
    expect(mapClaudeToolResultPaths(details, native)).toBe(details);
    const plain = { resultFormat: 'plain' as const };
    expect(mapClaudeToolResultPaths(plain, wsl)).toBe(plain);
    expect(mapClaudeToolResultPaths(undefined, wsl)).toBeUndefined();
  });

  it('maps restored history tools, their diffs and nested subagent tools', () => {
    const tool = (id: string, children: ToolCallInfo[] = []): ToolCallInfo => ({
      id, name: 'Edit', input: { file_path: linuxFile }, status: 'completed',
      diffData: { filePath: linuxFile, diffLines: [], stats: { added: 0, removed: 0 } },
      ...(children.length ? { subagent: { id: `${id}-agent`, description: 'Work', isExpanded: false, status: 'completed', toolCalls: children } } : {}),
    });
    const parent = tool('parent', [tool('child')]);
    mapClaudeHistoryToolPaths(parent, wsl);
    expect(parent.input.file_path).toBe(hostFile);
    expect(parent.diffData?.filePath).toBe(hostFile);
    expect(parent.subagent?.toolCalls[0].input.file_path).toBe(hostFile);
    expect(parent.subagent?.toolCalls[0].diffData?.filePath).toBe(hostFile);

    const untouched = tool('native');
    mapClaudeHistoryToolPaths(untouched, native);
    expect(untouched.input.file_path).toBe(linuxFile);
    expect(untouched.diffData?.filePath).toBe(linuxFile);
  });
});
