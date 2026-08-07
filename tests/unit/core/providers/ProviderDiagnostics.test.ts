import {
  classifyProviderError,
  createProviderDiagnosticError,
  createProviderDiagnosticReport,
  formatProviderDiagnosticNotice,
  sanitizeDiagnosticMessage,
  stringifyDiagnosticError,
} from '@/core/providers/ProviderDiagnostics';

describe('ProviderDiagnostics', () => {
  it('redacts credentials from diagnostic messages', () => {
    expect(sanitizeDiagnosticMessage(
      'Authorization: Bearer secret-token api_key=sk-live-1234567890123456 OPENAI_API_KEY=abc123',
    )).toBe(
      'Authorization: Bearer [REDACTED] api_key=[REDACTED] OPENAI_API_KEY=[REDACTED]',
    );
  });

  it('maps provider execution categories to actionable diagnostic categories', () => {
    expect(classifyProviderError('Codex app-server process exited unexpectedly.', 'process-exited'))
      .toBe('cli-start-failed');
    expect(classifyProviderError('thread not found', 'provider-session-missing'))
      .toBe('session-resume-failed');
    expect(classifyProviderError('request failed with HTTP 429'))
      .toBe('rate-limited');
    expect(classifyProviderError('Claude CLI Not Found'))
      .toBe('cli-not-found');
  });

  it('creates a sanitized recoverable diagnostic error', () => {
    expect(createProviderDiagnosticError('invalid api key=secret', {
      hint: 'authentication',
      recoverable: false,
    })).toEqual({
      category: 'authentication',
      message: 'invalid api key=[REDACTED]',
      recoverable: false,
    });
  });

  it('formats a notice without exposing the original secret', () => {
    const error = createProviderDiagnosticError('request failed api_key=secret');
    expect(formatProviderDiagnosticNotice(error)).toBe(
      '[unknown] request failed api_key=[REDACTED]',
    );
  });

  it('serializes structured provider errors instead of rendering object object', () => {
    expect(stringifyDiagnosticError({ code: 'EPIPE', detail: 'process closed' }))
      .toBe('process closed');
  });

  it('normalizes structured errors at the diagnostic boundary', () => {
    expect(createProviderDiagnosticError({ detail: 'socket closed' }).message)
      .toBe('socket closed');
    const wrapped = new Error('[object Object]');
    wrapped.cause = { detail: 'socket closed' };
    expect(createProviderDiagnosticError(wrapped).message).toBe('socket closed');
  });

  it('creates a report with runtime context without adding message content', () => {
    const error = createProviderDiagnosticError('session failed');
    expect(createProviderDiagnosticReport('codex', error, {
      platform: 'macOS',
      runtimeStatus: 'failed',
      createdAt: 123,
    })).toEqual({
      createdAt: 123,
      providerId: 'codex',
      error,
      platform: 'macOS',
      runtimeStatus: 'failed',
    });
  });
});
