import fs from 'node:fs';
import {
  type Identity,
  entryReceipt,
  recordedChildIdentity,
  syncDirLedger,
  wasCreatedThisRun,
} from './owned-fs.js';

/**
 * Ask a PROCESS THAT WITNESSED NOTHING what a run root's creation ledger still authorises.
 *
 * WHY THE QUESTION HAS TO BE ASKED FROM OUT HERE. A record's whole job is to be believed by a
 * process that saw none of the calls that wrote it: fixtures are created in vitest workers and in
 * the children those workers spawn, and the sweep runs somewhere else entirely. So "the authority
 * for a destroyed directory is gone" is a claim about the LEDGER, not about one process's maps, and
 * a suite that checks its own memory cannot tell a retirement that persisted from one that never
 * left the process that performed it.
 *
 * It is also the only way to ask without contaminating the asker. Replaying a foreign root's ledger
 * into the worker running the tests would pour that root's inode numbers into the worker's own
 * authority maps — numbers the kernel is free to hand to the next directory anything in that worker
 * creates. The question is therefore asked in a process that is thrown away with the answer.
 *
 * Every map starts empty here. The only input is the ledger inside the root named on the command
 * line, replayed through the same `syncDirLedger()` the sweep itself uses, and the answers are the
 * three the records exist to give: does an INODE still carry creation authority, does a NAME under a
 * parent still resolve to a recorded directory, and is a RECEIPT for one entry of one directory
 * still held.
 *
 * Usage: `fresh-ledger-replay.ts <runRoot> <queryFile>`, answers as JSON on stdout.
 * Exit codes: 0 answered, 2 was given nothing to work with, 9 is the wrong node.
 */

/**
 * What a caller wants to know, in the keying every record here uses: identities, never pathnames.
 * The identity's `birthtimeNs` string is only this test run's ABA discriminator; it is not exposed
 * as, or relied on as, a portable filesystem generation.
 */
export interface ReplayQuery {
  /** Inodes to ask creation authority for. */
  readonly inodes?: readonly Identity[];
  /** `[parent, name]` pairs to ask the directory record for. */
  readonly children?: readonly (readonly [Identity, string])[];
  /** `[parent, name]` pairs to ask the entry receipt for. */
  readonly receipts?: readonly (readonly [Identity, string])[];
}

export interface ReplayAnswer {
  readonly inodes: readonly boolean[];
  readonly children: readonly (Identity | null)[];
  readonly receipts: readonly ({
    dev: string;
    ino: string;
    birthtimeNs: string;
    link: boolean;
  } | null)[];
}

function main(): number {
  const expected = process.env.STHAYI_EXPECT_NODE;
  if (expected !== undefined && expected !== process.versions.node) {
    process.stderr.write(`replay node ${process.versions.node} expected ${expected}\n`);
    return 9;
  }
  const root = process.argv[2];
  const queryFile = process.argv[3];
  if (root === undefined || queryFile === undefined) {
    return 2;
  }
  const query = JSON.parse(fs.readFileSync(queryFile, 'utf8')) as ReplayQuery;
  syncDirLedger(root);
  const answer: ReplayAnswer = {
    inodes: (query.inodes ?? []).map((id) => wasCreatedThisRun(id)),
    children: (query.children ?? []).map(([parent, name]) => {
      const found = recordedChildIdentity(parent, name);
      return found === undefined
        ? null
        : { dev: found.dev, ino: found.ino, birthtimeNs: found.birthtimeNs };
    }),
    receipts: (query.receipts ?? []).map(([parent, name]) => {
      const held = entryReceipt(parent, name);
      return held === undefined
        ? null
        : {
            dev: held.dev,
            ino: held.ino,
            birthtimeNs: held.birthtimeNs,
            link: held.link,
          };
    }),
  };
  process.stdout.write(JSON.stringify(answer));
  return 0;
}

process.exit(main());
