// Remove the README.md/LICENSE copies prepack.mjs made — the repo-root files stay the single
// source of truth and the package dir stays clean between packs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const name of ['README.md', 'LICENSE']) {
  fs.rmSync(path.join(pkgDir, name), { force: true });
}
