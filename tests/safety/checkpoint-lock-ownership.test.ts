import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileCheckpoint } from '../../packages/cli/src/drivers/checkpoint-file.js';
import { removeOwned } from '../helpers/owned-fs.js';
import { runTempDir } from '../helpers/run-temp.js';

/**
 * SAFETY: OWNERSHIP of the journal-checkpoint lock.
 *
 * The lock next to `~/.sthayi/journal.checkpoint` is what keeps two cooperating `sthayi` processes
 * from clobbering each other's tamper evidence. Two ownership mistakes would make it WORSE than no
 * lock at all, because each lets a writer proceed while BELIEVING it is serialized:
 *
 *   1. A STALE OBSERVER UNLINKING A NEW PEER'S LOCK. Reclaiming an "abandoned" lock as
 *      `lstat` -> (age check) -> `unlink` is a TOCTOU: between the lstat and the unlink the old
 *      holder can release and a NEW holder can acquire, and the observer then deletes a lock that
 *      is very much alive, on the strength of an age it read from an inode that no longer occupies
 *      the path.
 *   2. AN OLD HOLDER RELEASING THE NEWER HOLDER'S LOCK. Unlinking `lockPath()` unconditionally
 *      removes whatever inode happens to be there, owned by whoever.
 *
 * Both are driven here by a SEAM, not by timing: the `node:fs` function the driver is about to
 * call is replaced for the duration of one call so the interleaving happens at an exact,
 * repeatable point.
 *
 * HONEST BOUNDARY: none of this makes the lock a security boundary. A malicious process running as
 * the same user can delete the lock, take it, or swap the checkpoint file at any moment — it can
 * equally read the vault key and rewrite the database. What these tests pin is that Sthayi's own
 * writers never destroy each other's locks, so a same-user race cannot win SILENTLY by riding on an
 * innocent Sthayi write.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
const driverPath = path.join(repoRoot, 'packages', 'cli', 'src', 'drivers', 'checkpoint-file.js');

/** The real implementations, captured before any seam can replace them. */
const realLstat = fs.lstatSync as unknown as (p: fs.PathLike, o?: object) => fs.Stats;
const realUnlink = fs.unlinkSync as unknown as (p: fs.PathLike) => void;
const realWrite = fs.writeFileSync as unknown as (
  p: fs.PathLike,
  data: string | NodeJS.ArrayBufferView,
  o?: object,
) => void;

type Patchable = 'writeFileSync' | 'lstatSync' | 'unlinkSync';
const fsMut = fs as unknown as Record<Patchable, unknown>;

/**
 * Replace one `node:fs` function for the duration of `body`, restoring it even if `body` throws.
 * The driver reaches these through the shared `node:fs` module object, so a swap here interleaves
 * its steps at an EXACT point — this is a seam, never a sleep, so the interleaving is
 * deterministic on every machine.
 */
function withSeam<T>(name: Patchable, impl: unknown, body: () => T): T {
  const real = fsMut[name];
  fsMut[name] = impl;
  try {
    return body();
  } finally {
    fsMut[name] = real;
  }
}

/** True for the driver's own `<checkpoint>.<pid>.<rand>.tmp` staging file — i.e. "we are inside
 *  the critical section, holding the lock, about to write". */
const isStagingWrite = (p: fs.PathLike, file: string): boolean => {
  const s = String(p);
  return s.startsWith(file) && s.endsWith('.tmp');
};

let dir: string;
let file: string;
let lock: string;

beforeEach(() => {
  // realpath: on macOS os.tmpdir() is reached through /var -> /private/var, and the driver
  // (correctly) refuses a symlinked ancestor — fixtures name their directory canonically.
  dir = runTempDir('sthayi-cplock-');
  file = path.join(dir, 'journal.checkpoint');
  lock = `${file}.lock`;
});

afterEach(() => {
  removeOwned(dir);
});

describe('safety: journal checkpoint lock ownership', () => {
  it('an observer NEVER unlinks a foreign lock, even one that changed hands mid-inspection', () => {
    const cp = new FileCheckpoint(file, { lockWaitMs: 40 });
    cp.write('v1');

    // A previous holder's lock, aged well past any age-based reclamation threshold.
    realWrite(lock, 'OLD-HOLDER\n', { mode: 0o600 });
    const ancient = new Date(Date.now() - 3_600_000);
    fs.utimesSync(lock, ancient, ancient);

    const unlinked: string[] = [];
    let handedOver = false;

    withSeam(
      'unlinkSync',
      (p: fs.PathLike) => {
        unlinked.push(String(p));
        realUnlink(p);
      },
      () =>
        withSeam(
          'lstatSync',
          (p: fs.PathLike, o?: object) => {
            const st = realLstat(p, o);
            if (String(p) === lock && !handedOver) {
              // THE RACE, exactly: the observer has just read the (ancient) lock inode. Before it
              // can act on what it learned, the old holder releases and a NEW peer acquires a
              // brand-new lock at the same path. Everything the observer now "knows" is about an
              // inode that no longer occupies that name.
              handedOver = true;
              realUnlink(lock);
              realWrite(lock, 'NEW-HOLDER\n', { mode: 0o600 });
            }
            return st;
          },
          () => {
            expect(() => cp.replace('v1', 'v2')).toThrow(/held by another writer/);
          },
        ),
    );

    expect(handedOver, 'the seam never fired — this case is not exercising the race').toBe(true);
    // The new holder's lock is still there, still theirs.
    expect(fs.readFileSync(lock, 'utf8')).toBe('NEW-HOLDER\n');
    expect(unlinked.filter((p) => p === lock)).toEqual([]);
    // …and nothing was written through the lock we were never entitled to break.
    expect(fs.readFileSync(file, 'utf8')).toBe('v1');
  });

  it('releasing NEVER unlinks a lock that is no longer ours', () => {
    const cp = new FileCheckpoint(file);
    cp.write('v1');
    let handedOver = false;

    withSeam(
      'writeFileSync',
      (p: fs.PathLike, data: string | NodeJS.ArrayBufferView, o?: object) => {
        if (!handedOver && isStagingWrite(p, file)) {
          handedOver = true;
          // We hold the lock and are mid-write when OUR lock file is removed out from under us
          // (a manual recovery, or a peer running an older build that still reclaimed by age),
          // and a DIFFERENT writer immediately takes a brand-new lock at the same path.
          realUnlink(lock);
          realWrite(lock, 'NEW-HOLDER\n', { mode: 0o600 });
        }
        realWrite(p, data, o);
      },
      () => {
        expect(cp.replace('v1', 'v2')).toBe(true);
      },
    );

    expect(handedOver, 'the seam never fired — this case is not exercising the race').toBe(true);
    // Release must have recognised that the path no longer holds OUR inode and left it alone.
    expect(fs.existsSync(lock), 'release deleted a lock belonging to another holder').toBe(true);
    expect(fs.readFileSync(lock, 'utf8')).toBe('NEW-HOLDER\n');
  });

  it('a peer cannot enter the critical section while a writer holds the lock, however old it looks', () => {
    const holder = new FileCheckpoint(file);
    const peer = new FileCheckpoint(file, { lockWaitMs: 30 });
    holder.write('v1');
    let nested = false;
    let peerOutcome = 'never ran';

    withSeam(
      'writeFileSync',
      (p: fs.PathLike, data: string | NodeJS.ArrayBufferView, o?: object) => {
        if (!nested && isStagingWrite(p, file)) {
          nested = true;
          // A writer that has legitimately HELD the lock for a long time is indistinguishable by
          // mtime from one that crashed — so age the live holder's lock and let a peer try.
          const ancient = new Date(Date.now() - 3_600_000);
          fs.utimesSync(lock, ancient, ancient);
          try {
            peerOutcome = peer.replace('v1', 'PEER-WON') ? 'ENTERED' : 'cas-conflict';
          } catch (err) {
            peerOutcome = `refused: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
        realWrite(p, data, o);
      },
      () => {
        expect(holder.replace('v1', 'v2')).toBe(true);
      },
    );

    expect(nested, 'the seam never fired — this case is not exercising the race').toBe(true);
    expect(peerOutcome).toMatch(/^refused: .*held by another writer/);
    expect(fs.readFileSync(file, 'utf8')).toBe('v2');
    expect(fs.existsSync(lock)).toBe(false); // the holder released its own lock cleanly
  });

  it('a genuinely held lock fails CLOSED: bounded wait, then an error that names the recovery', () => {
    const cp = new FileCheckpoint(file, { lockWaitMs: 60 });
    cp.write('v1');
    realWrite(lock, '424242\n', { mode: 0o600 });

    const started = Date.now();
    let message = '';
    expect(() => {
      try {
        cp.replace('v1', 'v2');
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
        throw err;
      }
    }).toThrow(/held by another writer/);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(50); // it really waited for the holder…
    expect(elapsed).toBeLessThan(5_000); // …and the wait is BOUNDED, not forever
    // The message has to be enough to recover BY HAND, because nothing reclaims automatically.
    expect(message).toContain(lock);
    expect(message).toContain('424242'); // the recorded holder, so "is it alive?" is checkable
    if (process.platform === 'win32') {
      expect(message).toContain('PowerShell: Remove-Item -LiteralPath');
    } else {
      expect(message).toMatch(/rm -- /); // the literal POSIX command
    }
    // Fail closed means fail UNTOUCHED.
    expect(fs.readFileSync(file, 'utf8')).toBe('v1');
    expect(fs.readFileSync(lock, 'utf8')).toBe('424242\n');
  });
});

/**
 * The cooperative-serialization proof, across REAL processes: N `tsx` children each run a
 * read-modify-write compare-and-swap loop against one checkpoint file. Each child, while inside
 * the critical section, brackets its stay in a shared append-only witness log AND back-dates its
 * own lock file — time-compressing "a holder that has been in there a long while" so the proof
 * does not have to run for the age threshold to matter.
 *
 * Three independent things are asserted: the witness log is strictly nested (mutual exclusion),
 * the final count equals every increment (no lost update), and a poller sampling the destination
 * throughout never observes anything but a complete, parseable checkpoint (no interleaved partial
 * write).
 */
describe.skipIf(process.platform === 'win32')(
  'safety: cooperative checkpoint writers stay serialized across processes',
  () => {
    const PEERS = 4;
    const ROUNDS = 6;
    /**
     * How long a writer waits at the start barrier before declaring its peers absent.
     *
     * The children coordinate through a directory, and a directory cannot tell "still starting"
     * from "died before it ever wrote its ready file" — a writer whose peer failed to launch would
     * otherwise spin against that name for as long as the runner allows, and the error that
     * actually happened (on the dead peer's stderr) would never be read. Generous enough that a
     * slow cold start is never mistaken for an absent peer, and finite so a peer that is never
     * coming is REPORTED rather than waited on.
     */
    const BARRIER_MS = 30_000;

    const childSource = (target: string, witness: string, readyDir: string) => `
import fs from 'node:fs';
import { FileCheckpoint } from ${JSON.stringify(driverPath)};

const file = ${JSON.stringify(target)};
const witness = ${JSON.stringify(witness)};
const readyDir = ${JSON.stringify(readyDir)};
const lock = file + '.lock';
const id = process.argv[2];
const peers = Number(process.argv[3]);
const rounds = Number(process.argv[4]);

const sleep = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const note = (line) => {
  // O_APPEND write of a short line is atomic on POSIX, so the log itself can never tear.
  const fd = fs.openSync(witness, 'a');
  try { fs.writeSync(fd, line); } finally { fs.closeSync(fd); }
};

// Barrier: nobody starts until everybody is up, so the contention is real — and it is BOUNDED,
// so a peer that never arrives is reported here instead of being waited on indefinitely.
fs.writeFileSync(readyDir + '/' + id, '');
const barrierDeadline = Date.now() + ${BARRIER_MS};
for (;;) {
  const up = fs.readdirSync(readyDir);
  if (up.length >= peers) { break; }
  if (Date.now() > barrierDeadline) {
    process.stderr.write('writer ' + id + ' waited for ' + peers + ' peers; only [' + up.sort().join(',') + '] ever started\\n');
    process.exit(4);
  }
  sleep(2);
}

const realWrite = fs.writeFileSync;
fs.writeFileSync = (p, d, o) => {
  const s = String(p);
  if (s.startsWith(file) && s.endsWith('.tmp')) {
    note('ENTER ' + id + '\\n');
    const ancient = new Date(Date.now() - 3600000);
    try { fs.utimesSync(lock, ancient, ancient); } catch {}
    sleep(8);
    realWrite(p, d, o);
    note('EXIT ' + id + '\\n');
    return;
  }
  realWrite(p, d, o);
};

let done = 0;
let attempts = 0;
while (done < rounds && attempts < 5000) {
  attempts++;
  try {
    const cp = new FileCheckpoint(file);
    const cur = cp.read();
    const n = cur === undefined ? 0 : JSON.parse(cur).count;
    // The payload carries WHO wrote it and WHICH round, so no two writers can ever aim at
    // byte-identical content. Without that, replace()'s idempotent "the destination already
    // holds exactly these bytes" branch returns true for a writer that wrote nothing, and this
    // loop would miscount a coincidence as its own increment.
    const next = JSON.stringify({ v: 1, count: n + 1, by: id, round: done + 1 });
    if (cp.replace(cur, next)) { done++; }
  } catch {
    // failing closed on contention is the CONTRACT — back off and try again
    sleep(3);
  }
}
process.exit(done === rounds ? 0 : 3);
`;

    it('N processes each doing a CAS replace: no lost update, no interleave, no partial write', async () => {
      const witness = path.join(dir, 'witness.log');
      const readyDir = path.join(dir, 'ready');
      const child = path.join(dir, 'writer.mts');
      fs.mkdirSync(readyDir);
      realWrite(witness, '');
      realWrite(child, childSource(file, witness, readyDir));

      const samples: string[] = [];
      const bad: string[] = [];
      const poll = setInterval(() => {
        let raw: string;
        try {
          raw = fs.readFileSync(file, 'utf8');
        } catch {
          return; // not created yet, or momentarily absent between rename steps
        }
        if (samples[samples.length - 1] !== raw) {
          samples.push(raw);
        }
        try {
          const parsed = JSON.parse(raw) as { v?: number; count?: number };
          if (parsed.v !== 1 || typeof parsed.count !== 'number') {
            bad.push(raw);
          }
        } catch {
          bad.push(raw); // a torn / interleaved write would land here
        }
      }, 1);

      // A run in which one writer has already failed can no longer be completed by the others, and
      // waiting for them to reach their own barrier deadline only delays the report. So the FIRST
      // non-zero exit ends the run: the wait is bounded by the signal that the proof is unreachable
      // rather than by a duration. Every writer's output is collected either way, so the assertion
      // below names the failure that actually happened.
      const writers: ReturnType<typeof spawn>[] = [];
      const stopWriters = (): void => {
        for (const p of writers) {
          p.kill('SIGKILL');
        }
      };
      const codes = await Promise.all(
        Array.from(
          { length: PEERS },
          (_, i) =>
            new Promise<{ code: number | null; out: string }>((resolve) => {
              const proc = spawn(tsxBin, [child, String(i), String(PEERS), String(ROUNDS)], {
                cwd: dir,
                stdio: ['ignore', 'pipe', 'pipe'],
              });
              writers.push(proc);
              let out = '';
              let settled = false;
              const finish = (code: number | null): void => {
                if (settled) {
                  return; // a spawn failure reports both 'error' and 'close'; the first one wins
                }
                settled = true;
                if (code !== 0) {
                  stopWriters();
                }
                resolve({ code, out });
              };
              proc.stdout.on('data', (d: Buffer) => {
                out += d.toString();
              });
              proc.stderr.on('data', (d: Buffer) => {
                out += d.toString();
              });
              // Without a listener a spawn failure is an unhandled emitter error, which takes the
              // whole file down without ever saying which writer could not start.
              proc.on('error', (err: Error) => {
                out += `${err.message}\n`;
                finish(null);
              });
              proc.on('close', (code) => finish(code));
            }),
        ),
      );
      clearInterval(poll);

      for (const c of codes) {
        expect(c.code, `a cooperative writer did not finish its rounds:\n${c.out}`).toBe(0);
      }

      // 1. NO LOST UPDATE: every single increment survived.
      const final = JSON.parse(fs.readFileSync(file, 'utf8')) as { count: number };
      expect(final.count).toBe(PEERS * ROUNDS);

      // 2. MUTUAL EXCLUSION: the witness log is strictly nested.
      const lines = fs.readFileSync(witness, 'utf8').split('\n').filter(Boolean);
      expect(lines.length).toBe(PEERS * ROUNDS * 2);
      let inside: string | null = null;
      const violations: string[] = [];
      for (const line of lines) {
        const [kind, who] = line.split(' ');
        if (kind === 'ENTER') {
          if (inside !== null) {
            violations.push(`${who} entered while ${inside} was still inside`);
          }
          inside = who ?? null;
        } else if (kind === 'EXIT') {
          if (inside !== who) {
            violations.push(`${who} exited but ${inside ?? 'nobody'} held the section`);
          }
          inside = null;
        } else {
          violations.push(`torn witness line: ${JSON.stringify(line)}`);
        }
      }
      expect(violations).toEqual([]);
      expect(inside).toBeNull();

      // 3. NO PARTIAL WRITE: every snapshot the poller caught was a complete checkpoint.
      expect(bad).toEqual([]);
      expect(samples.length).toBeGreaterThan(1); // the poller really did watch it change

      // 4. No lock or tmp debris survives a fully cooperative run.
      expect(fs.existsSync(lock)).toBe(false);
      expect(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    }, 120_000);
  },
);
