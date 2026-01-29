import { extractMcpMentions, parseCommand, splitCommandString, transformMcpMentions } from '@/utils/mcp';

describe('extractMcpMentions', () => {
  it('extracts valid MCP mentions', () => {
    const validNames = new Set(['context7', 'server1']);
    const text = 'Check @context7 and @server1 for info';
    const result = extractMcpMentions(text, validNames);
    expect(result).toEqual(new Set(['context7', 'server1']));
  });

  it('ignores invalid mentions', () => {
    const validNames = new Set(['context7']);
    const text = 'Check @unknown for info';
    const result = extractMcpMentions(text, validNames);
    expect(result).toEqual(new Set());
  });

  it('ignores context folder mentions (with /)', () => {
    const validNames = new Set(['folder']);
    const text = 'Check @folder/ for files';
    const result = extractMcpMentions(text, validNames);
    expect(result).toEqual(new Set());
  });
});

describe('transformMcpMentions', () => {
  const validNames = new Set(['context7', 'server1']);

  it('appends MCP to valid mentions', () => {
    const text = 'Check @context7 for info';
    const result = transformMcpMentions(text, validNames);
    expect(result).toBe('Check @context7 MCP for info');
  });

  it('transforms multiple mentions', () => {
    const text = '@context7 and @server1';
    const result = transformMcpMentions(text, validNames);
    expect(result).toBe('@context7 MCP and @server1 MCP');
  });

  it('transforms duplicate mentions', () => {
    const text = '@context7 then @context7 again';
    const result = transformMcpMentions(text, validNames);
    expect(result).toBe('@context7 MCP then @context7 MCP again');
  });

  it('does not double-transform if already has MCP', () => {
    const text = '@context7 MCP for info';
    const result = transformMcpMentions(text, validNames);
    expect(result).toBe('@context7 MCP for info');
  });

  it('does not transform context folder mentions', () => {
    const names = new Set(['folder']);
    const text = '@folder/ for files';
    const result = transformMcpMentions(text, names);
    expect(result).toBe('@folder/ for files');
  });

  it('does not transform partial matches', () => {
    const text = '@context7abc is different';
    const result = transformMcpMentions(text, validNames);
    expect(result).toBe('@context7abc is different');
  });

  it('handles overlapping names correctly (longer first)', () => {
    const names = new Set(['context', 'context7']);
    const text = '@context7 and @context';
    const result = transformMcpMentions(text, names);
    expect(result).toBe('@context7 MCP and @context MCP');
  });

  it('transforms mention at end of text', () => {
    const text = 'Check @context7';
    const result = transformMcpMentions(text, validNames);
    expect(result).toBe('Check @context7 MCP');
  });

  it('transforms mention at start of text', () => {
    const text = '@context7 is useful';
    const result = transformMcpMentions(text, validNames);
    expect(result).toBe('@context7 MCP is useful');
  });

  it('returns unchanged text when no valid names', () => {
    const text = '@context7 for info';
    const result = transformMcpMentions(text, new Set());
    expect(result).toBe('@context7 for info');
  });

  it('handles special regex characters in server name', () => {
    const names = new Set(['test.server']);
    const text = '@test.server for info';
    const result = transformMcpMentions(text, names);
    expect(result).toBe('@test.server MCP for info');
  });

  // Punctuation edge cases
  it('transforms mention followed by period', () => {
    const text = 'Check @context7.';
    const result = transformMcpMentions(text, validNames);
    expect(result).toBe('Check @context7 MCP.');
  });

  it('transforms mention followed by comma', () => {
    const text = '@context7, please check';
    const result = transformMcpMentions(text, validNames);
    expect(result).toBe('@context7 MCP, please check');
  });

  it('transforms mention followed by colon', () => {
    const text = '@context7: check this';
    const result = transformMcpMentions(text, validNames);
    expect(result).toBe('@context7 MCP: check this');
  });

  it('transforms mention followed by question mark', () => {
    const text = 'Did you check @context7?';
    const result = transformMcpMentions(text, validNames);
    expect(result).toBe('Did you check @context7 MCP?');
  });

  it('does not transform partial match with dot-suffix', () => {
    // @test should NOT match in @test.foo when only "test" is valid
    const names = new Set(['test']);
    const text = '@test.foo is unknown';
    const result = transformMcpMentions(text, names);
    expect(result).toBe('@test.foo is unknown');
  });

  it('transforms server with dot in name followed by period', () => {
    const names = new Set(['test.server']);
    const text = 'Check @test.server.';
    const result = transformMcpMentions(text, names);
    expect(result).toBe('Check @test.server MCP.');
  });

  // Multiline
  it('transforms mentions across multiple lines', () => {
    const text = 'First @context7\nSecond @server1';
    const result = transformMcpMentions(text, validNames);
    expect(result).toBe('First @context7 MCP\nSecond @server1 MCP');
  });

  it('transforms mention followed by newline', () => {
    const text = '@context7\nmore text';
    const result = transformMcpMentions(text, validNames);
    expect(result).toBe('@context7 MCP\nmore text');
  });

  // Empty input
  it('handles empty input text', () => {
    const result = transformMcpMentions('', validNames);
    expect(result).toBe('');
  });
});

describe('splitCommandString', () => {
  it('splits simple command', () => {
    expect(splitCommandString('node server.js')).toEqual(['node', 'server.js']);
  });

  it('handles single word', () => {
    expect(splitCommandString('claude')).toEqual(['claude']);
  });

  it('handles empty string', () => {
    expect(splitCommandString('')).toEqual([]);
  });

  it('handles whitespace-only string', () => {
    expect(splitCommandString('   ')).toEqual([]);
  });

  it('handles double-quoted arguments', () => {
    expect(splitCommandString('echo "hello world"')).toEqual(['echo', 'hello world']);
  });

  it('handles single-quoted arguments', () => {
    expect(splitCommandString("echo 'hello world'")).toEqual(['echo', 'hello world']);
  });

  it('handles multiple quoted arguments', () => {
    expect(splitCommandString('cmd "arg one" "arg two"')).toEqual(['cmd', 'arg one', 'arg two']);
  });

  it('handles mixed quoted and unquoted arguments', () => {
    expect(splitCommandString('cmd --flag "quoted arg" plain')).toEqual(['cmd', '--flag', 'quoted arg', 'plain']);
  });

  it('handles multiple spaces between arguments', () => {
    expect(splitCommandString('cmd   arg1    arg2')).toEqual(['cmd', 'arg1', 'arg2']);
  });

  it('handles leading and trailing whitespace', () => {
    expect(splitCommandString('  cmd arg  ')).toEqual(['cmd', 'arg']);
  });

  it('handles tab characters as whitespace', () => {
    expect(splitCommandString('cmd\targ1\targ2')).toEqual(['cmd', 'arg1', 'arg2']);
  });

  it('preserves spaces inside quotes', () => {
    expect(splitCommandString('"path with spaces/bin" --arg')).toEqual(['path with spaces/bin', '--arg']);
  });

  it('handles adjacent quoted and unquoted content', () => {
    // Quotes are stripped, so "foo"bar becomes foobar
    expect(splitCommandString('"foo"bar')).toEqual(['foobar']);
  });
});

describe('parseCommand', () => {
  it('parses command with no arguments', () => {
    expect(parseCommand('claude')).toEqual({ cmd: 'claude', args: [] });
  });

  it('parses command with arguments', () => {
    expect(parseCommand('node server.js --port 3000')).toEqual({
      cmd: 'node',
      args: ['server.js', '--port', '3000'],
    });
  });

  it('uses providedArgs when given', () => {
    expect(parseCommand('node', ['--version'])).toEqual({
      cmd: 'node',
      args: ['--version'],
    });
  });

  it('ignores command string parsing when providedArgs is non-empty', () => {
    expect(parseCommand('node server.js', ['--help'])).toEqual({
      cmd: 'node server.js',
      args: ['--help'],
    });
  });

  it('falls back to parsing when providedArgs is empty array', () => {
    expect(parseCommand('node server.js', [])).toEqual({
      cmd: 'node',
      args: ['server.js'],
    });
  });

  it('handles empty command string', () => {
    expect(parseCommand('')).toEqual({ cmd: '', args: [] });
  });

  it('handles quoted arguments in command string', () => {
    expect(parseCommand('echo "hello world" --verbose')).toEqual({
      cmd: 'echo',
      args: ['hello world', '--verbose'],
    });
  });
});
