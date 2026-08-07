// npm auto-includes README.md/LICENSE only from the package dir. Copy them in from the repo
// root at pack time so the tarball ships docs without maintaining duplicates in git
// (postpack removes the copies; .gitignore keeps them out of commits).
// Status goes to stderr: `npm pack --silent` stdout is the tarball name and must stay clean.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(pkgDir, '..', '..');

for (const name of ['README.md', 'LICENSE']) {
  const src = path.join(repoRoot, name);
  if (!fs.existsSync(src)) {
    process.stderr.write(`prepack: ${src} is missing — the npm tarball must ship ${name}\n`);
    process.exit(1);
  }
  fs.copyFileSync(src, path.join(pkgDir, name));
}
if (!fs.existsSync(path.join(pkgDir, 'prompts', 'consolidate@v1.md'))) {
  process.stderr.write('prepack: prompts/ pack is missing from packages/cli — refusing to pack\n');
  process.exit(1);
}
process.stderr.write('prepack: copied README.md + LICENSE from the repo root\n');
