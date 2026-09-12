import { readFileSync } from 'node:fs';
import path from 'node:path';

// Match the production binary-asset loader while running the real SQL engine.
const bytes = readFileSync(path.join(path.dirname(require.resolve('sql.js')), 'sql-wasm.wasm'));
export default new Uint8Array(bytes);
