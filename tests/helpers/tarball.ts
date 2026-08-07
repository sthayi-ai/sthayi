import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';
import { type Headers, extract, pack } from 'tar-stream';

/**
 * BUILDING ARCHIVES THE WAY AN ATTACKER WOULD, not the way `tar(1)` is willing to.
 *
 * The tarball-contents gate used to stage its archives by shelling out to `tar -czf`, which made a
 * whole class of defect untestable: bsdtar will not write a member whose name has a trailing
 * space, will not put two members with the same name in one archive without complaint, and on
 * macOS silently adds AppleDouble (`._name`) members of its own. The verifier's job is to survive
 * an archive nobody's `tar` would produce, so the archives here are assembled member by member out
 * of raw headers — the name is written EXACTLY as given, the type is whatever is asked for, and
 * duplicates are kept.
 *
 * Nothing here extracts anything; the members are held in memory and gzipped into one file.
 */
export interface ArchiveMember {
  /** The RAW header name, byte for byte. Trailing spaces, `..`, control characters all survive. */
  name: string;
  /** Defaults to `'file'`. Directory names conventionally carry a trailing slash. */
  type?: Headers['type'];
  body?: Buffer;
  /** Required for `'symlink'` and `'link'`; the path the member points at. */
  linkname?: string;
  mode?: number;
}

/** The members of the staging tree at `root`, as `npm pack` would lay them out: dirs then files. */
export function membersOf(root: string): ArchiveMember[] {
  const out: ArchiveMember[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const name of fs.readdirSync(dir).sort()) {
      const abs = path.join(dir, name);
      const here = rel === '' ? name : `${rel}/${name}`;
      const stat = fs.lstatSync(abs);
      if (stat.isDirectory()) {
        out.push({ name: `${here}/`, type: 'directory' });
        walk(abs, here);
      } else if (stat.isFile()) {
        out.push({ name: here, type: 'file', body: fs.readFileSync(abs) });
      }
    }
  };
  walk(root, '');
  return out;
}

/** Writes `members` to `dest` as a gzipped tar, verbatim. Returns `dest`. */
export async function writeTarball(dest: string, members: ArchiveMember[]): Promise<string> {
  const packer = pack();
  const collected = (async (): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    for await (const chunk of packer) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  })();

  for (const member of members) {
    const header: Headers = {
      name: member.name,
      type: member.type ?? 'file',
      mode: member.mode ?? (member.type === 'directory' ? 0o755 : 0o644),
      uid: 0,
      gid: 0,
      mtime: new Date(0),
    };
    if (member.linkname !== undefined) {
      header.linkname = member.linkname;
    }
    await new Promise<void>((resolve, reject) => {
      packer.entry(header, member.body ?? Buffer.alloc(0), (err) =>
        err === undefined || err === null ? resolve() : reject(err),
      );
    });
  }
  packer.finalize();

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, zlib.gzipSync(await collected));
  return dest;
}

/**
 * Every member of a gzipped tar that already exists on disk, read IN MEMORY — raw header name, real
 * type, raw bytes, in archive order. Nothing is extracted, so a duplicate is two entries here and a
 * link is visible as a link, which is exactly what a test asserting an archive's contents needs.
 */
export async function readMembers(file: string): Promise<ArchiveMember[]> {
  const parser = extract();
  Readable.from([zlib.gunzipSync(fs.readFileSync(file))]).pipe(parser);
  const out: ArchiveMember[] = [];
  for await (const entry of parser) {
    const chunks: Buffer[] = [];
    for await (const chunk of entry) {
      chunks.push(Buffer.from(chunk));
    }
    out.push({
      name: entry.header.name,
      type: entry.header.type,
      body: Buffer.concat(chunks),
      linkname: entry.header.linkname ?? undefined,
    });
  }
  return out;
}

/** The regular-file members of an archive, keyed by their path inside the `package/` prefix. */
export async function packagedFiles(file: string): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  for (const m of await readMembers(file)) {
    if (m.type !== 'file' || !m.name.startsWith('package/')) continue;
    out.set(m.name.slice('package/'.length), m.body ?? Buffer.alloc(0));
  }
  return out;
}

/** `members` with the first entry named `name` replaced by `replacement` (or dropped). */
export function replaceMember(
  members: ArchiveMember[],
  name: string,
  replacement?: ArchiveMember,
): ArchiveMember[] {
  const at = members.findIndex((m) => m.name === name);
  if (at === -1) {
    throw new Error(`no '${name}' member to replace — the mutation would prove nothing`);
  }
  const out = [...members];
  out.splice(at, 1, ...(replacement === undefined ? [] : [replacement]));
  return out;
}

/** The body of the named member, or a throw — so a test cannot assert against nothing. */
export function bodyOf(members: ArchiveMember[], name: string): Buffer {
  const found = members.find((m) => m.name === name);
  if (found?.body === undefined) {
    throw new Error(`no '${name}' member with a body`);
  }
  return found.body;
}
