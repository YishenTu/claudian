import {
  isBracketInterruptText,
  isCompactionCanceledStderr,
  isInterruptSignalText,
  stripLegacyInterruptIndicator,
} from '@/utils/interrupt';

describe('interrupt utils', () => {
  describe('isBracketInterruptText', () => {
    it('matches canonical SDK interrupt markers', () => {
      expect(isBracketInterruptText('[Request interrupted by user]')).toBe(true);
      expect(isBracketInterruptText('[Request interrupted by user for tool use]')).toBe(true);
    });

    it('matches canonical markers with surrounding whitespace', () => {
      expect(isBracketInterruptText('  [Request interrupted by user]  ')).toBe(true);
      expect(isBracketInterruptText('\n[Request interrupted by user for tool use]\n')).toBe(true);
    });

    it('rejects partial and prefixed variants', () => {
      expect(isBracketInterruptText('[Request interrupted by user] extra')).toBe(false);
      expect(isBracketInterruptText('prefix [Request interrupted by user]')).toBe(false);
      expect(isBracketInterruptText('[Request interrupted]')).toBe(false);
    });
  });

  describe('isCompactionCanceledStderr', () => {
    it('matches canonical compaction stderr marker', () => {
      expect(
        isCompactionCanceledStderr(
          '<local-command-stderr>Error: Compaction canceled.</local-command-stderr>',
        ),
      ).toBe(true);
    });

    it('accepts whitespace around canonical compaction stderr marker', () => {
      expect(
        isCompactionCanceledStderr(
          '\n<local-command-stderr> Error: Compaction canceled. </local-command-stderr>\n',
        ),
      ).toBe(true);
    });

    it('rejects embedded mentions and non-canonical wrappers', () => {
      expect(
        isCompactionCanceledStderr(
          '## Context\\n<local-command-stderr>Error: Compaction canceled.</local-command-stderr>',
        ),
      ).toBe(false);
      expect(
        isCompactionCanceledStderr(
          '<task-notification><result><local-command-stderr>Error: Compaction canceled.</local-command-stderr></result></task-notification>',
        ),
      ).toBe(false);
    });
  });

  describe('isInterruptSignalText', () => {
    it('matches all supported interrupt markers', () => {
      expect(isInterruptSignalText('[Request interrupted by user]')).toBe(true);
      expect(isInterruptSignalText('[Request interrupted by user for tool use]')).toBe(true);
      expect(
        isInterruptSignalText(
          '<local-command-stderr>Error: Compaction canceled.</local-command-stderr>',
        ),
      ).toBe(true);
    });

    it('rejects regular content', () => {
      expect(isInterruptSignalText('Hello')).toBe(false);
      expect(isInterruptSignalText('<local-command-stderr>Error: Timeout.</local-command-stderr>')).toBe(false);
    });
  });

  describe('stripLegacyInterruptIndicator', () => {
    it('removes only the trailing Claudian-owned interruption marker', () => {
      const marker =
        '<span class="claudian-interrupted">Interrupted</span> <span class="claudian-interrupted-hint">· What should Claudian do instead?</span>';

      expect(stripLegacyInterruptIndicator(`Partial response\n\n${marker}`)).toEqual({
        content: 'Partial response',
        interrupted: true,
      });
      expect(stripLegacyInterruptIndicator(`${marker}\n\nMore text`)).toEqual({
        content: `${marker}\n\nMore text`,
        interrupted: false,
      });
    });
  });
});
