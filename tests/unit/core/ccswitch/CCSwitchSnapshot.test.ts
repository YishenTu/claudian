import {
  getCCSwitchSnapshotHash,
  parseClaudeCCSwitchSnapshot,
  parseCodexCCSwitchSnapshot,
} from '@/core/ccswitch/CCSwitchSnapshot';

describe('CCSwitchSnapshot', () => {
  it('parses Claude Code settings without retaining raw API keys', () => {
    const snapshot = parseClaudeCCSwitchSnapshot(JSON.stringify({
      env: {
        ANTHROPIC_AUTH_TOKEN: 'sk-test-secret',
        ANTHROPIC_BASE_URL: 'https://claude.example.com',
        ANTHROPIC_MODEL: 'claude-opus-4-8',
      },
    }), 'C:/Users/test/.claude/settings.json');

    expect(snapshot).toMatchObject({
      providerId: 'claude',
      model: 'claude-opus-4-8',
      baseUrl: 'https://claude.example.com',
      authSource: 'ANTHROPIC_AUTH_TOKEN',
      keyFingerprint: expect.stringMatching(/^sha256:/),
      sourcePaths: ['C:/Users/test/.claude/settings.json'],
    });
    expect(JSON.stringify(snapshot)).not.toContain('sk-test-secret');
  });

  it('parses Codex config and auth without retaining raw API keys', () => {
    const snapshot = parseCodexCCSwitchSnapshot({
      configToml: [
        'model = "gpt-5.5"',
        'model_provider = "openai-compatible"',
        '',
        '[model_providers.openai-compatible]',
        'base_url = "https://gpt.example.com/v1"',
      ].join('\n'),
      authJson: JSON.stringify({
        OPENAI_API_KEY: 'sk-codex-secret',
        account_id: 'acct_123',
      }),
      configPath: 'C:/Users/test/.codex/config.toml',
      authPath: 'C:/Users/test/.codex/auth.json',
    });

    expect(snapshot).toMatchObject({
      providerId: 'codex',
      model: 'gpt-5.5',
      modelProvider: 'openai-compatible',
      baseUrl: 'https://gpt.example.com/v1',
      authSource: 'OPENAI_API_KEY',
      accountId: 'acct_123',
      keyFingerprint: expect.stringMatching(/^sha256:/),
      sourcePaths: [
        'C:/Users/test/.codex/config.toml',
        'C:/Users/test/.codex/auth.json',
      ],
    });
    expect(JSON.stringify(snapshot)).not.toContain('sk-codex-secret');
  });

  it('hashes meaningful switch fields but ignores syncedAt', () => {
    const base = {
      providerId: 'codex' as const,
      model: 'gpt-5.5',
      baseUrl: 'https://gpt.example.com/v1',
      keyFingerprint: 'sha256:abc',
      sourcePaths: ['config.toml'],
      syncedAt: '2026-06-07T00:00:00.000Z',
    };

    expect(getCCSwitchSnapshotHash(base)).toBe(getCCSwitchSnapshotHash({
      ...base,
      syncedAt: '2026-06-07T01:00:00.000Z',
    }));
    expect(getCCSwitchSnapshotHash(base)).not.toBe(getCCSwitchSnapshotHash({
      ...base,
      baseUrl: 'https://other.example.com/v1',
    }));
  });
});
