// @test-ci {"native":true,"inputs":["tests/helpers/providers/opencode/OpencodeNativePeer.cjs"]}
import { createFixture, turn } from '@test/helpers/providers/opencode/OpencodeSharedServerFixture';

import type { ProviderExecutionEvent, ProviderToolPolicy } from '@/core/execution';

it.each<{ policy: ProviderToolPolicy; agent: string }>([
  { policy: { kind: 'passive' }, agent: 'claudian-title' },
  { policy: { kind: 'read-only' }, agent: 'claudian-inline-edit' },
  { policy: { kind: 'provider-default' }, agent: 'build' },
  { policy: { kind: 'unrestricted' }, agent: 'build' },
  { policy: { kind: 'allow-list', names: ['custom-approved-tool'] }, agent: 'claudian-title' },
])('executes $policy.kind with the native $agent policy', async ({ policy, agent }) => {
  const f = await createFixture();
  const managed = policy.kind === 'provider-default';
  const session = f.createSession({ lifecycle: managed ? 'persistent' : 'ephemeral', nativePersistence: managed ? 'enabled' : 'disabled-if-supported' });
  const control = await f.workspace.serverService.acquire(f.cli, f.root, f.environment);
  try {
    await f.workspace.metadataService.loadCatalog();
    const events: ProviderExecutionEvent[] = [];
    for await (const event of session.execute({ ...turn('policy'), toolPolicy: policy }).events) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: 'turn_completed' });
    const { data } = await control.request<{ data: { agents: string[] } }>('/fixture/system');
    const selected = data.agents.filter(id => id.startsWith(`${agent}-`));
    expect(selected).toHaveLength(1);
    expect(data.agents.some(id => id.startsWith('claudian-inline-edit-'))).toBe(agent === 'claudian-inline-edit');
    const config = await control.request<{ data: { config: { agent: Record<string, { permission?: Record<string, unknown> }> } } }>('/fixture/config');
    const permissions = config.data.config.agent[agent]?.permission;
    expect(permissions?.['*']).toBe(agent === 'build' ? undefined : 'deny');
    const allowedReads = expect.objectContaining({ '*': 'allow', '*.env': 'deny' });
    expect(permissions?.read).toEqual(agent === 'claudian-inline-edit' ? allowedReads : undefined);
    expect(permissions?.external_directory).toBe(agent === 'build' ? undefined : 'deny');
  } finally { await session.dispose(); await control.dispose(); await f.dispose(); }
});
