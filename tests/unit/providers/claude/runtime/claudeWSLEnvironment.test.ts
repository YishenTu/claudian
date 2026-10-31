import { getClaudeWSLForwardedEnvironment } from '@/providers/claude/runtime/claudeWSLEnvironment';

const forwarded = (env: Record<string, string>, environmentText = '') => getClaudeWSLForwardedEnvironment(env, environmentText);
const keys = (env: Record<string, string>, environmentText = '') => forwarded(env, environmentText).map(variable => variable.key);

describe('Claude WSL environment declarations', () => {
  it('forwards Claude SDK/auth and configured variables, translating only declared host paths', () => {
    const env = {
      HOME: 'C:\\Users\\me', PATH: 'C:\\bin', USERPROFILE: 'C:\\Users\\me',
      CLAUDE_CONFIG_DIR: 'D:\\Claude home', ANTHROPIC_API_KEY: 'secret',
      CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', MCP_TIMEOUT: '5000', CUSTOM: 'value',
      SSL_CERT_FILE: '/etc/certs/custom.pem', OTHER: 'host-only', XCLAUDE_TOKEN: 'host-only',
    };
    expect(forwarded(env, 'CUSTOM=value\nSSL_CERT_FILE=/etc/certs/custom.pem'))
      .toEqual(expect.arrayContaining([
        { key: 'CLAUDE_CONFIG_DIR', hostPath: true, pathList: false },
        { key: 'ANTHROPIC_API_KEY', hostPath: false, pathList: false },
        { key: 'CLAUDE_CODE_ENTRYPOINT', hostPath: false, pathList: false },
        { key: 'MCP_TIMEOUT', hostPath: false, pathList: false },
        { key: 'CUSTOM', hostPath: false, pathList: false },
        { key: 'SSL_CERT_FILE', hostPath: false, pathList: false },
      ]));
    const forwardedKeys = keys(env);
    // Only the Claude prefixes at the start of a name are SDK variables.
    for (const key of ['HOME', 'PATH', 'USERPROFILE', 'OTHER', 'XCLAUDE_TOKEN']) expect(forwardedKeys).not.toContain(key);
  });

  it.each([
    'CLAUDE_CONFIG_DIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE',
    'CURL_CA_BUNDLE', 'NODE_EXTRA_CA_CERTS', 'TMPDIR', 'TMP', 'TEMP',
  ])('translates a Windows %s value for the distro', key => {
    for (const value of ['C:\\certs\\corp.pem', '\\\\server\\share\\corp.pem']) {
      expect(forwarded({ [key]: value }, `${key}=${value}`)).toEqual([
        { key, hostPath: true, pathList: key === 'SSL_CERT_DIR' },
      ]);
    }
  });

  it.each(['/etc/ssl/certs', 'certs/corp.pem', '/opt/C:/certs'])('leaves the Linux or relative value %s untranslated', value => {
    expect(forwarded({ SSL_CERT_DIR: value }, `SSL_CERT_DIR=${value}`)).toEqual([
      { key: 'SSL_CERT_DIR', hostPath: false, pathList: false },
    ]);
  });

  it('forwards configured HOME and PATH only as Linux values, and never USERPROFILE or WSLENV', () => {
    expect(keys({}, 'HOME=/home/me\nPATH=/usr/local/bin:/usr/bin')).toEqual(['HOME', 'PATH']);
    expect(keys({}, 'HOME=C:\\Users\\me\nPATH=/usr/bin:C:\\tools\\bin\nUSERPROFILE=/home/me\nWSLENV=CUSTOM')).toEqual([]);
    expect(keys({ HOME: '/home/me' }, 'HOME=relative/home')).toEqual([]);
  });
});
