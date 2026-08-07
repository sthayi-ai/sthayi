import crypto from 'node:crypto';
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeLauncher } from '../../packages/cli/src/clients/launcher.js';
import { type FakeHome, createFakeHome } from '../helpers/fake-home.js';

/**
 * SAFETY: "written" is a claim about the file this run created, and it is CHECKED after the fact.
 *
 * The temp file's identity is re-read immediately before the rename that publishes it, while the
 * descriptor that created it remains open so its inode number cannot be recycled into a substitute.
 * A mismatch refuses — but portable Node has no `renameat`, so the rename is still aimed by a NAME
 * one syscall later. An attacker who replaces the temp inside that interval has their own inode
 * renamed onto `bin/sthayi-mcp`, and the interval cannot be closed (SECURITY.md states the residual
 * and what it grants).
 *
 * What CAN be done is refuse to call that a successful write. A rename carries the inode with it,
 * so the entry standing at the launcher name afterwards must be the one this run created; when it
 * is not, the write aborts, says the path is untrusted, and LEAVES the foreign entry standing —
 * removing a file this run did not create is exactly the behaviour the rest of the module refuses.
 *
 * This row fires strictly AFTER the identity check has passed, which is the only window the check
 * itself cannot see.
 */

const posix = process.platform !== 'win32';

const FOREIGN = 'FOREIGN LAUNCHER — this inode was never created by this invocation\n';

describe.skipIf(!posix)('safety: a launcher publication is verified, never assumed', () => {
  let home: FakeHome;

  beforeEach(() => {
    home = createFakeHome();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    home.cleanup();
  });

  it('a temp swapped AFTER the identity check is never reported as a successful write', () => {
    // The temp name is random by design, so it is pinned to be plantable at.
    vi.spyOn(crypto, 'randomBytes').mockImplementation(((n: number) =>
      Buffer.alloc(n, 0x5a)) as unknown as typeof crypto.randomBytes);
    const tmpName = `.sthayi-mcp.${'5a'.repeat(6)}.tmp`;
    fs.mkdirSync(home.path('bin'), { recursive: true });

    const realLstat = fs.lstatSync.bind(fs) as typeof fs.lstatSync;
    let fired = false;
    vi.spyOn(fs, 'lstatSync').mockImplementation(((p: fs.PathLike, o?: unknown) => {
      const st = (realLstat as (a: fs.PathLike, b?: unknown) => fs.Stats)(p, o);
      // `stillOurs()` has just proved the temp is ours. Swap it on the way out of that very call,
      // so the rename that follows carries a foreign inode onto the launcher name.
      if (!fired && String(p) === tmpName) {
        fired = true;
        fs.unlinkSync(home.path('bin', tmpName));
        fs.writeFileSync(home.path('bin', tmpName), FOREIGN, { mode: 0o755 });
      }
      return st;
    }) as unknown as typeof fs.lstatSync);

    let message = '';
    try {
      writeLauncher();
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    vi.restoreAllMocks();

    expect(fired).toBe(true);
    // The write does NOT return a path it did not write.
    expect(message).toMatch(/not the file this run created/);
    expect(message).toContain(home.path('bin', 'sthayi-mcp'));
    // The foreign entry is left exactly where it is — never silently deleted, never vouched for.
    expect(fs.readFileSync(home.path('bin', 'sthayi-mcp'), 'utf8')).toBe(FOREIGN);
    // …and the CLI launcher, whose write never began, was not created either.
    expect(fs.existsSync(home.path('bin', 'sthayi'))).toBe(false);
  });
});
