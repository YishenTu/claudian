import {
  checkBashPathAccess,
  cleanPathToken,
  findBashCommandPathViolation,
  findBashPathViolationInSegment,
  getBashSegmentCommandName,
  isBashInputRedirectOperator,
  isBashOutputOptionExpectingValue,
  isBashOutputRedirectOperator,
  isPathLikeToken,
  splitBashTokensIntoSegments,
  tokenizeBashCommand,
} from '@/core/security/BashPathValidator';
import type { PathAccessType } from '@/utils/path';

describe('BashPathValidator', () => {
  const isWindows = process.platform === 'win32';

  describe('tokenizeBashCommand', () => {
    it('splits simple command', () => {
      const tokens = tokenizeBashCommand('ls -la');
      expect(tokens).toEqual(['ls', '-la']);
    });

    it('handles quoted strings', () => {
      const tokens = tokenizeBashCommand('echo "hello world"');
      expect(tokens).toEqual(['echo', 'hello world']);
    });

    it('handles backticked strings', () => {
      const tokens = tokenizeBashCommand('echo `test`');
      expect(tokens).toEqual(['echo', 'test']);
    });

    it('handles mixed quotes and spaces', () => {
      const tokens = tokenizeBashCommand('git commit -m "added feature"');
      expect(tokens).toEqual(['git', 'commit', '-m', 'added feature']);
    });

    it('handles pipes', () => {
      const tokens = tokenizeBashCommand('cat file.txt | grep "pattern"');
      expect(tokens).toEqual(['cat', 'file.txt', '|', 'grep', 'pattern']);
    });

    it('handles output redirection', () => {
      const tokens = tokenizeBashCommand('ls > output.txt');
      expect(tokens).toEqual(['ls', '>', 'output.txt']);
    });

    it('handles input redirection', () => {
      const tokens = tokenizeBashCommand('cat < input.txt');
      expect(tokens).toEqual(['cat', '<', 'input.txt']);
    });

    it('handles chained commands', () => {
      const tokens = tokenizeBashCommand('cd /tmp && ls && pwd');
      expect(tokens).toEqual(['cd', '/tmp', '&&', 'ls', '&&', 'pwd']);
    });

    it('handles semicolon separator', () => {
      const tokens = tokenizeBashCommand('echo first; echo second');
      expect(tokens).toEqual(['echo', 'first;', 'echo', 'second']);
    });

    it('handles OR separator', () => {
      const tokens = tokenizeBashCommand('cat file1.txt || cat file2.txt');
      expect(tokens).toEqual(['cat', 'file1.txt', '||', 'cat', 'file2.txt']);
    });
  });

  describe('splitBashTokensIntoSegments', () => {
    it('splits by && operator', () => {
      const tokens = ['echo', 'a', '&&', 'echo', 'b', '&&', 'echo', 'c'];
      const segments = splitBashTokensIntoSegments(tokens);

      expect(segments).toEqual([
        ['echo', 'a'],
        ['echo', 'b'],
        ['echo', 'c'],
      ]);
    });

    it('splits by || operator', () => {
      const tokens = ['cat', 'a.txt', '||', 'cat', 'b.txt'];
      const segments = splitBashTokensIntoSegments(tokens);

      expect(segments).toEqual([
        ['cat', 'a.txt'],
        ['cat', 'b.txt'],
      ]);
    });

    it('handles single segment', () => {
      const tokens = ['ls', '-la'];
      const segments = splitBashTokensIntoSegments(tokens);

      expect(segments).toEqual([['ls', '-la']]);
    });
  });

  describe('getBashSegmentCommandName', () => {
    it('extracts command name', () => {
      const result = getBashSegmentCommandName(['git', 'commit', '-m', 'message']);
      expect(result).toEqual({ cmdName: 'git', cmdIndex: 0 });
    });

    it('skips sudo wrapper', () => {
      const result = getBashSegmentCommandName(['sudo', 'cat', '/etc/passwd']);
      expect(result).toEqual({ cmdName: 'cat', cmdIndex: 1 });
    });

    it('skips env wrapper', () => {
      const result = getBashSegmentCommandName(['env', 'EDITOR=vim', 'vim']);
      expect(result).toEqual({ cmdName: 'vim', cmdIndex: 2 });
    });

    it('handles segment with only wrappers', () => {
      const result = getBashSegmentCommandName(['sudo', 'env']);
      expect(result).toEqual({ cmdName: '', cmdIndex: 2 });
    });

    it('skips multiple VAR=value tokens', () => {
      const result = getBashSegmentCommandName(['env', 'A=1', 'B=2', 'C=3', 'cat']);
      expect(result).toEqual({ cmdName: 'cat', cmdIndex: 4 });
    });

    it('skips VAR=value tokens even without env prefix', () => {
      // Inline env vars: VAR=value command
      const result = getBashSegmentCommandName(['PATH=/bin', 'ls']);
      expect(result).toEqual({ cmdName: 'ls', cmdIndex: 1 });
    });

    it('handles segment with only VAR=value tokens', () => {
      const result = getBashSegmentCommandName(['VAR1=val1', 'VAR2=val2']);
      expect(result).toEqual({ cmdName: '', cmdIndex: 2 });
    });

    it('does not skip flags with equals signs', () => {
      // --option=value is a flag, not an env var assignment - cmdIndex should be 0
      // cmdName is path.basename() of the token, which extracts 'path' from '--output=/path'
      const result = getBashSegmentCommandName(['--output=/path', 'command']);
      expect(result.cmdIndex).toBe(0);
    });

    it('does not skip short flags with equals signs', () => {
      // -o=value starts with -, so it's not skipped - cmdIndex should be 0
      const result = getBashSegmentCommandName(['-o=output.txt', 'command']);
      expect(result.cmdIndex).toBe(0);
    });

    it('handles token with equals at start', () => {
      // =value contains = but doesn't start with -, so it's treated as VAR=value
      const result = getBashSegmentCommandName(['=value', 'cat']);
      expect(result).toEqual({ cmdName: 'cat', cmdIndex: 1 });
    });

    it('handles empty value assignment', () => {
      const result = getBashSegmentCommandName(['env', 'VAR=', 'cat']);
      expect(result).toEqual({ cmdName: 'cat', cmdIndex: 2 });
    });
  });

  describe('Bash redirect operators', () => {
    describe('isBashOutputRedirectOperator', () => {
      it('detects > operator', () => {
        expect(isBashOutputRedirectOperator('>')).toBe(true);
      });

      it('detects >> operator', () => {
        expect(isBashOutputRedirectOperator('>>')).toBe(true);
      });

      it('detects 1> operator', () => {
        expect(isBashOutputRedirectOperator('1>')).toBe(true);
      });

      it('detects 2> operator', () => {
        expect(isBashOutputRedirectOperator('2>')).toBe(true);
      });

      it('detects &> operator', () => {
        expect(isBashOutputRedirectOperator('&>')).toBe(true);
      });

      it('detects &>> operator', () => {
        expect(isBashOutputRedirectOperator('&>>')).toBe(true);
      });

      it('detects >| operator', () => {
        expect(isBashOutputRedirectOperator('>|')).toBe(true);
      });

      it('does not detect non-redirect tokens', () => {
        expect(isBashOutputRedirectOperator('ls')).toBe(false);
        expect(isBashOutputRedirectOperator('|')).toBe(false);
        expect(isBashOutputRedirectOperator('&&')).toBe(false);
      });
    });

    describe('isBashInputRedirectOperator', () => {
      it('detects < operator', () => {
        expect(isBashInputRedirectOperator('<')).toBe(true);
      });

      it('detects << operator', () => {
        expect(isBashInputRedirectOperator('<<')).toBe(true);
      });

      it('detects 0< operator', () => {
        expect(isBashInputRedirectOperator('0<')).toBe(true);
      });

      it('detects 0<< operator', () => {
        expect(isBashInputRedirectOperator('0<<')).toBe(true);
      });

      it('does not detect non-redirect tokens', () => {
        expect(isBashInputRedirectOperator('ls')).toBe(false);
        expect(isBashInputRedirectOperator('>')).toBe(false);
        expect(isBashInputRedirectOperator('&&')).toBe(false);
      });
    });

    describe('isBashOutputOptionExpectingValue', () => {
      it('detects -o option', () => {
        expect(isBashOutputOptionExpectingValue('-o')).toBe(true);
      });

      it('detects --output option', () => {
        expect(isBashOutputOptionExpectingValue('--output')).toBe(true);
      });

      it('detects --out option', () => {
        expect(isBashOutputOptionExpectingValue('--out')).toBe(true);
      });

      it('detects --output-file option', () => {
        expect(isBashOutputOptionExpectingValue('--output-file')).toBe(true);
      });

      it('does not detect non-output tokens', () => {
        expect(isBashOutputOptionExpectingValue('ls')).toBe(false);
        expect(isBashOutputOptionExpectingValue('-v')).toBe(false);
        expect(isBashOutputOptionExpectingValue('--help')).toBe(false);
      });
    });
  });

  describe('cleanPathToken', () => {
    it('strips double quotes', () => {
      expect(cleanPathToken('"path/to/file"')).toBe('path/to/file');
    });

    it('strips single quotes', () => {
      expect(cleanPathToken("'path/to/file'")).toBe('path/to/file');
    });

    it('strips backticks', () => {
      expect(cleanPathToken('`path/to/file`')).toBe('path/to/file');
    });

    it('strips parentheses', () => {
      expect(cleanPathToken('(path/to/file)')).toBe('path/to/file');
    });

    it('strips braces', () => {
      expect(cleanPathToken('{path/to/file}')).toBe('path/to/file');
    });

    it('strips multiple delimiters', () => {
      expect(cleanPathToken('["path/to/file"]')).toBe('path/to/file');
    });

    it('strips semicolon', () => {
      expect(cleanPathToken('path/to/file;')).toBe('path/to/file');
    });

    it('strips comma', () => {
      expect(cleanPathToken('path/to/file,')).toBe('path/to/file');
    });

    it('returns null for dot', () => {
      expect(cleanPathToken('.')).toBeNull();
    });

    it('returns null for slash', () => {
      expect(cleanPathToken('/')).toBeNull();
    });

    it('returns null for backslash', () => {
      expect(cleanPathToken('\\')).toBeNull();
    });

    it('returns null for -- (double dash)', () => {
      expect(cleanPathToken('--')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(cleanPathToken('')).toBeNull();
    });

    it('returns null for whitespace only', () => {
      expect(cleanPathToken('   ')).toBeNull();
    });

    it('strips nested quotes after delimiters', () => {
      // After stripping outer delimiters, quotes may remain
      expect(cleanPathToken('("path/to/file")')).toBe('path/to/file');
      expect(cleanPathToken("['path/to/file']")).toBe('path/to/file');
      expect(cleanPathToken('{`path/to/file`}')).toBe('path/to/file');
    });

    it('handles empty string after quote stripping', () => {
      expect(cleanPathToken('""')).toBeNull();
      expect(cleanPathToken("''")).toBeNull();
      expect(cleanPathToken('``')).toBeNull();
    });

    it('handles mismatched quotes (does not strip)', () => {
      // Mismatched quotes are not stripped - token passes through
      expect(cleanPathToken("\"path'")).toBe("\"path'");
      expect(cleanPathToken("'path\"")).toBe("'path\"");
    });
  });

  describe('isPathLikeToken', () => {
    it('detects Unix-style home paths', () => {
      expect(isPathLikeToken('~/notes')).toBe(true);
      expect(isPathLikeToken('~')).toBe(true);
    });

    it('detects Windows-style home paths only on Windows', () => {
      expect(isPathLikeToken('~\\notes')).toBe(isWindows);
    });

    it('detects Unix-style relative paths', () => {
      expect(isPathLikeToken('./notes')).toBe(true);
      expect(isPathLikeToken('../notes')).toBe(true);
      expect(isPathLikeToken('..')).toBe(true);
    });

    it('detects Windows-style relative paths only on Windows', () => {
      expect(isPathLikeToken('.\\notes')).toBe(isWindows);
      expect(isPathLikeToken('..\\notes')).toBe(isWindows);
    });

    it('detects Unix-style absolute paths', () => {
      expect(isPathLikeToken('/tmp/note.md')).toBe(true);
    });

    it('detects Windows-style absolute paths only on Windows', () => {
      expect(isPathLikeToken('C:\\temp\\note.md')).toBe(isWindows);
      expect(isPathLikeToken('\\\\server\\share\\note.md')).toBe(isWindows);
    });

    it('does not treat dot-prefixed names as parent directories', () => {
      expect(isPathLikeToken('..hidden')).toBe(false);
    });

    it('detects forward-slash paths on all platforms', () => {
      expect(isPathLikeToken('foo/bar')).toBe(true);
    });

    it('rejects non-path tokens', () => {
      expect(isPathLikeToken('.')).toBe(false);
      expect(isPathLikeToken('/')).toBe(false);
      expect(isPathLikeToken('\\')).toBe(false);
      expect(isPathLikeToken('--')).toBe(false);
      expect(isPathLikeToken('')).toBe(false);
      expect(isPathLikeToken('plainword')).toBe(false);
    });
  });

  describe('isPathLikeToken with mocked platforms', () => {
    const originalPlatform = process.platform;

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    describe('on Windows (mocked)', () => {
      beforeEach(() => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
      });

      it('detects Windows drive letter paths', () => {
        expect(isPathLikeToken('C:\\Users\\test')).toBe(true);
        expect(isPathLikeToken('D:/Projects/vault')).toBe(true);
      });

      it('detects Windows UNC paths', () => {
        expect(isPathLikeToken('\\\\server\\share')).toBe(true);
        expect(isPathLikeToken('//server/share')).toBe(true);
      });

      it('detects Windows-style home and relative paths', () => {
        expect(isPathLikeToken('~\\Documents')).toBe(true);
        expect(isPathLikeToken('.\\local')).toBe(true);
        expect(isPathLikeToken('..\\parent')).toBe(true);
      });

      it('detects paths with backslashes', () => {
        expect(isPathLikeToken('folder\\file.txt')).toBe(true);
      });

      it('detects MSYS-style paths as forward slash paths', () => {
        expect(isPathLikeToken('/c/Users/test')).toBe(true);
      });
    });

    describe('on Unix (mocked)', () => {
      beforeEach(() => {
        Object.defineProperty(process, 'platform', { value: 'darwin' });
      });

      it('does not detect Windows drive letter paths', () => {
        expect(isPathLikeToken('C:\\Users\\test')).toBe(false);
      });

      it('does not detect Windows-style backslash paths', () => {
        expect(isPathLikeToken('~\\Documents')).toBe(false);
        expect(isPathLikeToken('.\\local')).toBe(false);
      });

      it('detects Unix absolute paths', () => {
        expect(isPathLikeToken('/home/user')).toBe(true);
        expect(isPathLikeToken('/c/Users/test')).toBe(true);
      });
    });
  });

  describe('checkBashPathAccess', () => {
    const createMockContext = (accessType: PathAccessType) => ({
      getPathAccessType: jest.fn().mockReturnValue(accessType),
    });

    it('returns null for vault paths', () => {
      const context = createMockContext('vault');
      const result = checkBashPathAccess('/vault/file.txt', 'read', context);
      expect(result).toBeNull();
    });

    it('returns null for readwrite paths', () => {
      const context = createMockContext('readwrite');
      const result = checkBashPathAccess('/readwrite/file.txt', 'write', context);
      expect(result).toBeNull();
    });

    it('returns null for context paths', () => {
      const context = createMockContext('context');
      const result = checkBashPathAccess('/context/file.txt', 'read', context);
      expect(result).toBeNull();
    });

    it('returns null for export paths with write access', () => {
      const context = createMockContext('export');
      const result = checkBashPathAccess('~/Desktop/file.txt', 'write', context);
      expect(result).toBeNull();
    });

    it('returns export_path_read violation for export paths with read access', () => {
      const context = createMockContext('export');
      const result = checkBashPathAccess('~/Desktop/file.txt', 'read', context);
      expect(result).toEqual({ type: 'export_path_read', path: '~/Desktop/file.txt' });
    });

    it('returns outside_vault violation for unknown paths', () => {
      const context = createMockContext('none');
      const result = checkBashPathAccess('/etc/passwd', 'read', context);
      expect(result).toEqual({ type: 'outside_vault', path: '/etc/passwd' });
    });

    it('returns null for invalid path tokens', () => {
      const context = createMockContext('none');
      const result = checkBashPathAccess('.', 'read', context);
      expect(result).toBeNull();
    });
  });

  describe('findBashPathViolationInSegment', () => {
    const createMockContext = (pathMap: Record<string, PathAccessType>) => ({
      getPathAccessType: jest.fn().mockImplementation((path: string) => {
        return pathMap[path] || 'none';
      }),
    });

    it('returns null for empty segment', () => {
      const context = createMockContext({});
      const result = findBashPathViolationInSegment([], context);
      expect(result).toBeNull();
    });

    it('detects violation in redirect target', () => {
      const context = createMockContext({});
      const result = findBashPathViolationInSegment(['echo', 'test', '>', '/etc/passwd'], context);
      expect(result).toEqual({ type: 'outside_vault', path: '/etc/passwd' });
    });

    it('allows write to export path via redirect', () => {
      const context = createMockContext({ '~/Desktop/out.txt': 'export' });
      const result = findBashPathViolationInSegment(['echo', 'test', '>', '~/Desktop/out.txt'], context);
      expect(result).toBeNull();
    });

    it('detects violation in -o output option', () => {
      const context = createMockContext({});
      const result = findBashPathViolationInSegment(['curl', '-o', '/etc/passwd'], context);
      expect(result).toEqual({ type: 'outside_vault', path: '/etc/passwd' });
    });

    it('detects violation in embedded output option', () => {
      const context = createMockContext({});
      const result = findBashPathViolationInSegment(['curl', '-o/etc/passwd'], context);
      expect(result).toEqual({ type: 'outside_vault', path: '/etc/passwd' });
    });

    it('detects violation in --output= option', () => {
      const context = createMockContext({});
      const result = findBashPathViolationInSegment(['curl', '--output=/etc/passwd'], context);
      expect(result).toEqual({ type: 'outside_vault', path: '/etc/passwd' });
    });

    it('detects violation in embedded redirect', () => {
      const context = createMockContext({});
      const result = findBashPathViolationInSegment(['echo', 'test', '>/etc/passwd'], context);
      expect(result).toEqual({ type: 'outside_vault', path: '/etc/passwd' });
    });

    it('detects violation in destination argument for cp command', () => {
      const context = createMockContext({ '/vault/file.txt': 'vault' });
      const result = findBashPathViolationInSegment(['cp', '/vault/file.txt', '/etc/passwd'], context);
      expect(result).toEqual({ type: 'outside_vault', path: '/etc/passwd' });
    });

    it('detects violation in destination argument for mv command', () => {
      const context = createMockContext({ '/vault/file.txt': 'vault' });
      const result = findBashPathViolationInSegment(['mv', '/vault/file.txt', '/etc/passwd'], context);
      expect(result).toEqual({ type: 'outside_vault', path: '/etc/passwd' });
    });

    it('returns null for commands with valid vault paths', () => {
      const context = createMockContext({
        '/vault/src.txt': 'vault',
        '/vault/dest.txt': 'vault',
      });
      const result = findBashPathViolationInSegment(['cp', '/vault/src.txt', '/vault/dest.txt'], context);
      expect(result).toBeNull();
    });

    it('allows read from vault path', () => {
      const context = createMockContext({ '/vault/file.txt': 'vault' });
      const result = findBashPathViolationInSegment(['cat', '/vault/file.txt'], context);
      expect(result).toBeNull();
    });

    it('detects violation in embedded input redirect', () => {
      const context = createMockContext({});
      const result = findBashPathViolationInSegment(['cat', '</etc/passwd'], context);
      expect(result).toEqual({ type: 'outside_vault', path: '/etc/passwd' });
    });

    it('allows embedded input redirect to vault path', () => {
      const context = createMockContext({ '/vault/data.txt': 'vault' });
      const result = findBashPathViolationInSegment(['cat', '</vault/data.txt'], context);
      expect(result).toBeNull();
    });

    it('detects violation in --out= long option', () => {
      const context = createMockContext({});
      const result = findBashPathViolationInSegment(['tool', '--out=/etc/output'], context);
      expect(result).toEqual({ type: 'outside_vault', path: '/etc/output' });
    });

    it('detects violation in --outfile= long option', () => {
      const context = createMockContext({});
      const result = findBashPathViolationInSegment(['tool', '--outfile=/etc/output'], context);
      expect(result).toEqual({ type: 'outside_vault', path: '/etc/output' });
    });

    it('detects violation in --output-file= long option', () => {
      const context = createMockContext({});
      const result = findBashPathViolationInSegment(['tool', '--output-file=/etc/output'], context);
      expect(result).toEqual({ type: 'outside_vault', path: '/etc/output' });
    });

    it('detects violation in KEY=VALUE with path-like value from flag', () => {
      const context = createMockContext({});
      const result = findBashPathViolationInSegment(['tool', '--config=/etc/passwd'], context);
      expect(result).toEqual({ type: 'outside_vault', path: '/etc/passwd' });
    });

    it('detects path-like KEY=VALUE tokens as positional args', () => {
      const context = createMockContext({});
      // HOME=/home/user contains '/' so it's path-like and treated as a positional arg read
      const result = findBashPathViolationInSegment(['env', 'HOME=/home/user', 'ls'], context);
      expect(result).toEqual({ type: 'outside_vault', path: 'HOME=/home/user' });
    });

    it('detects violation in 2>> append redirect', () => {
      const context = createMockContext({});
      const result = findBashPathViolationInSegment(['cmd', '2>>/etc/error.log'], context);
      expect(result).toEqual({ type: 'outside_vault', path: '/etc/error.log' });
    });

    it('detects violation in &> combined redirect', () => {
      const context = createMockContext({});
      const result = findBashPathViolationInSegment(['cmd', '&>/etc/all.log'], context);
      expect(result).toEqual({ type: 'outside_vault', path: '/etc/all.log' });
    });

    it('detects violation in >| clobber redirect', () => {
      const context = createMockContext({});
      const result = findBashPathViolationInSegment(['cmd', '>|/etc/out.log'], context);
      expect(result).toEqual({ type: 'outside_vault', path: '/etc/out.log' });
    });

    it('skips cp --flag options before destination', () => {
      const context = createMockContext({ '/vault/src.txt': 'vault' });
      const result = findBashPathViolationInSegment(['cp', '-r', '/vault/src.txt', '/etc/dest'], context);
      expect(result).toEqual({ type: 'outside_vault', path: '/etc/dest' });
    });

    it('handles rsync as a destination command', () => {
      const context = createMockContext({ '/vault/src/': 'vault' });
      const result = findBashPathViolationInSegment(['rsync', '-av', '/vault/src/', '/etc/dest/'], context);
      expect(result).toEqual({ type: 'outside_vault', path: '/etc/dest/' });
    });

    it('handles -- separator for cp command', () => {
      const context = createMockContext({ '/vault/src.txt': 'vault' });
      const result = findBashPathViolationInSegment(['cp', '--', '/vault/src.txt', '/etc/dest'], context);
      expect(result).toEqual({ type: 'outside_vault', path: '/etc/dest' });
    });

    it('resets expectWriteNext for non-path tokens', () => {
      const context = createMockContext({ '/vault/file.txt': 'vault' });
      const result = findBashPathViolationInSegment(['echo', '>', 'non-path-word', '/vault/file.txt'], context);
      expect(result).toBeNull();
    });

    it('clears expectWriteNext on standalone input redirect operator', () => {
      const context = createMockContext({
        '/vault/data.txt': 'vault',
        '/vault/out.txt': 'vault',
      });
      // '>' sets expectWriteNext=true, then '<' clears it to false,
      // so /vault/data.txt is treated as read, not write
      const result = findBashPathViolationInSegment(
        ['cmd', '>', '/vault/out.txt', '<', '/vault/data.txt'], context
      );
      expect(result).toBeNull();
    });

    it('allows embedded output redirect to vault path', () => {
      const context = createMockContext({ '/vault/output.txt': 'vault' });
      const result = findBashPathViolationInSegment(['echo', 'test', '>/vault/output.txt'], context);
      expect(result).toBeNull();
    });

    it('allows --output= with vault path', () => {
      const context = createMockContext({ '/vault/file.txt': 'vault' });
      const result = findBashPathViolationInSegment(['tool', '--output=/vault/file.txt'], context);
      expect(result).toBeNull();
    });

    it('allows --out= with vault path', () => {
      const context = createMockContext({ '/vault/file.txt': 'vault' });
      const result = findBashPathViolationInSegment(['tool', '--out=/vault/file.txt'], context);
      expect(result).toBeNull();
    });

    it('allows --outfile= with vault path', () => {
      const context = createMockContext({ '/vault/file.txt': 'vault' });
      const result = findBashPathViolationInSegment(['tool', '--outfile=/vault/file.txt'], context);
      expect(result).toBeNull();
    });

    it('allows --output-file= with vault path', () => {
      const context = createMockContext({ '/vault/file.txt': 'vault' });
      const result = findBashPathViolationInSegment(['tool', '--output-file=/vault/file.txt'], context);
      expect(result).toBeNull();
    });

    it('allows -o with vault path (embedded)', () => {
      const context = createMockContext({ '/vault/output.log': 'vault' });
      const result = findBashPathViolationInSegment(['curl', '-o/vault/output.log'], context);
      expect(result).toBeNull();
    });
  });

  describe('findBashCommandPathViolation', () => {
    const createMockContext = (pathMap: Record<string, PathAccessType>) => ({
      getPathAccessType: jest.fn().mockImplementation((path: string) => {
        return pathMap[path] || 'none';
      }),
    });

    it('returns null for empty command', () => {
      const context = createMockContext({});
      const result = findBashCommandPathViolation('', context);
      expect(result).toBeNull();
    });

    it('returns null for commands without paths', () => {
      const context = createMockContext({});
      const result = findBashCommandPathViolation('echo hello', context);
      expect(result).toBeNull();
    });

    it('detects violation in chained commands', () => {
      const context = createMockContext({ '/vault/file.txt': 'vault' });
      const result = findBashCommandPathViolation('cat /vault/file.txt && rm /etc/passwd', context);
      expect(result).toEqual({ type: 'outside_vault', path: '/etc/passwd' });
    });

    it('detects violation in piped commands', () => {
      const context = createMockContext({});
      const result = findBashCommandPathViolation('echo hello | cat > /etc/passwd', context);
      expect(result).toEqual({ type: 'outside_vault', path: '/etc/passwd' });
    });

    it('returns first violation found', () => {
      const context = createMockContext({});
      const result = findBashCommandPathViolation('cat /etc/passwd && cat /etc/shadow', context);
      expect(result).toEqual({ type: 'outside_vault', path: '/etc/passwd' });
    });

    it('returns null for valid vault-only command', () => {
      const context = createMockContext({
        '/vault/file1.txt': 'vault',
        '/vault/file2.txt': 'vault',
      });
      const result = findBashCommandPathViolation('cat /vault/file1.txt && cat /vault/file2.txt', context);
      expect(result).toBeNull();
    });

    it('detects export_path_read violation', () => {
      const context = createMockContext({ '~/Desktop/file.txt': 'export' });
      const result = findBashCommandPathViolation('cat ~/Desktop/file.txt', context);
      expect(result).toEqual({ type: 'export_path_read', path: '~/Desktop/file.txt' });
    });

    it('allows write to export path', () => {
      const context = createMockContext({ '~/Desktop/file.txt': 'export' });
      const result = findBashCommandPathViolation('echo hello > ~/Desktop/file.txt', context);
      expect(result).toBeNull();
    });
  });
});
