import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { getDevelopmentWatchFiles } from './devWatchFiles.mjs';

test('includes manifest and every CSS source in the development watch set', () => {
  const root = mkdtempSync(join(tmpdir(), 'claudian-dev-watch-'));
  const styleRoot = join(root, 'src', 'style');
  mkdirSync(join(styleRoot, 'nested'), { recursive: true });
  writeFileSync(join(root, 'manifest.json'), '{}');
  writeFileSync(join(styleRoot, 'index.css'), '@import "base.css";');
  writeFileSync(join(styleRoot, 'base.css'), '.base {}');
  writeFileSync(join(styleRoot, 'nested', 'feature.css'), '.feature {}');

  assert.deepEqual(getDevelopmentWatchFiles(root), [
    join(root, 'manifest.json'),
    join(styleRoot, 'base.css'),
    join(styleRoot, 'index.css'),
    join(styleRoot, 'nested', 'feature.css'),
  ]);
});
