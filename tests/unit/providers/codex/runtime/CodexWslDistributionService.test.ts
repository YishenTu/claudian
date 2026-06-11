import {
  decodeWslCommandOutput,
  parseWslDistributionListOutput,
} from '@/providers/codex/runtime/CodexWslDistributionService';

describe('CodexWslDistributionService', () => {
  it('decodes UTF-16LE output emitted by wsl.exe', () => {
    const output = '\uFEFF  NAME              STATE           VERSION\r\n* Ubuntu-24.04      Running         2\r\n';
    const bytes = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(output.replace(/^\uFEFF/, ''), 'utf16le'),
    ]);

    expect(decodeWslCommandOutput(bytes)).toContain('Ubuntu-24.04');
  });

  it('decodes UTF-8 output', () => {
    expect(decodeWslCommandOutput(Buffer.from('Ubuntu 2\n', 'utf8'))).toBe('Ubuntu 2\n');
  });

  it('parses distro names, default markers, and versions without relying on state text', () => {
    expect(parseWslDistributionListOutput(`
  NAME              STATE           VERSION
* Ubuntu-24.04      Running         2
  Legacy Ubuntu     Arrêté          1
`)).toEqual([
      { name: 'Ubuntu-24.04', version: 2, isDefault: true },
      { name: 'Legacy Ubuntu', version: 1, isDefault: false },
    ]);
  });

  it('rejects output that contains no parseable distributions', () => {
    expect(() => parseWslDistributionListOutput('WSL is not installed')).toThrow(
      'No WSL distributions were found',
    );
  });
});
