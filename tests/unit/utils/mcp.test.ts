/**
 * Tests for MCP utility functions
 */

import { extractMcpMentions, transformMcpMentions } from '@/utils/mcp';

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
});
