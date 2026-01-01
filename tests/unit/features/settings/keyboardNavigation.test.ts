import { buildNavMappingText, parseNavMappings } from '@/features/settings/keyboardNavigation';

describe('keyboardNavigation', () => {
  describe('buildNavMappingText', () => {
    it('should build mapping lines in order', () => {
      const result = buildNavMappingText({
        scrollUpKey: 'w',
        scrollDownKey: 's',
        focusInputKey: 'i',
      });

      expect(result).toBe('map w scrollUp\nmap s scrollDown\nmap i focusInput');
    });
  });

  describe('parseNavMappings', () => {
    it('should parse valid mappings', () => {
      const result = parseNavMappings('map w scrollUp\nmap s scrollDown\nmap i focusInput');

      expect(result.settings).toEqual({
        scrollUp: 'w',
        scrollDown: 's',
        focusInput: 'i',
      });
    });

    it('should ignore empty lines', () => {
      const result = parseNavMappings('\nmap w scrollUp\n\nmap s scrollDown\nmap i focusInput\n');

      expect(result.settings).toEqual({
        scrollUp: 'w',
        scrollDown: 's',
        focusInput: 'i',
      });
    });

    it('should reject invalid formats', () => {
      const result = parseNavMappings('map w scrollUp extra');

      expect(result.error).toBe('Each line must follow "map <key> <action>"');
    });

    it('should reject unknown actions', () => {
      const result = parseNavMappings('map w jump\nmap s scrollDown\nmap i focusInput');

      expect(result.error).toBe('Unknown action: jump');
    });

    it('should reject multi-character keys', () => {
      const result = parseNavMappings('map ww scrollUp\nmap s scrollDown\nmap i focusInput');

      expect(result.error).toBe('Key must be a single character for scrollUp');
    });

    it('should reject duplicate action mappings', () => {
      const result = parseNavMappings('map w scrollUp\nmap s scrollDown\nmap i scrollDown');

      expect(result.error).toBe('Duplicate mapping for scrollDown');
    });

    it('should reject duplicate keys case-insensitively', () => {
      const result = parseNavMappings('map W scrollUp\nmap w scrollDown\nmap i focusInput');

      expect(result.error).toBe('Navigation keys must be unique');
    });

    it('should reject missing mappings', () => {
      const result = parseNavMappings('map w scrollUp\nmap s scrollDown');

      expect(result.error).toBe('Missing mapping for focusInput');
    });
  });
});
