import fs from 'node:fs';
import {
  RUN_IDENTITY_ENV,
  RUN_ROOT_ENV,
  decodeIdentity,
  removeOwned,
  trackOwned,
} from './owned-fs.js';

/**
 * Tear down a run root from a process that WITNESSED NONE OF IT.
 *
 * Every in-memory map in `owned-fs.ts` starts empty here: this process created no fixture, saw no
 * `mkdir`, and holds no receipt. The only things it is given are the two facts a run publishes —
 * the root's path and the device/inode bound immediately after the exclusive `mkdir` that made it —
 * plus the creation ledger sitting inside the root. So whatever this program manages to remove, it
 * removed on PERSISTED EVIDENCE alone.
 *
 * That is the shape production actually runs in, and the reason it has to be exercised as a separate
 * process rather than simulated inside one: fixtures are created in vitest WORKER processes and the
 * run root is swept in the parent, which never saw a single creating call. A ledger that only
 * appears to work because the process reading it is the process that wrote it would leak every
 * fixture the moment the two are really different — and a suite driving setup, creation and teardown
 * in one process cannot tell the two apart.
 *
 * The identity is taken from the ENVIRONMENT, never from the directory: reading it back out of the
 * root would let a replacement vouch for itself. A mismatch makes `trackOwned` refuse, and refusing
 * leaves the tree exactly where it is.
 *
 * THE RUNTIME IS ASSERTED, NOT ASSUMED. A sweep run on a different node has different `fs`
 * internals, a different `readdir` order and a different `openSync`, and a sweeper that silently did
 * nothing there would be indistinguishable from a sweeper that worked. The caller states which
 * runtime it believes it launched and this refuses to sweep on any other, so the evidence names a
 * version instead of inheriting whatever a shell shim found on PATH.
 *
 * Exit codes: 0 removed the root, 3 left it standing, 2 was given nothing to work with, 9 is the
 * wrong node.
 */
function main(): number {
  const expected = process.env.STHAYI_EXPECT_NODE;
  if (expected !== undefined && expected !== process.versions.node) {
    process.stderr.write(`sweeper node ${process.versions.node} expected ${expected}\n`);
    return 9;
  }
  const root = process.env[RUN_ROOT_ENV];
  const identity = decodeIdentity(process.env[RUN_IDENTITY_ENV]);
  if (root === undefined || root === '' || identity === null) {
    return 2;
  }
  try {
    // The published identity is the CARRIED one — bound when the root was created, in another
    // process, and never re-derived from whatever occupies the path now.
    trackOwned(root, identity);
  } catch {
    return 3; // not the directory that was published: nothing here is ours to remove
  }
  removeOwned(root);
  return fs.existsSync(root) ? 3 : 0;
}

process.exit(main());
