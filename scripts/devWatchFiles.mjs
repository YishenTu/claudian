import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function listCssFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listCssFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith('.css')) {
      files.push(entryPath);
    }
  }
  return files;
}

export function getDevelopmentWatchFiles(root) {
  const styleRoot = join(root, 'src', 'style');
  const cssFiles = existsSync(styleRoot) ? listCssFiles(styleRoot) : [];
  return [
    join(root, 'manifest.json'),
    ...cssFiles.sort(),
  ];
}
