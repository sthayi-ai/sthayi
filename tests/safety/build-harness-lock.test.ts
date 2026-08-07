import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BUILD_FAILED_EXIT,
  BUILD_LOCK_FILE,
  type KernelLockTool,
  LOCK_CONFLICT_EXIT,
  buildLayout,
  ensureLockFile,
  findKernelLockTool,
  lockToolArgv,
  lockedRun,
  noLockToolMessage,
  requireKernelLockTool,
} from '../helpers/build-cli.js';
import { removeOwned } from '../helpers/owned-fs.js';
import { runTempDir } from '../helpers/run-temp.js';

/**
 * SAFETY: the build lock exists to guarantee that two clean builds never run at once, and a lock a
 * second process can talk its way past guarantees nothing at all.
 *
 * WHAT GOES WRONG WITHOUT IT. `tsup --clean` empties `packages/cli/dist` and writes it again. While
 * that is happening, fourteen other test files are spawning `dist/index.js`. One builder is fine —
 * the waiters block. Two builders is not: the second empties the directory the first is still
 * writing into, and the spawns in between load a truncated entry or a chunk that is half a file.
 * The result is a nonzero exit with no explanation, in whichever unlucky test file was spawning at
 * the time, and it reads exactly like a product bug.
 *
 * THE DEFECT THIS FILE FORBIDS IS THE PATHNAME PROTOCOL ITSELF. The lock used to be `mkdir` + an
 * `owner.json` + a liveness-checked reclaim rename. That answers "may I take this lock?" about a
 * NAME, and a name is not an identity, so no amount of re-checking closes either of its races:
 *
 *   1. PATHNAME ABA. Two waiters judge the same stale lock. The first proves the owner dead and
 *      replaces it with its own LIVE lock at that name. The second — carrying an authorisation
 *      minted before that happened — renames the now-live lock into a graveyard and builds beside
 *      its holder. Reading the owner out of the directory you just moved does not fix it: the live
 *      holder's lock has already left its name, and a third waiter can `mkdir` that name inside the
 *      window.
 *   2. ACQUIRE→METADATA GAP. `mkdir` succeeds and the winner is descheduled before `owner.json`
 *      exists. A waiter sees a lock with no owner recorded, and NO answer available to it is
 *      correct: take over and it builds beside the paused winner; refuse and a genuine crash in
 *      that window wedges every future run.
 *
 * Neither race is reachable once the lock is held by the KERNEL against an open file description.
 * `flock(2)` is attached to the open file, is dropped by the kernel when the holder dies for any
 * reason — including `SIGKILL` — and is not something a waiter can take over or hand to itself
 * while the holder lives. There is no metadata, so there is no window; there is nothing to reclaim,
 * so there is no reclamation policy left to get wrong.
 *
 * WHAT IS **NOT** CLAIMED, so that what is claimed can be believed. The lock file's PATHNAME is not
 * beyond reach: any process running as this uid can rename or replace a writable path, and there is
 * no arrangement of a same-uid harness that can stop it — the same process could write
 * `packages/cli/dist` directly, which is the outcome the lock exists to prevent among COOPERATING
 * builders. The proofs below are therefore scoped to what is actually enforceable, and one of them
 * demonstrates the outside rename rather than pretending it away:
 *
 *   - waiters in this harness never unlink, reclaim, rename or replace the lock;
 *   - the path is outside `node_modules`, so package-manager churn does not remove it and cannot
 *     split one lock into two inodes;
 *   - the kernel releases it the instant the holder dies, so there is never anything to reclaim.
 *
 * SO THE PROOFS BELOW USE REAL PROCESSES. An injected clock and an injected liveness predicate
 * could only ever re-state a policy this design no longer has. What has to be demonstrated now is a
 * kernel property — that two OS processes cannot both be inside the section, and that a killed one
 * gets out of the way with nobody cleaning up after it — and that is only observable by running
 * them. The holds are a few hundred milliseconds: long enough to overlap if exclusion is broken,
 * short enough that the suite does not cost minutes to assert it.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** How long a holder stays inside the section. */
const HOLD_MS = 150;

/**
 * A real process that enters the section, records that it is inside, waits, and records that it is
 * leaving. Two of these overlapping is exactly the failure the lock exists to make impossible, so
 * the log they append to IS the evidence. `appendFileSync` on a POSIX `O_APPEND` descriptor is
 * atomic for writes this small, so the interleaving in the file is the real interleaving.
 */
const WORKER = `import fs from 'node:fs';
const [log, id, holdMs] = process.argv.slice(2);
fs.appendFileSync(log, 'ENTER ' + id + '\\n');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(holdMs));
fs.appendFileSync(log, 'EXIT ' + id + '\\n');
`;

/**
 * The same worker, but it publishes its PID and keeps signing the log while it works.
 *
 * The PID is what makes "the command this call started is no longer running" an OBSERVED fact
 * rather than an inference from the parent's exit status — and the parent's exit status is exactly
 * what stopped being trustworthy when a ceiling was put on the lock TOOL. The heartbeat is what
 * shows work continuing after a call has already returned.
 */
const SIGNING_WORKER = `import fs from 'node:fs';
const [log, id, holdMs, pidFile] = process.argv.slice(2);
fs.writeFileSync(pidFile, String(process.pid));
fs.appendFileSync(log, 'ENTER ' + id + '\\n');
const end = Date.now() + Number(holdMs);
while (Date.now() < end) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  fs.appendFileSync(log, 'WORKING ' + id + '\\n');
}
fs.appendFileSync(log, 'EXIT ' + id + '\\n');
`;

interface Bench {
  dir: string;
  lockFile: string;
  log: string;
  worker: string;
  tool: KernelLockTool;
}

/** Every fixture is allocated through the owned run-root machinery and removed through it. */
function bench(): Bench {
  const dir = runTempDir('sthayi-buildlock-');
  const worker = path.join(dir, 'worker.mjs');
  const log = path.join(dir, 'section.log');
  const lockFile = path.join(dir, 'build.lock');
  fs.writeFileSync(worker, WORKER, { mode: 0o600 });
  fs.writeFileSync(log, '', { mode: 0o600 });
  ensureLockFile(lockFile);
  return { dir, lockFile, log, worker, tool: requireKernelLockTool() };
}

const FIXTURE_ENTRIES = ['build.lock', 'section.log', 'worker.mjs'];

function sectionLog(b: Bench): string[] {
  return fs
    .readFileSync(b.log, 'utf8')
    .split('\n')
    .filter((line) => line !== '');
}

/** Launch a real builder under the kernel lock. Deliberately not awaited — overlapping is the point. */
function launch(b: Bench, id: string, holdMs = HOLD_MS, waitSeconds = 30): ChildProcess {
  return spawn(
    b.tool.path,
    lockToolArgv(b.tool, b.lockFile, waitSeconds, process.execPath, [
      b.worker,
      b.log,
      id,
      String(holdMs),
    ]),
    { stdio: 'ignore' },
  );
}

function ended(child: ChildProcess): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function settle(children: ChildProcess[]): Promise<number[]> {
  const results = await Promise.all(children.map(ended));
  return results.map((r) => r.code ?? -1);
}

/**
 * Was the lock free at this instant? A zero-wait attempt: it blocks nobody, displaces nobody, and
 * is the only question a waiter is able to ask.
 */
function probeFree(b: Bench): boolean {
  const r = lockedRun({
    lockFile: b.lockFile,
    waitSeconds: 0,
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
    tool: b.tool,
  });
  return !r.conflict && r.status === 0;
}

/**
 * Wait until every process in a killed holder's process group has actually left the kernel. The
 * wrapper's `exit` event and its command's final descriptor close are separately scheduled; the
 * former is not an ordering guarantee for the latter, especially under a container runtime.
 * Polling the real lock keeps this load-bearing: a surviving command holds it for 30 seconds and
 * exhausts this short bound, while a dead group releases it without any pathname cleanup.
 */
async function waitForFree(b: Bench): Promise<boolean> {
  for (let i = 0; i < 400; i += 1) {
    if (probeFree(b)) {
      return true;
    }
    await sleep(10);
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Write the PID-publishing worker into this bench and return its path. */
function signingWorker(b: Bench): string {
  const file = path.join(b.dir, 'signing-worker.mjs');
  fs.writeFileSync(file, SIGNING_WORKER, { mode: 0o600 });
  return file;
}

/** Is that process still there? `kill(pid, 0)` asks the kernel and signals nothing. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Wait for a process to be gone, so a probe never leaves something running behind the suite. */
async function reap(pid: number): Promise<boolean> {
  for (let i = 0; i < 600 && alive(pid); i += 1) {
    await sleep(10);
  }
  return !alive(pid);
}

/** Only the section boundaries — the heartbeat lines in between are noise for an overlap check. */
function boundaries(log: readonly string[]): string[] {
  return log.filter((line) => line.startsWith('ENTER ') || line.startsWith('EXIT '));
}

/** How long the deliberately-slow section holds, and the ceiling a caller might have imposed. */
const SLOW_MS = 700;
const WOULD_BE_CEILING_MS = 200;
const itPosix = it.skipIf(process.platform === 'win32');

describe('safety: the CLI build lock is held by the kernel, not asserted by a pathname', () => {
  itPosix('two REAL builders never stand in the section at the same time', async () => {
    // THE CENTRAL CASE, and the only one that can be demonstrated rather than argued: four real
    // processes, launched together, each announcing when it enters and leaves. If exclusion ever
    // fails the log shows two ENTERs with no EXIT between them — which is precisely two `--clean`
    // builds emptying `packages/cli/dist` while a third worker spawns out of it.
    const b = bench();
    const ids = ['a', 'b', 'c', 'd'];
    const codes = await settle(ids.map((id) => launch(b, id)));
    const log = sectionLog(b);

    const overlaps: string[] = [];
    let inside: string | undefined;
    for (const line of log) {
      const [event, who] = line.split(' ');
      if (event === 'ENTER') {
        if (inside !== undefined) {
          overlaps.push(`${String(who)} entered while ${inside} was still inside`);
        }
        inside = who;
      } else {
        inside = undefined;
      }
    }
    removeOwned(b.dir);

    expect(codes, 'a builder failed for a reason other than exclusion').toEqual([0, 0, 0, 0]);
    expect(overlaps, 'two builders were inside the section at once').toEqual([]);
    // ALL FOUR GOT IN. Without this a lock that simply never lets anybody in would satisfy the line
    // above, and the suite would deadlock instead of serialising.
    expect(log.length, 'not every builder completed the section').toBe(ids.length * 2);
    expect(log.filter((l) => l.startsWith('ENTER')).length).toBe(ids.length);
  });

  itPosix(
    'a holder that is SIGKILLed releases the lock, with nothing left to reclaim',
    async () => {
      // The other half: fail-closed must not mean wedged. Under the old protocol a crashed run left a
      // directory and an `owner.json` the next run had to JUDGE — and judging wrong in the permissive
      // direction was the two-concurrent-builds failure. The kernel drops this lock as the process
      // table entry goes, so there is no debris, no policy, and no judgement to make.
      const b = bench();
      // Its own process group, so the kill takes the tool AND the builder it launched. A kill that
      // reaped only the inner process would leave the tool holding the lock and prove nothing.
      const holder = spawn(
        b.tool.path,
        lockToolArgv(b.tool, b.lockFile, 30, process.execPath, [
          b.worker,
          b.log,
          'doomed',
          '30000',
        ]),
        { stdio: 'ignore', detached: true },
      );
      for (let i = 0; i < 400 && sectionLog(b).length === 0; i += 1) {
        await sleep(10);
      }
      const enteredBeforeKill = sectionLog(b);
      const heldWhileAlive = !probeFree(b);

      process.kill(-(holder.pid as number), 'SIGKILL');
      await ended(holder);

      // No cleanup or stale-reclaim step. The wrapper and command receive SIGKILL together, but
      // their exits are scheduled independently; wait on the real lock rather than assuming the
      // wrapper's Node `exit` event means its child has already closed the inherited descriptor.
      const freeAfterKill = await waitForFree(b);
      const survivors = fs.readdirSync(b.dir).sort();
      removeOwned(b.dir);

      expect(enteredBeforeKill, 'the holder never entered the section').toEqual(['ENTER doomed']);
      expect(heldWhileAlive, 'a live holder did not exclude anybody').toBe(true);
      expect(freeAfterKill, 'a killed holder left the lock held — it is not kernel-owned').toBe(
        true,
      );
      // NOTHING TO CLEAN UP. A crashed holder under the old protocol left a lock directory and an
      // owner file behind; here the only artefact is the lock file, which is permanent by design.
      expect(survivors, 'a killed holder left debris beside the lock').toEqual(FIXTURE_ENTRIES);
    },
  );

  itPosix('there is NO acquire-to-metadata window, because there is no metadata', async () => {
    // The second race in the old protocol was a state a waiter could observe and had no correct
    // answer for: the lock exists and records no owner. That state cannot arise here — exclusion is
    // not carried by the existence of a name, and the file carries nothing at all.
    const b = bench();
    const beforeAnyone = fs.statSync(b.lockFile);
    const freeBefore = probeFree(b);

    const holder = launch(b, 'holder', 400);
    // Sampled from the very first instant, so the samples cover the window in which a `mkdir`-based
    // lock would have existed with no owner written into it yet.
    const samples: Array<{ before: string[]; free: boolean; after: string[] }> = [];
    while (sectionLog(b).length < 2 && samples.length <= 400) {
      const before = sectionLog(b);
      const free = probeFree(b);
      const after = sectionLog(b);
      samples.push({ before, free, after });
    }
    const codes = await settle([holder]);
    const duringHold = fs.statSync(b.lockFile);
    const contents = fs.readFileSync(b.lockFile);
    const freeAfterwards = probeFree(b);
    removeOwned(b.dir);

    expect(codes, 'the holder did not complete').toEqual([0]);
    // The name exists identically before, during and after, so observing the name tells a waiter
    // nothing — and there is no partially-initialised state for it to misread.
    expect(freeBefore, 'the lock was not free before anybody took it').toBe(true);
    expect(contents.length, 'the lock carries metadata a waiter could race').toBe(0);
    expect(duringHold.ino, 'the lock file was replaced during the hold').toBe(beforeAnyone.ino);
    // Judge only probes whose before-and-after snapshots BOTH place the holder inside. A
    // synchronous probe can begin before `EXIT` is appended and finish after the process releases
    // the lock; treating that boundary-straddling result as an in-section sample would be an
    // observation race in this test. A broken lock still returns free while both snapshots contain
    // only `ENTER holder`, so this remains a load-bearing exclusion check.
    const fullyBracketed = samples.filter(
      ({ before, after }) =>
        before.length === 1 &&
        before[0] === 'ENTER holder' &&
        after.length === 1 &&
        after[0] === 'ENTER holder',
    );
    expect(fullyBracketed.length, 'no probe was fully bracketed inside the hold').toBeGreaterThan(
      0,
    );
    expect(
      fullyBracketed.every(({ free }) => !free),
      'the lock was observed free while a holder was inside',
    ).toBe(true);
    expect(freeAfterwards, 'the lock was not released when the holder exited').toBe(true);
  });

  itPosix(
    'a waiter that gives up removes nothing, replaces nothing, and disturbs no holder',
    async () => {
      // Under the old protocol a waiter that judged a lock stale RENAMED it away, and that is the
      // move that let a waiter walk in beside a live holder. A waiter here has no move available: it
      // blocks in the kernel and then reports that it could not get in.
      const b = bench();
      const holder = launch(b, 'holder', 400);
      while (sectionLog(b).length === 0) {
        await sleep(5);
      }
      const before = fs.statSync(b.lockFile);

      const waiter = lockedRun({
        lockFile: b.lockFile,
        waitSeconds: 0,
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
        tool: b.tool,
      });

      const after = fs.statSync(b.lockFile);
      const beside = fs.readdirSync(b.dir).sort();
      const codes = await settle([holder]);
      const log = sectionLog(b);
      removeOwned(b.dir);

      expect(waiter.conflict, 'the waiter was let in beside a live holder').toBe(true);
      expect(waiter.status, 'a conflict was not reported as a conflict').toBe(LOCK_CONFLICT_EXIT);
      expect(after.ino, "the waiter replaced the holder's lock").toBe(before.ino);
      expect(after.ctimeMs, "the waiter moved the holder's lock").toBe(before.ctimeMs);
      expect(beside, 'the refused waiter left something behind').toEqual(FIXTURE_ENTRIES);
      expect(codes, 'the holder did not finish undisturbed').toEqual([0]);
      expect(log, 'the holder was interrupted').toEqual(['ENTER holder', 'EXIT holder']);
    },
  );

  itPosix(
    'a waiter blocks until the holder is done and then gets in — it never forfeits on age',
    async () => {
      // THE CONTROL. Every refusal above would also be produced by a lock nobody can ever take, which
      // would wedge the suite on the first build instead of serialising it. It is also the property
      // the old 120-second forfeit destroyed: waiting is unbounded on the holder's WORK, not on a
      // deadline shorter than the build the lock guards.
      const b = bench();
      const first = launch(b, 'first', 200);
      while (sectionLog(b).length === 0) {
        await sleep(5);
      }
      const second = launch(b, 'second', 10, 30);
      const codes = await settle([first, second]);
      const log = sectionLog(b);
      removeOwned(b.dir);

      expect(codes, 'a builder failed').toEqual([0, 0]);
      expect(log, 'the waiter did not enter strictly after the holder left').toEqual([
        'ENTER first',
        'EXIT first',
        'ENTER second',
        'EXIT second',
      ]);
    },
  );

  // -----------------------------------------------------------------------------------------
  // THE LOCK'S LIFETIME IS THE WORK'S LIFETIME — no local ceiling may end one without the other.
  // -----------------------------------------------------------------------------------------

  itPosix(
    'a slow section is never abandoned: the work outlives no call, and nothing overlaps it',
    async () => {
      // THE PROPERTY B1 IS ABOUT. `lockedRun` must not return while the command it started is still
      // running, because the lock it was holding is gone the moment it does — and the next builder
      // walks straight in beside a live one. A build that is simply SLOW is all it takes; there is no
      // crash and no adversary anywhere in this scenario.
      const b = bench();
      const worker = signingWorker(b);
      const pidFile = path.join(b.dir, 'slow.pid');
      // A real second builder, launched first so it is genuinely contending rather than following.
      const other = launch(b, 'other', 20, 30);

      const started = Date.now();
      const run = lockedRun({
        lockFile: b.lockFile,
        waitSeconds: 30,
        command: process.execPath,
        args: [worker, b.log, 'slow', String(SLOW_MS), pidFile],
        tool: b.tool,
      });
      const elapsed = Date.now() - started;
      // Sampled the instant the call returns: that is when the lock it held is gone, and therefore
      // the instant at which anything still running would be running unlocked.
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      const survived = alive(pid);
      // The contender may still be waiting its turn, so it is settled BEFORE the lock is probed —
      // otherwise the probe would be racing a legitimate holder rather than observing a release.
      const codes = await settle([other]);
      const freeAfterwards = probeFree(b);
      const marks = boundaries(sectionLog(b));
      removeOwned(b.dir);

      expect(run.conflict, 'the slow section was refused the lock').toBe(false);
      expect(run.status, 'the slow section did not run to completion').toBe(0);
      expect(codes, 'the contending builder failed').toEqual([0]);
      // The call lasted at least as long as the work: it was not cut short by anything local.
      expect(
        elapsed >= SLOW_MS,
        `lockedRun returned after ${elapsed}ms, before ${SLOW_MS}ms of work was done`,
      ).toBe(true);
      expect(survived, 'the command was STILL RUNNING after lockedRun returned').toBe(false);
      expect(marks.includes('EXIT slow'), 'the slow section never finished').toBe(true);
      // …and no second acquisition ever stood beside it. Strict alternation, boundaries only.
      for (let i = 0; i < marks.length; i += 2) {
        expect(marks[i]?.startsWith('ENTER'), `overlap at ${String(marks[i])}`).toBe(true);
        expect(marks[i + 1]?.startsWith('EXIT'), `overlap at ${String(marks[i + 1])}`).toBe(true);
      }
      expect(freeAfterwards, 'the lock was still held once everything had finished').toBe(true);
    },
  );

  itPosix('a ceiling on the lock TOOL lets work outlive the call — so there is none', async () => {
    // THE DEFECT, PERFORMED, because the argument for removing the ceiling is only as good as the
    // demonstration that a ceiling is not a weaker bound but the two-builders failure itself.
    //
    // `spawnSync`'s `timeout` signals the process IT started. Here that is the lock TOOL — merely
    // the parent of the work. With lockf, killing that parent releases the lock at once and leaves
    // the command running unlocked. With util-linux flock, the child inherits the locked open file
    // description, so the orphan keeps the lock until it exits. Either way the call has returned
    // while work it started is still running, which is not a valid synchronous build boundary.
    const b = bench();
    const worker = signingWorker(b);
    const pidFile = path.join(b.dir, 'orphan.pid');

    const timed = spawnSync(
      b.tool.path,
      lockToolArgv(b.tool, b.lockFile, 30, process.execPath, [
        worker,
        b.log,
        'orphan',
        String(SLOW_MS * 3),
        pidFile,
      ]),
      { encoding: 'utf8', timeout: WOULD_BE_CEILING_MS },
    );
    const orphanPid = Number(fs.readFileSync(pidFile, 'utf8'));
    const workSurvived = alive(orphanPid);
    const linesAtReturn = sectionLog(b).length;
    // The very next acquisition, zero wait, on the SAME inode. lockf has released it; flock's child
    // inherited it. The distinction is asserted below instead of universalising one tool's
    // process/descriptor semantics.
    const freeWhileChildAlive = probeFree(b);
    const reaped = await reap(orphanPid);
    const freeAfterChildExit = probeFree(b);
    const grewAfterwards = sectionLog(b).length > linesAtReturn;

    // And the harness itself must contain no such ceiling. This is the guard: a `timeout` on the
    // lock tool is the thing that must not exist, so its absence is what is asserted.
    const src = fs.readFileSync(path.join(repoRoot, 'tests', 'helpers', 'build-cli.ts'), 'utf8');
    const spawnCall = /spawnSync\(tool\.path, argv, \{([\s\S]*?)\}\)/.exec(src);
    removeOwned(b.dir);

    expect(
      (timed.error as NodeJS.ErrnoException | undefined)?.code,
      'the probe did not actually hit its ceiling',
    ).toBe('ETIMEDOUT');
    expect(
      workSurvived,
      'the probe never demonstrated the orphan — the proof would be vacuous',
    ).toBe(true);
    expect(grewAfterwards, 'the orphaned command did no further work, so nothing was at risk').toBe(
      true,
    );
    expect(
      freeWhileChildAlive,
      b.tool.kind === 'lockf'
        ? 'lockf did not release the lock with its killed wrapper'
        : 'flock released a descriptor the live child inherited',
    ).toBe(b.tool.kind === 'lockf');
    expect(reaped, 'the probe left a process running after the test').toBe(true);
    expect(freeAfterChildExit, 'the inherited lock survived the command that held it').toBe(true);

    expect(
      spawnCall,
      'the lock tool is no longer launched by spawnSync(tool.path, argv, {…})',
    ).not.toBeNull();
    expect(
      spawnCall?.[1] ?? '',
      'a ceiling was reimposed on the lock tool — it would release the lock and orphan the build',
    ).not.toContain('timeout');
    expect(src, 'the harness carries a lock-tool timeout knob again').not.toContain('timeoutMs');
    // Acquisition is still bounded — by the tool, which starts no work when it gives up — and the
    // WORK is bounded inside the critical section, by the lock holder, where a ceiling can end the
    // process that is actually doing it.
    expect(
      src,
      'the bundler lost its own timeout, which is the bound that replaced this one',
    ).toMatch(/execFileSync\([\s\S]{0,400}?timeout: 180_000/);
  });

  itPosix(
    'the lock rides the INODE, and an outside rename is real rather than argued away',
    async () => {
      // THE HONEST SCOPE. It would be easy to write "no process can rename or replace this path" and
      // easier still to believe it. It is not true: a same-uid process can rename any writable name,
      // and this one is writable on purpose. What follows is that fact, demonstrated — and then the
      // guarantee that survives it.
      const b = bench();
      const holder = launch(b, 'holder', 400);
      while (sectionLog(b).length === 0) {
        await sleep(5);
      }
      const held = fs.statSync(b.lockFile);

      // An OUTSIDE move: nothing in this harness makes it, and nothing here could stop it.
      const moved = path.join(b.dir, 'moved-away.lock');
      fs.renameSync(b.lockFile, moved);

      // The holder is undisturbed, because the lock is on the INODE and not on the name.
      const stillExcludedAtNewName = !probeFree({ ...b, lockFile: moved });
      // But a file created at the ORIGINAL name is a second inode, and a second inode is a second
      // lock: two builders, one on each. That is the whole cost of the rename, stated plainly.
      ensureLockFile(b.lockFile);
      const freshNameIsUnguarded = probeFree(b);
      const differentInode = fs.statSync(b.lockFile).ino !== held.ino;

      fs.rmSync(b.lockFile);
      fs.renameSync(moved, b.lockFile);
      const codes = await settle([holder]);
      const log = sectionLog(b);
      removeOwned(b.dir);

      expect(
        stillExcludedAtNewName,
        'renaming the path released the holder — the lock is on a NAME',
      ).toBe(true);
      expect(differentInode, 'the fixture did not actually create a second inode').toBe(true);
      expect(
        freshNameIsUnguarded,
        'a brand new inode at the old name excluded somebody, which cannot be true',
      ).toBe(true);
      expect(codes, 'the holder did not finish undisturbed').toEqual([0]);
      expect(log, 'the holder was interrupted by a rename underneath it').toEqual([
        'ENTER holder',
        'EXIT holder',
      ]);
      // WHAT IS ENFORCED, then, is narrower and is proved by the tests above and below this one: no
      // waiter in this harness unlinks, reclaims, renames or replaces the lock; the path is outside
      // `node_modules`, so package-manager churn cannot split it; and the kernel releases it the
      // instant a holder dies. A same-uid process that ignores all of that can also write
      // `packages/cli/dist` itself, so no arrangement here could have made it a boundary.
    },
  );

  it('the lock file is repo-private, stable, git-ignored, and OUTSIDE node_modules', () => {
    // The old lock lived at `node_modules/.cache/sthayi-test-build.lock`, and that alone splits it:
    // `node_modules` is package-manager state, so a `pnpm install`, a prune or an `rm -rf` removes
    // it mid-run and every invocation arriving afterwards locks a DIFFERENT file. Two runs then
    // hold two different locks and both build.
    const layout = buildLayout();
    const rel = path.relative(repoRoot, BUILD_LOCK_FILE);

    expect(layout.lockFile, 'the layout does not use the repo-private lock file').toBe(
      BUILD_LOCK_FILE,
    );
    expect(
      rel.split(path.sep),
      'the lock lives inside a directory a package manager owns',
    ).not.toContain('node_modules');
    expect(rel, 'the lock is not directly in the repository root').toBe('.sthayi-build.lock');
    expect(
      fs.readFileSync(path.join(repoRoot, '.gitignore'), 'utf8'),
      'the build lock file is not git-ignored',
    ).toContain('.sthayi-build.lock');
    // It is never unlinked. `lockf` removes its lock file on release unless told otherwise, and a
    // removed lock file is a new inode for the next run — the same split by another route.
    expect(
      lockToolArgv({ kind: 'lockf', path: '/usr/bin/lockf' }, '/x/y.lock', 5, 'cmd', []),
      'lockf is not told to KEEP the lock file',
    ).toEqual(['-k', '-t', '5', '/x/y.lock', 'cmd']);
  });

  it('both tools report a conflict with the same distinct status, and the section never does', () => {
    // `lockf` reports EX_TEMPFAIL and cannot be told otherwise; `flock` defaults to 1, which is
    // indistinguishable from an ordinary crash of the command it was asked to run, so it is given
    // `-E` to agree. Without that, "nobody would give me the lock" and "the build blew up" arrive
    // as the same number and the harness reports the wrong one.
    expect(
      lockToolArgv({ kind: 'flock', path: '/usr/bin/flock' }, '/x/y.lock', 9, 'cmd', ['a']),
      'flock is not pinned to the shared conflict exit code',
    ).toEqual(['-w', '9', '-E', String(LOCK_CONFLICT_EXIT), '/x/y.lock', 'cmd', 'a']);
    expect(
      LOCK_CONFLICT_EXIT,
      'the conflict code moved off EX_TEMPFAIL, which lockf hardcodes',
    ).toBe(75);
    expect(BUILD_FAILED_EXIT, 'a failed build is indistinguishable from a lock conflict').not.toBe(
      LOCK_CONFLICT_EXIT,
    );
  });

  it('a machine with no kernel lock tool FAILS CLOSED rather than building unserialised', () => {
    // Detection is by TOOL PRESENCE, not by `uname`: presence is the property that decides whether
    // the section can be serialised at all. There is no pure-Node substitute to fall back to — node
    // exposes no `flock(2)`, and every `open(…, 'wx')` / `mkdir` / PID-file stand-in IS the pathname
    // protocol this design exists to replace — so the honest answer is a refusal.
    expect(findKernelLockTool([]), 'a tool was invented out of nothing').toBeUndefined();
    expect(
      () => requireKernelLockTool([]),
      'an unserialisable machine was allowed to build',
    ).toThrow(/no kernel advisory lock tool is available/);
    expect(noLockToolMessage(), 'the refusal does not name the tool a Linux machine needs').toMatch(
      /flock/,
    );
    expect(noLockToolMessage(), 'the refusal does not name the tool a macOS machine needs').toMatch(
      /lockf/,
    );
    expect(
      findKernelLockTool([{ kind: 'flock', path: path.join(repoRoot, 'no-such-tool') }]),
      'a path that is not there was accepted as a lock tool',
    ).toBeUndefined();
    // ...and the ACTUAL host answers honestly. Windows has no POSIX lock tool, while the POSIX
    // legs must carry one or every real-process proof above would be vacuous.
    if (process.platform === 'win32') {
      expect(
        findKernelLockTool(),
        'Windows unexpectedly acquired a POSIX lock-tool path',
      ).toBeUndefined();
      expect(
        () => requireKernelLockTool(),
        'Windows silently invented an unserialised build fallback',
      ).toThrow(/no kernel advisory lock tool is available/);
    } else {
      expect(findKernelLockTool()?.kind, 'this POSIX machine has no kernel lock tool').toMatch(
        /^(?:flock|lockf)$/,
      );
    }
  });

  it('the pathname lock protocol is GONE, not merely unused', () => {
    // A dead `acquire`/`reclaim`/`retire` left in the file is a defect waiting to be called again,
    // and it would also let a reader believe the old policy still governs something. The replacement
    // is only complete once the vocabulary of the old protocol has no executable code left.
    const src = fs.readFileSync(path.join(repoRoot, 'tests', 'helpers', 'build-cli.ts'), 'utf8');
    const code = src
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => !(line.startsWith('*') || line.startsWith('//') || line.startsWith('/*')))
      .join('\n');
    for (const gone of ['owner.json', 'mayReclaim', 'mayRemove', 'acquireBuildLock', 'livePid']) {
      expect(code, `the old lock protocol still has executable code for ${gone}`).not.toContain(
        gone,
      );
    }
    // And nothing in the harness ever destroys the lock file. That is what keeps the inode stable
    // across every invocation, which is the whole reason two runs cannot end up on two locks.
    expect(code, 'the harness unlinks the lock file').not.toMatch(/unlinkSync\([^)]*lockFile/);
    expect(code, 'the harness renames the lock file').not.toMatch(/renameSync\([^)]*lockFile/);
  });
});
