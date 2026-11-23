import { testDate } from '@test/helpers/testClock';

import type { GuardianReviewAction } from '@/providers/codex/runtime/codexAppServerTypes';
import { guardianOverrideParams, reviewActionSummary } from '@/providers/codex/runtime/notifications/codexAutoReview';

const entries = [{ path: { type: 'glob_pattern' as const, pattern: '**/private' }, access: 'deny' as const }];

it.each<[GuardianReviewAction, unknown]>([
  [{ type: 'command', source: 'unifiedExec', command: 'pwd', cwd: '/vault' },
    { type: 'command', source: 'unified_exec', command: 'pwd', cwd: '/vault' }],
  [{ type: 'execve', source: 'shell', program: '/bin/ls', argv: ['ls', 'two words'], cwd: '/vault' },
    { type: 'execve', source: 'shell', program: '/bin/ls', argv: ['ls', 'two words'], cwd: '/vault' }],
  [{ type: 'writeStdin', approvalId: 'a', processId: 'p', cwd: 'C:\\My Vault', stdin: 'yes\n' },
    { type: 'write_stdin', approval_id: 'a', process_id: 'p', cwd: 'file:///C:/My%20Vault', stdin: 'yes\n' }],
  [{ type: 'writeStdin', approvalId: 'a', processId: 'p', cwd: '/mnt/c/My Vault', stdin: '\n' },
    { type: 'write_stdin', approval_id: 'a', process_id: 'p', cwd: 'file:///mnt/c/My%20Vault', stdin: '\n' }],
  [{ type: 'applyPatch', cwd: '/vault', files: ['one.md', 'two.md'] },
    { type: 'apply_patch', cwd: '/vault', files: ['one.md', 'two.md'] }],
  [{ type: 'mcpToolCall', server: 'docs', toolName: 'read', toolTitle: 'Read docs', connectorId: 'kb', connectorName: 'KB' },
    { type: 'mcp_tool_call', server: 'docs', tool_name: 'read', tool_title: 'Read docs', connector_id: 'kb', connector_name: 'KB' }],
  [{ type: 'requestPermissions', reason: 'Index files', permissions: { fileSystem: { read: ['/old'], entries, globScanMaxDepth: 4 } } },
    { type: 'request_permissions', reason: 'Index files', permissions: { file_system: { entries, glob_scan_max_depth: 4 } } }],
  [{ type: 'requestPermissions', reason: null, permissions: { fileSystem: { read: ['/vault'], write: null, globScanMaxDepth: 2 }, network: { enabled: true } } },
    { type: 'request_permissions', reason: null, permissions: { file_system: { entries: [{ path: { type: 'path', path: '/vault' }, access: 'read' }], glob_scan_max_depth: 2 }, network: { enabled: true } } }],
])('serializes $type for the native Guardian denial override', (action, expected) => {
  const params = guardianOverrideParams({
    threadId: 'thread', turnId: 'turn', reviewId: 'r', decisionSource: 'agent', targetItemId: null,
    startedAtMs: testDate().getTime(), completedAtMs: testDate({ seconds: 1 }).getTime(),
    action, review: { status: 'denied', rationale: null, riskLevel: null, userAuthorization: null },
  });
  expect(params.event.action).toEqual(expected);
});

it.each<[GuardianReviewAction, unknown]>([
  [{ type: 'command', source: 'shell', command: 'npm install', cwd: '/vault/site' }, { kind: 'command', subject: 'npm install', location: '/vault/site' }],
  [{ type: 'execve', source: 'shell', program: '/bin/ls', argv: ['ls', 'two words'], cwd: '/vault' }, { kind: 'command', subject: '/bin/ls ["ls","two words"]', location: '/vault' }],
  [{ type: 'writeStdin', approvalId: 'a', processId: 'p', cwd: '/vault', stdin: 'yes\n' }, { kind: 'terminal-input', subject: 'Terminal input for p: "yes\\n"', location: '/vault' }],
  [{ type: 'applyPatch', cwd: '/vault', files: ['one.md', '../two.md'] }, { kind: 'file-change', subject: 'one.md, ../two.md', location: '/vault' }],
  [{ type: 'networkAccess', target: 'https://registry.example/pkg', host: 'registry.example', protocol: 'https', port: 443 }, { kind: 'network', subject: 'https://registry.example/pkg', location: 'registry.example:443' }],
  [{ type: 'mcpToolCall', server: 'docs', toolName: 'read', toolTitle: null, connectorId: null, connectorName: null }, { kind: 'tool', subject: 'docs/read' }],
  [{ type: 'requestPermissions', reason: 'Index files', permissions: { network: { enabled: true } } }, { kind: 'permissions', subject: 'Index files · {"network":{"enabled":true}}' }],
])('summarizes $type for the retry picker', (action, expected) => {
  expect(reviewActionSummary(action)).toEqual(expected);
});
