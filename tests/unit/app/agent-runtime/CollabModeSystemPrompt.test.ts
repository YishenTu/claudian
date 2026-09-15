import { buildCollabModeSystemPrompt } from '@/app/agent-runtime/CollabModeSystemPrompt';

describe('buildCollabModeSystemPrompt', () => {
  it('interpolates the advertised runtime endpoint', () => {
    const text = buildCollabModeSystemPrompt({
      origin: 'http://127.0.0.1:61234',
      rpcUrl: 'http://127.0.0.1:61234/v1/rpc',
    });

    expect(text).toContain('http://127.0.0.1:61234/v1/rpc');
  });
});
