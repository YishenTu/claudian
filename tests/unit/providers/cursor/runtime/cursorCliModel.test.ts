import { resolveCursorModelForCli } from '@/providers/cursor/runtime/cursorCliModel';

describe('resolveCursorModelForCli', () => {
  it('maps deprecated composer-1 to auto', () => {
    expect(resolveCursorModelForCli('composer-1')).toBe('auto');
  });

  it('passes through current model ids', () => {
    expect(resolveCursorModelForCli('composer-2-fast')).toBe('composer-2-fast');
    expect(resolveCursorModelForCli('auto')).toBe('auto');
  });

  it('returns undefined for empty input', () => {
    expect(resolveCursorModelForCli(undefined)).toBeUndefined();
    expect(resolveCursorModelForCli('')).toBeUndefined();
  });
});
