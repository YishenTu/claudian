import {
  AGENT_RUNTIME_PORT_COUNT,
  AGENT_RUNTIME_PORT_MIN,
  deriveAgentRuntimePortCandidates,
} from '@/app/agent-runtime/AgentRuntimePortAllocator';

describe('deriveAgentRuntimePortCandidates', () => {
  it('returns a stable bounded candidate sequence for one Vault', () => {
    const first = deriveAgentRuntimePortCandidates('/Users/Ada/Notes', {
      maxCandidates: 64,
      platform: 'darwin',
    });
    const second = deriveAgentRuntimePortCandidates('/Users/Ada/Notes', {
      maxCandidates: 64,
      platform: 'darwin',
    });

    expect(second).toEqual(first);
    expect(first).toHaveLength(64);
    expect(new Set(first).size).toBe(64);
    expect(first.every(port => (
      port >= AGENT_RUNTIME_PORT_MIN
      && port < AGENT_RUNTIME_PORT_MIN + AGENT_RUNTIME_PORT_COUNT
    ))).toBe(true);
  });

  it('normalizes Unicode without collapsing distinct POSIX path casing', () => {
    const composed = deriveAgentRuntimePortCandidates('/Vault/Caf\u00e9', {
      platform: 'darwin',
    });
    const decomposed = deriveAgentRuntimePortCandidates('/Vault/Cafe\u0301', {
      platform: 'darwin',
    });
    const lowerCase = deriveAgentRuntimePortCandidates('/vault/caf\u00e9', {
      platform: 'darwin',
    });

    expect(decomposed).toEqual(composed);
    expect(lowerCase).not.toEqual(composed);
  });

  it('normalizes Windows separators and casing', () => {
    const first = deriveAgentRuntimePortCandidates('C:\\Users\\Ada\\Vault', {
      platform: 'win32',
    });
    const second = deriveAgentRuntimePortCandidates('c:/users/ada/vault', {
      platform: 'win32',
    });

    expect(second).toEqual(first);
  });

  it('uses a different sequence for a different Vault', () => {
    expect(deriveAgentRuntimePortCandidates('/Vault/Alpha')).not.toEqual(
      deriveAgentRuntimePortCandidates('/Vault/Beta'),
    );
  });

  it('rejects blank paths and invalid candidate counts', () => {
    expect(() => deriveAgentRuntimePortCandidates('   ')).toThrow(
      'Vault path must not be blank.',
    );
    expect(() => deriveAgentRuntimePortCandidates('/Vault', {
      maxCandidates: 0,
    })).toThrow('Agent Runtime candidate count must be between 1 and 16384.');
  });
});
