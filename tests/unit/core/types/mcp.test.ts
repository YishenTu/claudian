import {
  DEFAULT_MCP_SERVER,
  getMcpServerType,
  isValidMcpServerConfig,
  type McpServerConfig,
} from '@/core/types/mcp';

describe('getMcpServerType', () => {
  it('should return "sse" for SSE config', () => {
    const config: McpServerConfig = { type: 'sse', url: 'https://example.com/sse' };

    expect(getMcpServerType(config)).toBe('sse');
  });

  it('should return "http" for HTTP config', () => {
    const config: McpServerConfig = { type: 'http', url: 'https://example.com/api' };

    expect(getMcpServerType(config)).toBe('http');
  });

  it('should return "http" for URL config without explicit type', () => {
    // URL-based config without type field defaults to http
    const config = { url: 'https://example.com/api' } as McpServerConfig;

    expect(getMcpServerType(config)).toBe('http');
  });

  it('should return "stdio" for command-based config', () => {
    const config: McpServerConfig = { command: 'node server.js' };

    expect(getMcpServerType(config)).toBe('stdio');
  });

  it('should return "stdio" for command-based config with explicit type', () => {
    const config: McpServerConfig = { type: 'stdio', command: 'node server.js' };

    expect(getMcpServerType(config)).toBe('stdio');
  });

  it('should return "stdio" for config with args and env', () => {
    const config: McpServerConfig = {
      command: 'node',
      args: ['server.js'],
      env: { PORT: '3000' },
    };

    expect(getMcpServerType(config)).toBe('stdio');
  });
});

describe('isValidMcpServerConfig', () => {
  it('should return true for stdio config with command', () => {
    expect(isValidMcpServerConfig({ command: 'node server.js' })).toBe(true);
  });

  it('should return true for url-based config', () => {
    expect(isValidMcpServerConfig({ url: 'https://example.com' })).toBe(true);
  });

  it('should return true for SSE config', () => {
    expect(isValidMcpServerConfig({ type: 'sse', url: 'https://example.com/sse' })).toBe(true);
  });

  it('should return true for HTTP config', () => {
    expect(isValidMcpServerConfig({ type: 'http', url: 'https://example.com/api' })).toBe(true);
  });

  it('should return false for null', () => {
    expect(isValidMcpServerConfig(null)).toBe(false);
  });

  it('should return false for undefined', () => {
    expect(isValidMcpServerConfig(undefined)).toBe(false);
  });

  it('should return false for non-object', () => {
    expect(isValidMcpServerConfig('string')).toBe(false);
    expect(isValidMcpServerConfig(42)).toBe(false);
    expect(isValidMcpServerConfig(true)).toBe(false);
  });

  it('should return false for empty object', () => {
    expect(isValidMcpServerConfig({})).toBe(false);
  });

  it('should return false for non-string command', () => {
    expect(isValidMcpServerConfig({ command: 42 })).toBe(false);
    expect(isValidMcpServerConfig({ command: null })).toBe(false);
    expect(isValidMcpServerConfig({ command: true })).toBe(false);
  });

  it('should return false for non-string url', () => {
    expect(isValidMcpServerConfig({ url: 42 })).toBe(false);
    expect(isValidMcpServerConfig({ url: null })).toBe(false);
    expect(isValidMcpServerConfig({ url: true })).toBe(false);
  });

  it('should return false for empty command string', () => {
    expect(isValidMcpServerConfig({ command: '' })).toBe(false);
  });

  it('should return false for empty url string', () => {
    expect(isValidMcpServerConfig({ url: '' })).toBe(false);
  });
});

describe('DEFAULT_MCP_SERVER', () => {
  it('should have enabled set to true', () => {
    expect(DEFAULT_MCP_SERVER.enabled).toBe(true);
  });

  it('should have contextSaving set to true', () => {
    expect(DEFAULT_MCP_SERVER.contextSaving).toBe(true);
  });
});
