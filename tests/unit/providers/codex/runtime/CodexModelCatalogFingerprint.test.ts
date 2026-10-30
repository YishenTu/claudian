import { buildCodexCatalogFingerprint } from '@/providers/codex/runtime/CodexModelCatalogFingerprint';

it('does not expose environment secrets in the catalog fingerprint', () => {
  const fingerprint = buildCodexCatalogFingerprint({
    resolvedCliCommand: '/usr/bin/codex', executionTargetKey: 'host-native:unix:linux:', envHash: 'OPENAI_API_KEY=secret',
  });
  expect(fingerprint).not.toContain('secret');
  expect(fingerprint).toMatch(/^2:[a-f0-9]{64}$/);
});
