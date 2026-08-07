/**
 * THE CRITICAL SECTION, AS A PROCESS.
 *
 * Launched by `ensureBuiltCli()` as `flock/lockf <lockfile> node this-file`, so the kernel advisory
 * lock is held for exactly this process's lifetime — across the currency re-check, the bundler run
 * and the atomic publication of the build marker — and is released by the kernel the instant this
 * process ends, however it ends.
 *
 * IT IS A SEPARATE PROCESS ON PURPOSE. Node's core exposes no `flock(2)`, so the only way to hold a
 * kernel lock across JavaScript would be a helper process holding it on the builder's behalf — and
 * that helper dying (OOM, a stray `pkill`) would silently release the lock while the build carried
 * on, which is the failure the lock exists to prevent. Making the builder itself the lock holder
 * removes that possibility: the lock cannot outlive the work and the work cannot outlive the lock.
 *
 * `.mjs`, and a shim rather than an implementation: the logic lives in `build-cli.ts` beside the
 * digest it has to agree with, and node 22 strips the types on import.
 */
import { BUILD_FAILED_EXIT, runBuildCriticalSection } from './build-cli.ts';

try {
  process.stdout.write(`${runBuildCriticalSection()}\n`);
} catch (err) {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  // A DISTINCT code, never the lock tool's conflict code (75): the parent has to be able to tell
  // "nobody would give me the lock" apart from "I held the lock and the build failed".
  process.exit(BUILD_FAILED_EXIT);
}
