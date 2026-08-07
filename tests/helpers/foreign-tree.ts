import fs from 'node:fs';
import path from 'node:path';
import { ownedByThisUid } from './owned-fs.js';

/**
 * Remove a scratch tree whose CONTENTS this process did not create — without ever handing a
 * pathname to a recursive removal primitive.
 *
 * WHY THIS EXISTS AT ALL. `removeOwned()` is the right answer everywhere the run made the files
 * itself: it descends only through directories recorded at creation, and refuses anything else. A
 * few harnesses drive a real child program — a release step's `bash`, a packing shell — into a
 * scratch root, and the entries that appear inside are made by a process this one cannot witness.
 * `removeOwned` correctly refuses them, which would leave the whole tree standing. The alternative
 * that was in use is `fs.rmSync(root, { recursive: true, force: true })`, and that is the one thing
 * the harness does not do: a recursive removal decides its ENTIRE walk inside the call, from a
 * name, long after the caller's last check — one directory swapped in at that name turns a tidy-up
 * into the loss of whatever it pointed at.
 *
 * SO THE WALK IS DONE HERE, ONE ENTRY AT A TIME, AND EVERY STEP IS RE-DECIDED:
 *   - `lstat`, never `stat`, and a symlink is UNLINKED rather than followed. That is what keeps a
 *     link planted inside the tree from redirecting the walk out of it.
 *   - the device is pinned to the root's. A mount that appears underneath is left alone.
 *   - every directory must belong to this uid before it is entered.
 *   - the depth is bounded, so a pathological tree fails instead of exhausting the stack.
 *   - failure LEAKS. Anything that cannot be removed on these terms is left exactly where it is,
 *     and the directories above it are left too. A stray tree costs disk; a walk into something
 *     nobody put there costs whatever was in it.
 *
 * It is not a substitute for `removeOwned` and must not be used where that applies: this proves
 * containment and ownership of the DIRECTORIES it walks, but it cannot prove who created any single
 * file inside them, because in these harnesses nothing in this process ever saw them made.
 */

/** Deep enough for any scratch tree here, shallow enough that a runaway fails instead of recursing. */
export const MAX_FOREIGN_DEPTH = 32;

function emptied(dir: string, device: number, depth: number): boolean {
  if (depth >= MAX_FOREIGN_DEPTH) {
    return false;
  }
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return false;
  }
  let complete = true;
  for (const entry of entries) {
    const target = path.join(dir, entry);
    const st = fs.lstatSync(target, { throwIfNoEntry: false });
    if (st === undefined) {
      continue; // already gone
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      // ONE ENTRY, AND THE LINK ITSELF. `unlinkSync` removes the name without resolving it, so a
      // link pointing anywhere at all costs exactly that name.
      try {
        fs.unlinkSync(target);
      } catch {
        complete = false;
      }
      continue;
    }
    if (st.dev !== device || !ownedByThisUid(st)) {
      complete = false; // a mount, or somebody else's directory: left standing
      continue;
    }
    if (!emptied(target, device, depth + 1)) {
      complete = false;
      continue;
    }
    try {
      fs.rmdirSync(target); // refuses rather than descends if anything reappeared inside
    } catch {
      complete = false;
    }
  }
  return complete;
}

export function removeForeignTree(root: string): void {
  const st = fs.lstatSync(root, { throwIfNoEntry: false });
  if (st === undefined) {
    return;
  }
  // A symlink standing where a scratch root is expected is a SUBSTITUTION, not a root. It is left
  // alone — unlinking it would be harmless, but refusing keeps the evidence of the substitution.
  if (st.isSymbolicLink() || !st.isDirectory() || !ownedByThisUid(st)) {
    return;
  }
  if (!emptied(root, st.dev, 0)) {
    return; // something inside could not be removed on these terms; the root stays too
  }
  try {
    fs.rmdirSync(root);
  } catch {
    // leaked rather than escalated
  }
}
