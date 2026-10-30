const { globSync, readFileSync } = require('node:fs');
const path = require('node:path');

const isTestFile = file => /^tests\/(?:unit|integration)\/.*\.test\.ts$/.test(file);

// Read comments only: test modules are never imported or executed by CI selection.
function declarationIn(file, source) {
  const header = source.match(/^(?:\s|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/)[0];
  let declaration;
  for (const [index, line] of header.split(/\r?\n/).entries()) {
    if (!line.includes('@test-ci')) continue;
    const fail = message => { throw new Error(`${file}:${index + 1}: ${message}`); };
    if (!isTestFile(file)) fail('@test-ci is only allowed in unit/integration test files');
    if (declaration) fail('duplicate @test-ci declaration');
    const match = line.match(/^\s*\/\/ @test-ci (.+)$/);
    if (!match) fail('expected // @test-ci followed by one JSON object');
    let value;
    try { value = JSON.parse(match[1]); } catch { fail('invalid @test-ci JSON'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !['native', 'inputs'].includes(key))) {
      fail('@test-ci accepts only native and inputs');
    }
    if ('native' in value && value.native !== true) fail('native must be true or omitted');
    if ('inputs' in value && (!Array.isArray(value.inputs) || value.inputs.length === 0)) {
      fail('inputs must be a nonempty array');
    }
    const inputs = value.inputs ?? [];
    if (!value.native && inputs.length === 0) fail('@test-ci must declare native or inputs');
    const seen = new Set();
    for (const input of inputs) {
      if (typeof input !== 'string' || !/^(?:src|tests)\//.test(input)
        || input.includes('\\') || input.split('/').some(part => ['', '.', '..'].includes(part))
        || input.includes('!') || input.includes('(') || input.includes(')')) {
        fail('inputs must be repository-relative src/ or tests/ paths or globs');
      }
      if (seen.has(input)) fail(`duplicate input: ${input}`);
      seen.add(input);
    }
    declaration = { native: value.native === true, inputs, fail };
  }
  return declaration;
}

function readTestDeclarations(root, { validateNonTests = false } = {}) {
  // The ordinary selector visits test headers only. The script check also rejects
  // declarations misplaced in support files, without adding that work to each push.
  const pattern = validateNonTests ? 'tests/**/*.{ts,tsx,js,jsx,cjs,mjs}' : 'tests/{unit,integration}/**/*.test.ts';
  const files = globSync(pattern, { cwd: root }).map(file => file.split(path.sep).join('/')).sort();
  const crossPlatformTests = [];
  const consumers = new Map();
  const validatedInputs = new Set();
  for (const file of files) {
    const declaration = declarationIn(file, readFileSync(path.join(root, file), 'utf8'));
    if (!declaration) continue;
    if (declaration.native) crossPlatformTests.push(file);
    for (const input of declaration.inputs) {
      if (!validatedInputs.has(input)) {
        if (!globSync(input, { cwd: root, withFileTypes: true }).some(entry => entry.isFile())) {
          declaration.fail(`input matches no files: ${input}`);
        }
        validatedInputs.add(input);
      }
      if (!consumers.has(input)) consumers.set(input, []);
      consumers.get(input).push(file);
    }
  }
  return { crossPlatformTests, fileConsumers: [...consumers] };
}

module.exports = { readTestDeclarations };
