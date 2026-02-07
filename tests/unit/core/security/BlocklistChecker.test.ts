import { isCommandBlocked } from '@/core/security/BlocklistChecker';

describe('BlocklistChecker', () => {
  describe('isCommandBlocked', () => {
    it('returns false when blocklist is disabled', () => {
      const command = 'rm -rf /';
      const patterns = ['rm', 'rm.*-rf'];
      expect(isCommandBlocked(command, patterns, false)).toBe(false);
    });

    it('returns false when patterns array is empty', () => {
      const command = 'ls -la';
      expect(isCommandBlocked(command, [], true)).toBe(false);
    });

    describe('with valid regex patterns', () => {
      it('blocks command matching exact pattern', () => {
        const command = 'rm file.txt';
        const patterns = ['^rm '];
        expect(isCommandBlocked(command, patterns, true)).toBe(true);
      });

      it('blocks command matching regex pattern with wildcards', () => {
        const command = 'rm -rf important';
        const patterns = ['rm.*-rf'];
        expect(isCommandBlocked(command, patterns, true)).toBe(true);
      });

      it('is case-insensitive for regex matches', () => {
        const command = 'RM FILE.TXT';
        const patterns = ['rm file'];
        expect(isCommandBlocked(command, patterns, true)).toBe(true);
      });

      it('blocks command matching any pattern in array', () => {
        const command = 'git push --force';
        const patterns = ['rm.*-rf', 'git.*force', 'drop database'];
        expect(isCommandBlocked(command, patterns, true)).toBe(true);
      });

      it('does not block command not matching any pattern', () => {
        const command = 'git status';
        const patterns = ['rm.*-rf', 'drop database'];
        expect(isCommandBlocked(command, patterns, true)).toBe(false);
      });

      it('handles complex regex patterns', () => {
        const command = 'sudo apt-get install package';
        const patterns = ['^(sudo |su )?(apt-get|yum|dnf) install'];
        expect(isCommandBlocked(command, patterns, true)).toBe(true);
      });

      it('matches patterns anywhere in command', () => {
        const command = 'echo "hello" && rm file.txt';
        const patterns = ['rm '];
        expect(isCommandBlocked(command, patterns, true)).toBe(true);
      });

      it('matches pattern at end of command', () => {
        const command = 'cat file.txt | grep pattern';
        const patterns = ['pattern$'];
        expect(isCommandBlocked(command, patterns, true)).toBe(true);
      });
    });

    describe('with invalid regex patterns (substring fallback)', () => {
      it('falls back to substring match for invalid regex', () => {
        const command = 'rm file [invalid].txt';
        const patterns = ['[invalid'];
        expect(isCommandBlocked(command, patterns, true)).toBe(true);
      });

      it('is case-insensitive for substring matches', () => {
        const command = 'DELETE FROM table';
        const patterns = ['delete from'];
        expect(isCommandBlocked(command, patterns, true)).toBe(true);
      });

      it('does not block when substring not found', () => {
        const command = 'select * from users';
        const patterns = ['delete', 'drop', 'truncate'];
        expect(isCommandBlocked(command, patterns, true)).toBe(false);
      });

      it('handles mixed valid and invalid patterns', () => {
        const command = 'rm file';
        const patterns = ['^rm ', '[invalid', 'delete'];
        expect(isCommandBlocked(command, patterns, true)).toBe(true);
      });
    });

    describe('edge cases', () => {
      it('handles empty command string', () => {
        const patterns = ['rm'];
        expect(isCommandBlocked('', patterns, true)).toBe(false);
      });

      it('handles patterns with special regex characters', () => {
        const command = 'chmod 777 /etc/passwd';
        const patterns = ['chmod.*777'];
        expect(isCommandBlocked(command, patterns, true)).toBe(true);
      });

      it('handles unicode characters in patterns', () => {
        const command = 'echo "🚀 rocket"';
        const patterns = ['rocket'];
        expect(isCommandBlocked(command, patterns, true)).toBe(true);
      });

      it('handles very long commands', () => {
        const longCommand = 'echo ' + 'a'.repeat(10000);
        const patterns = ['echo '];
        expect(isCommandBlocked(longCommand, patterns, true)).toBe(true);
      });

      it('falls back to substring match for patterns exceeding max length', () => {
        const longPattern = 'rm ' + 'a'.repeat(500);
        const command = 'rm ' + 'a'.repeat(500);
        expect(isCommandBlocked(command, [longPattern], true)).toBe(true);
      });

      it('does not match long pattern via regex', () => {
        const longPattern = 'rm.*' + 'a'.repeat(500);
        const command = 'rm something';
        // Long pattern uses substring match, so regex wildcards are treated literally
        expect(isCommandBlocked(command, [longPattern], true)).toBe(false);
      });
    });
  });

  describe('real-world scenarios', () => {

    it('allows safe common commands', () => {
      const safeCommands = [
        { cmd: 'ls -la', patterns: ['rm -rf', 'drop database'] },
        { cmd: 'git status', patterns: ['rm', 'format'] },
        { cmd: 'cat file.txt', patterns: ['delete', 'drop'] },
        { cmd: 'echo "hello"', patterns: ['rm', 'chmod'] }
      ];

      safeCommands.forEach(({ cmd, patterns }) => {
        expect(isCommandBlocked(cmd, patterns, true)).toBe(false);
      });
    });

    it('blocks commands with flags matching pattern', () => {
      const patterns = ['git.*--force', 'npm.*--force'];

      expect(isCommandBlocked('git push --force origin main', patterns, true)).toBe(true);
      expect(isCommandBlocked('npm install --force', patterns, true)).toBe(true);
      expect(isCommandBlocked('git push origin main', patterns, true)).toBe(false);
    });

    it('handles platform-specific commands', () => {
      const patterns = ['del.*\\\\.*', 'rm -rf'];

      expect(isCommandBlocked('del C:\\Windows\\System32\\file', patterns, true)).toBe(true);
      expect(isCommandBlocked('rm -rf /home/user/file', patterns, true)).toBe(true);
    });
  });
});
