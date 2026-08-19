import { buildCollabModeSystemPrompt } from '@/app/agent-runtime/CollabModeSystemPrompt';

describe('buildCollabModeSystemPrompt', () => {
  it('builds stable endpoint-only Collab guidance', () => {
    const text = buildCollabModeSystemPrompt({
      origin: 'http://127.0.0.1:61234',
      rpcUrl: 'http://127.0.0.1:61234/v1/rpc',
    });

    expect(text).toContain('## Collab Mode');
    expect(text).toContain('http://127.0.0.1:61234/v1/rpc');
    expect(text).toContain('runtime.operations.list');
    expect(text).toContain('runtime.operations.get');
    expect(text).toContain('exact parameter contract');
    expect(text).toContain("@<exact display name>'s Changes");
    expect(text).toContain('#<number>');
    expect(text).toContain('selectedProjectId');
    expect(text).toContain('pass it explicitly to every downstream Project-scoped operation');
    expect(text).toContain('never guess');
    expect(text).toContain('access is write');
    expect(text).toContain('mutates Collab state immediately');
    expect(text).toContain('does not navigate the Obsidian UI');
    expect(text).toContain('immutable conflict');
    expect(text).toContain('edit the real Project files');
    expect(text).toContain('collab.changes.publish');
    expect(text).toContain('Do not edit a Request snapshot');
    expect(text).toContain('LAN or Cloud');
    expect(text).toContain('Tickets');
    expect(text).not.toContain('current turn only');
    expect(text).not.toContain('collab.projects.list');
    expect(text).not.toContain('system.describe');
    expect(text).not.toContain('system.ping');
    expect(text).not.toContain('owns Project selection');
    expect(text).not.toContain('/Users/');
  });
});
