// @test-ci {"inputs":["tests/fixtures/providers/antigravity/history/**"]}
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { ProviderHistoryEnvironment, ProviderHistoryInput } from '@/core/providers/types';
import { AntigravityConversationHistoryService } from '@/providers/antigravity/history/AntigravityConversationHistoryService';

const FIXTURE = path.resolve('tests/fixtures/providers/antigravity/history/transcript_full.jsonl');
const service = new AntigravityConversationHistoryService();
let home: string;
let pathContext: ProviderHistoryEnvironment;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-antigravity-home-'));
  pathContext = { environment: { HOME: home, USERPROFILE: home }, hostPlatform: process.platform };
});

afterEach(async () => {
  await fs.rm(home, { force: true, recursive: true });
});

async function installTranscript(sessionId: string): Promise<void> {
  const logs = path.join(home, '.gemini', 'antigravity-cli', 'brain', sessionId, '.system_generated', 'logs');
  await fs.mkdir(logs, { recursive: true });
  await fs.copyFile(FIXTURE, path.join(logs, 'transcript_full.jsonl'));
}

function conversation(overrides: Partial<ProviderHistoryInput>): ProviderHistoryInput {
  return { messages: [], providerState: undefined, sessionId: null, ...overrides } as ProviderHistoryInput;
}

describe('AntigravityConversationHistoryService', () => {
  it('keeps a missing session recoverable from its surviving transcript', async () => {
    await installTranscript('session-lost');
    const bound = conversation({ providerState: { unrelated: 'kept' }, sessionId: 'session-lost' });

    const reset = await service.resolveMissingConversationSession(bound, null, 'session-lost');
    expect(reset).toMatchObject({ outcome: 'reset' });
    const changes = (reset as { changes: ProviderHistoryInput }).changes;
    expect(changes.sessionId).toBeNull();
    expect(changes.providerState).toEqual({
      historySessionId: 'session-lost',
      nativeConversationContextEstablished: false,
      unrelated: 'kept',
    });

    // A cold reload starts without messages and must still find the transcript.
    const hydrated = await service.hydrateConversationHistory(conversation({ ...changes, messages: [] }), null, pathContext);
    expect(hydrated.messages?.[0]).toMatchObject({ content: 'Uppercase alpha and beta in notes.md.', role: 'user' });
    // Only the live binding has a changing native revision.
    await expect(service.readNativeHistoryRevision(conversation(changes), null, pathContext)).resolves.toBeNull();
  });

  it('preserves the binding when a different session is reported missing', async () => {
    await expect(service.resolveMissingConversationSession(conversation({ sessionId: 'session-live' }), null, 'session-old'))
      .resolves.toEqual({ outcome: 'preserve' });
  });

  it('marks native context established when the bound session already has a transcript', async () => {
    await installTranscript('session-live');
    const hydrated = await service.hydrateConversationHistory(conversation({
      providerState: { nativeConversationContextEstablished: false },
      sessionId: 'session-live',
    }), null, pathContext);

    expect(hydrated.providerState).toMatchObject({ nativeConversationContextEstablished: true });
    await expect(service.readNativeHistoryRevision(conversation({ sessionId: 'session-live' }), null, pathContext))
      .resolves.toEqual(expect.any(String));
  });
});
