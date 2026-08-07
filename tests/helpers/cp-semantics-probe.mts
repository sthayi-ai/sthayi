import fs from 'node:fs';
import path from 'node:path';
import { umask as processUmask } from 'node:process';

// The wrapped run replaces chmodSync. Keep the untouched function for fixture restoration so a
// Windows READONLY canary cannot prevent the parent process from removing the completed probe.
const nativeChmodSync = fs.chmodSync.bind(fs);

/**
 * Run one fixed matrix of `cpSync` calls and print what each produced, as JSON.
 *
 * It exists to be run TWICE in two separate processes: once against the untouched `node:fs`, and
 * once with `owned-fs.ts` imported so its recording wrapper is installed. The wrapper replaces a
 * call the code under test uses, and a replacement that changes the call's meaning is a defect
 * whatever else it records — a relative symlink that the real call rewrites into an absolute
 * resolved path, and that a replacement reproduces verbatim, silently starts pointing somewhere
 * else. Two processes rather than one because the wrapper is installed by importing a module, and a
 * module cannot be un-imported.
 *
 * `STHAYI_CP_PROBE_WRAPPED=1` selects the wrapped run. The working directory is argv[2], and this
 * program never removes anything: whatever it leaves is cleared by the suite that invoked it, on
 * identities recorded the moment this process exits.
 */

if (process.env.STHAYI_CP_PROBE_WRAPPED === '1') {
  await import('./owned-fs.js');
}

const base = process.argv[2] as string;
const results: Record<string, string> = {};

function record(name: string, body: () => string): void {
  try {
    results[name] = show(body());
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    // The code and the first line of the message: a call that refuses has to refuse the same way,
    // and `EEXIST` raised by a different syscall is a different refusal wearing the same code.
    results[name] = show(`THROW ${e.code ?? ''} ${(e as Error).message.split('\n')[0]}`);
  }
}

/**
 * Paths are reported relative to the working directory so two runs are comparable.
 *
 * Both spellings are folded, because the working directory a run is given and the one the kernel
 * resolves it to are not always the same text — and a comparison that treated that difference as a
 * behavioural one would report a divergence on every platform whose temp root is reached through a
 * link.
 */
function show(value: string): string {
  const real = fs.realpathSync(base);
  const roots = new Set([base, real]);
  if (process.platform === 'win32') {
    // Windows may return the exact same absolute link target in a namespaced spelling
    // (`\\?\D:\...`). Compare each probe relative to its own root, not by the incidental API
    // spelling of that root, or the bare and wrapped fixtures look different solely because they
    // were allocated under different names.
    roots.add(path.toNamespacedPath(base));
    roots.add(path.toNamespacedPath(real));
  }
  let shown = value;
  for (const root of [...roots].sort((a, b) => b.length - a.length)) {
    if (process.platform === 'win32') {
      const literal = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      shown = shown.replace(new RegExp(literal, 'gi'), '<BASE>');
    } else {
      shown = shown.split(root).join('<BASE>');
    }
  }
  return shown;
}

function work(name: string): string {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function fileModeAndContent(file: string): string {
  const st = fs.lstatSync(file);
  return `mode=0${(st.mode & 0o7777).toString(8)} content=${fs.readFileSync(file, 'utf8')}`;
}

record('relative-symlink-default', () => {
  const w = work('c1');
  fs.mkdirSync(path.join(w, 'src', 'inner'), { recursive: true });
  fs.writeFileSync(path.join(w, 'src', 'target'), 'T');
  fs.symlinkSync('../target', path.join(w, 'src', 'inner', 'link'));
  fs.cpSync(path.join(w, 'src'), path.join(w, 'dest'), { recursive: true });
  return fs.readlinkSync(path.join(w, 'dest', 'inner', 'link'));
});

record('relative-symlink-verbatim', () => {
  const w = work('c2');
  fs.mkdirSync(path.join(w, 'src', 'inner'), { recursive: true });
  fs.writeFileSync(path.join(w, 'src', 'target'), 'T');
  fs.symlinkSync('../target', path.join(w, 'src', 'inner', 'link'));
  fs.cpSync(path.join(w, 'src'), path.join(w, 'dest'), { recursive: true, verbatimSymlinks: true });
  return fs.readlinkSync(path.join(w, 'dest', 'inner', 'link'));
});

record('dereference-true', () => {
  const w = work('c3');
  fs.mkdirSync(path.join(w, 'src'), { recursive: true });
  fs.writeFileSync(path.join(w, 'src', 'target'), 'T');
  fs.symlinkSync('./target', path.join(w, 'src', 'link'));
  fs.cpSync(path.join(w, 'src'), path.join(w, 'dest'), { recursive: true, dereference: true });
  const at = path.join(w, 'dest', 'link');
  const st = fs.lstatSync(at);
  return st.isSymbolicLink()
    ? `symlink -> ${fs.readlinkSync(at)}`
    : `file ${fs.readFileSync(at, 'utf8')}`;
});

record('absolute-symlink-default', () => {
  const w = work('c4');
  fs.mkdirSync(path.join(w, 'src'), { recursive: true });
  fs.writeFileSync(path.join(w, 'src', 'target'), 'T');
  fs.symlinkSync(path.join(w, 'src', 'target'), path.join(w, 'src', 'link'));
  fs.cpSync(path.join(w, 'src'), path.join(w, 'dest'), { recursive: true });
  return fs.readlinkSync(path.join(w, 'dest', 'link'));
});

record('dangling-symlink', () => {
  const w = work('c5');
  fs.mkdirSync(path.join(w, 'src'), { recursive: true });
  fs.symlinkSync('../nowhere', path.join(w, 'src', 'link'));
  fs.cpSync(path.join(w, 'src'), path.join(w, 'dest'), { recursive: true });
  return fs.readlinkSync(path.join(w, 'dest', 'link'));
});

record('toplevel-symlink-src', () => {
  const w = work('c6');
  fs.mkdirSync(path.join(w, 'real'), { recursive: true });
  fs.writeFileSync(path.join(w, 'real', 'f'), 'F');
  fs.symlinkSync('./real', path.join(w, 'src'));
  fs.cpSync(path.join(w, 'src'), path.join(w, 'dest'), { recursive: true });
  const st = fs.lstatSync(path.join(w, 'dest'));
  return `symlink=${st.isSymbolicLink()} dir=${st.isDirectory()}`;
});

record('symlink-over-existing-file', () => {
  const w = work('c7');
  fs.mkdirSync(path.join(w, 'src'), { recursive: true });
  fs.writeFileSync(path.join(w, 'src', 'target'), 'T');
  fs.symlinkSync('./target', path.join(w, 'src', 'link'));
  fs.mkdirSync(path.join(w, 'dest'), { recursive: true });
  fs.writeFileSync(path.join(w, 'dest', 'link'), 'OLD');
  fs.cpSync(path.join(w, 'src'), path.join(w, 'dest'), { recursive: true });
  return 'no-throw';
});

record('ordinary-tree-modes', () => {
  const w = work('c8');
  fs.mkdirSync(path.join(w, 'src', 'sub'), { recursive: true });
  // Shape the fixture with the untouched primitive so this case isolates cpSync. Direct chmod
  // parity is exercised separately below, for both a directory and a file.
  nativeChmodSync(path.join(w, 'src', 'sub'), 0o751);
  fs.writeFileSync(path.join(w, 'src', 'sub', 'f'), 'F', { mode: 0o640 });
  fs.cpSync(path.join(w, 'src'), path.join(w, 'dest'), { recursive: true });
  const d = fs.lstatSync(path.join(w, 'dest', 'sub'));
  const f = fs.lstatSync(path.join(w, 'dest', 'sub', 'f'));
  return `dir=0${(d.mode & 0o7777).toString(8)} file=0${(f.mode & 0o7777).toString(8)} content=${fs.readFileSync(path.join(w, 'dest', 'sub', 'f'), 'utf8')}`;
});

record('merge-and-overwrite', () => {
  const w = work('c9');
  fs.mkdirSync(path.join(w, 'src'), { recursive: true });
  fs.writeFileSync(path.join(w, 'src', 'f'), 'N');
  fs.mkdirSync(path.join(w, 'dest'), { recursive: true });
  fs.writeFileSync(path.join(w, 'dest', 'f'), 'OLD-LONG-TAIL');
  fs.writeFileSync(path.join(w, 'dest', 'keep'), 'KEEP');
  fs.cpSync(path.join(w, 'src'), path.join(w, 'dest'), { recursive: true });
  return `f=${fs.readFileSync(path.join(w, 'dest', 'f'), 'utf8')} keep=${fs.existsSync(path.join(w, 'dest', 'keep'))}`;
});

record('dir-onto-file', () => {
  const w = work('c10');
  fs.mkdirSync(path.join(w, 'src'), { recursive: true });
  fs.writeFileSync(path.join(w, 'src', 'f'), 'F');
  fs.writeFileSync(path.join(w, 'dest'), 'IAMFILE');
  fs.cpSync(path.join(w, 'src'), path.join(w, 'dest'), { recursive: true });
  return 'no-throw';
});

record('file-onto-dir', () => {
  const w = work('c11');
  fs.writeFileSync(path.join(w, 'src'), 'F');
  fs.mkdirSync(path.join(w, 'dest'), { recursive: true });
  fs.cpSync(path.join(w, 'src'), path.join(w, 'dest'), { recursive: true });
  return 'no-throw';
});

record('file-to-new-path', () => {
  const w = work('c12');
  fs.writeFileSync(path.join(w, 'src'), 'F', { mode: 0o640 });
  fs.cpSync(path.join(w, 'src'), path.join(w, 'dest'), { recursive: true });
  return fileModeAndContent(path.join(w, 'dest'));
});

record('missing-source', () => {
  const w = work('c13');
  fs.cpSync(path.join(w, 'absent'), path.join(w, 'dest'), { recursive: true });
  return 'no-throw';
});

record('read-only-to-new-path', () => {
  const w = work('c14');
  const src = path.join(w, 'src');
  const dest = path.join(w, 'dest');
  fs.writeFileSync(src, 'READONLY');
  nativeChmodSync(src, 0o444);
  try {
    fs.cpSync(src, dest, { recursive: true });
    return fileModeAndContent(dest);
  } finally {
    nativeChmodSync(src, 0o666);
    if (fs.existsSync(dest)) nativeChmodSync(dest, 0o666);
  }
});

record('read-only-over-writable', () => {
  const w = work('c15');
  const src = path.join(w, 'src');
  const dest = path.join(w, 'dest');
  fs.writeFileSync(src, 'READONLY');
  nativeChmodSync(src, 0o444);
  fs.writeFileSync(dest, 'OLD');
  try {
    fs.cpSync(src, dest, { recursive: true });
    return fileModeAndContent(dest);
  } finally {
    nativeChmodSync(src, 0o666);
    if (fs.existsSync(dest)) nativeChmodSync(dest, 0o666);
  }
});

record('writable-over-read-only', () => {
  const w = work('c16');
  const src = path.join(w, 'src');
  const dest = path.join(w, 'dest');
  fs.writeFileSync(src, 'WRITABLE');
  fs.writeFileSync(dest, 'OLD');
  nativeChmodSync(dest, 0o444);
  try {
    fs.cpSync(src, dest, { recursive: true });
    return fileModeAndContent(dest);
  } finally {
    if (fs.existsSync(dest)) nativeChmodSync(dest, 0o666);
  }
});

record('writable-under-restrictive-umask', () => {
  const w = work('c17');
  const src = path.join(w, 'src');
  const dest = path.join(w, 'dest');
  fs.writeFileSync(src, 'WRITABLE');
  const previous = processUmask(0o222);
  try {
    fs.cpSync(src, dest, { recursive: true });
    return fileModeAndContent(dest);
  } finally {
    processUmask(previous);
    if (fs.existsSync(dest)) nativeChmodSync(dest, 0o666);
  }
});

record('direct-same-path', () => {
  const w = work('c18');
  const file = path.join(w, 'same');
  fs.writeFileSync(file, 'SAME');
  fs.copyFileSync(file, file);
  return fs.readFileSync(file, 'utf8');
});

record('direct-hard-link-alias', () => {
  const w = work('c19');
  const src = path.join(w, 'src');
  const alias = path.join(w, 'alias');
  fs.writeFileSync(src, 'ALIASED');
  fs.linkSync(src, alias);
  fs.copyFileSync(src, alias);
  return `src=${fs.readFileSync(src, 'utf8')} alias=${fs.readFileSync(alias, 'utf8')}`;
});

record('direct-exclusive-new', () => {
  const w = work('c20');
  const src = path.join(w, 'src');
  const dest = path.join(w, 'dest');
  fs.writeFileSync(src, 'EXCLUSIVE');
  fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
  return fs.readFileSync(dest, 'utf8');
});

record('direct-exclusive-existing', () => {
  const w = work('c21');
  const src = path.join(w, 'src');
  const dest = path.join(w, 'dest');
  fs.writeFileSync(src, 'EXCLUSIVE');
  fs.writeFileSync(dest, 'OLD');
  fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
  return 'no-throw';
});

record('direct-directory-chmod', () => {
  const w = work('c22');
  const dir = path.join(w, 'dir');
  fs.mkdirSync(dir);
  fs.chmodSync(dir, 0o751);
  return `mode=0${(fs.lstatSync(dir).mode & 0o7777).toString(8)}`;
});

record('direct-file-chmod', () => {
  const w = work('c23');
  const file = path.join(w, 'file');
  fs.writeFileSync(file, 'CHMOD');
  try {
    fs.chmodSync(file, 0o444);
    return fileModeAndContent(file);
  } finally {
    nativeChmodSync(file, 0o666);
  }
});

process.stdout.write(JSON.stringify(results, null, 1));
