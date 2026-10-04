import { formatContextLimit, parseContextLimit } from '@/shared/settings/contextLimit';

describe('parseContextLimit', () => {
  it('should parse "256k" to 256000', () => {
    expect(parseContextLimit('256k')).toBe(256000);
  });

  it('should parse "256K" to 256000 (case insensitive)', () => {
    expect(parseContextLimit('256K')).toBe(256000);
  });

  it('should parse "1m" to 1000000', () => {
    expect(parseContextLimit('1m')).toBe(1000000);
  });

  it('should parse "1M" to 1000000 (case insensitive)', () => {
    expect(parseContextLimit('1M')).toBe(1000000);
  });

  it('should parse "1000000" to 1000000', () => {
    expect(parseContextLimit('1000000')).toBe(1000000);
  });

  it('should parse "1.5m" to 1500000', () => {
    expect(parseContextLimit('1.5m')).toBe(1500000);
  });

  it('should parse "200k" to 200000', () => {
    expect(parseContextLimit('200k')).toBe(200000);
  });

  it('should handle whitespace', () => {
    expect(parseContextLimit('  256k  ')).toBe(256000);
  });

  it('should handle space before suffix', () => {
    expect(parseContextLimit('256 k')).toBe(256000);
    expect(parseContextLimit('1 m')).toBe(1000000);
    expect(parseContextLimit('1.5 m')).toBe(1500000);
  });

  it('should return null for empty string', () => {
    expect(parseContextLimit('')).toBeNull();
  });

  it('should return null for whitespace only', () => {
    expect(parseContextLimit('   ')).toBeNull();
  });

  it('should return null for invalid input', () => {
    expect(parseContextLimit('abc')).toBeNull();
    expect(parseContextLimit('k256')).toBeNull();
    expect(parseContextLimit('256x')).toBeNull();
  });

  it('should return null for negative values', () => {
    expect(parseContextLimit('-100k')).toBeNull();
  });

  it('should return null for zero', () => {
    expect(parseContextLimit('0k')).toBeNull();
  });

  it('should return null for values below 1k', () => {
    expect(parseContextLimit('100')).toBeNull();
    expect(parseContextLimit('999')).toBeNull();
  });

  it('should return null for values above 10m', () => {
    expect(parseContextLimit('20m')).toBeNull();
    expect(parseContextLimit('11000000')).toBeNull();
  });

  it('should accept boundary values', () => {
    expect(parseContextLimit('1k')).toBe(1000);
    expect(parseContextLimit('10m')).toBe(10000000);
  });
});

describe('formatContextLimit', () => {
  it('should format 256000 as "256k"', () => {
    expect(formatContextLimit(256000)).toBe('256k');
  });

  it('should format 1000000 as "1m"', () => {
    expect(formatContextLimit(1000000)).toBe('1m');
  });

  it('should format 200000 as "200k"', () => {
    expect(formatContextLimit(200000)).toBe('200k');
  });

  it('should format 2000000 as "2m"', () => {
    expect(formatContextLimit(2000000)).toBe('2m');
  });

  it('should format non-round numbers with toLocaleString', () => {
    expect(formatContextLimit(256500)).toBe('256,500');
  });

  it('should format small numbers with toLocaleString', () => {
    expect(formatContextLimit(500)).toBe('500');
  });

  it('should round-trip through parseContextLimit for all formats', () => {
    // Round numbers (k/m suffix)
    expect(parseContextLimit(formatContextLimit(256000))).toBe(256000);
    expect(parseContextLimit(formatContextLimit(1000000))).toBe(1000000);
    expect(parseContextLimit(formatContextLimit(2000000))).toBe(2000000);

    // Non-round numbers (locale-formatted with commas)
    expect(parseContextLimit(formatContextLimit(256500))).toBe(256500);
    expect(parseContextLimit(formatContextLimit(1234567))).toBe(1234567);
  });
});

describe('parseContextLimit with comma-formatted input', () => {
  it('should parse "256,500" to 256500', () => {
    expect(parseContextLimit('256,500')).toBe(256500);
  });

  it('should parse "1,000,000" to 1000000', () => {
    expect(parseContextLimit('1,000,000')).toBe(1000000);
  });

  it('should parse "1,234,567" to 1234567', () => {
    expect(parseContextLimit('1,234,567')).toBe(1234567);
  });
});
