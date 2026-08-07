import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { removeOwned } from '../helpers/owned-fs.js';
import {
  PeerFixtures,
  type PeerOperation,
  peerFs,
  runPeerOperations,
} from '../helpers/peer-fixtures.js';
import { runTempDir } from '../helpers/run-temp.js';

/**
 * SAFETY: the decoys a hostile fixture plants are cleared on RECORDED IDENTITIES, and a recursive
 * removal aimed at a pathname is never one of the steps.
 *
 * WHY THIS IS NOT A DETAIL. A hostile fixture proves that teardown refuses to remove an entry this
 * run did not create. To prove it, the entry must be created by a program the harness cannot
 * witness — and it must then be taken away again, or the fixture around it is abandoned holding
 * whatever the test put in it. Reaching for `rm -rf` at that point performs, in the cleanup of the
 * test, the exact operation the test exists to forbid: a whole recursion decided inside one call
 * from a pathname, long after the last thing anyone checked. The decoy stands at a name in a shared
 * temp root, and a directory swapped in at that name between the plant and the clear would be taken
 * with everything inside it.
 *
 * SO THE CLEAR IS BOUNDED BY WHAT WAS RECORDED. Every entry is censused the instant the planting
 * program returns, carrying the device/inode it had then, and it is removed only while the name
 * still answers to that identity and that kind — one `unlink` for a non-directory, one
 * non-recursive `rmdir` for a directory the census emptied. Entries the RUN itself wrote into a
 * decoy afterwards go on the run's own records, through the same identity-proving walk teardown
 * uses. Anything neither record covers stays, and the directory above it stays with it.
 */
describe('safety: planted decoys are cleared by identity, never by pathname', () => {
  const props: string[] = [];
  const litter = new PeerFixtures();

  afterEach(() => {
    litter.clear();
    for (const p of props.splice(0).reverse()) {
      removeOwned(p);
    }
  });

  function runPeer(operations: readonly PeerOperation[]): void {
    const r = runPeerOperations(operations);
    expect(r.status, r.stderr).toBe(0);
  }

  /** A decoy tree, planted by a program nothing in this process witnesses. */
  function plant(peer: PeerFixtures, at: string): void {
    const r = peer.run(
      [
        peerFs.mkdir(path.join(at, 'nested'), { recursive: true }),
        peerFs.write(path.join(at, 'nested', 'canary'), 'DECOY'),
        peerFs.write(path.join(at, 'top'), 'DECOY-TOP'),
      ],
      [at],
    );
    expect(r.status, r.stderr).toBe(0);
  }

  it('a decoy the census recorded is taken away entirely', () => {
    const fixture = runTempDir('sthayi-decoy-control-');
    props.push(fixture);
    const at = path.join(fixture, 'decoy');
    const peer = new PeerFixtures();
    plant(peer, at);

    peer.clear();

    expect(fs.existsSync(at)).toBe(false);
    expect(fs.existsSync(fixture)).toBe(true);
  });

  it('a THIRD PARTY replacement at a planted name survives, and keeps its tree', () => {
    const fixture = runTempDir('sthayi-decoy-replaced-');
    props.push(fixture);
    const at = path.join(fixture, 'decoy');
    const peer = new PeerFixtures();
    plant(peer, at);

    // Somebody else destroys the decoy and stands their own tree at the name — the same shape the
    // harness itself is built to survive, here aimed at the cleanup rather than at teardown. Taken
    // apart one entry at a time even here: a recursive removal aimed at a pathname is the hazard,
    // and a test that used one to set up a scenario about it would be arguing against itself.
    runPeer([
      peerFs.unlink(path.join(at, 'nested', 'canary'), true),
      peerFs.unlink(path.join(at, 'top'), true),
      peerFs.rmdir(path.join(at, 'nested')),
      peerFs.rmdir(at),
      peerFs.mkdir(path.join(at, 'nested'), { recursive: true }),
      peerFs.write(path.join(at, 'nested', 'canary'), 'STRANGER'),
      peerFs.write(path.join(at, 'top'), 'STRANGER-TOP'),
    ]);
    litter.adopt(at);

    peer.clear();

    expect(fs.readFileSync(path.join(at, 'nested', 'canary'), 'utf8')).toBe('STRANGER');
    expect(fs.readFileSync(path.join(at, 'top'), 'utf8')).toBe('STRANGER-TOP');
  });

  it('one replaced ENTRY inside a decoy keeps itself and the directory holding it', () => {
    const fixture = runTempDir('sthayi-decoy-entry-');
    props.push(fixture);
    const at = path.join(fixture, 'decoy');
    const peer = new PeerFixtures();
    plant(peer, at);

    const canary = path.join(at, 'nested', 'canary');
    runPeer([peerFs.unlink(canary, true), peerFs.write(canary, 'STRANGER')]);
    litter.adopt(at);

    peer.clear();

    // The one entry the census can no longer account for survives, and so does everything the
    // failed `rmdir` chain above it could not empty.
    expect(fs.readFileSync(canary, 'utf8')).toBe('STRANGER');
    expect(fs.existsSync(path.join(at, 'top'))).toBe(false); // still the recorded object: removed
  });

  it("what the RUN writes into a decoy afterwards goes on the run's own records", () => {
    const fixture = runTempDir('sthayi-decoy-filled-');
    props.push(fixture);
    const at = path.join(fixture, 'decoy');
    const peer = new PeerFixtures();
    const r = peer.run([peerFs.mkdir(at, { mode: 0o700 })], [at]);
    expect(r.status, r.stderr).toBe(0);

    // The peer won the name; the code under test then writes into it, which is the whole point of
    // the scenarios this cleanup serves. Those entries are the run's and are removable.
    fs.writeFileSync(path.join(at, 'ours'), 'OURS', { mode: 0o600 });
    fs.mkdirSync(path.join(at, 'sub'), { mode: 0o700 });
    fs.writeFileSync(path.join(at, 'sub', 'ours'), 'OURS', { mode: 0o600 });

    peer.clear();

    expect(fs.existsSync(at)).toBe(false);
    expect(fs.existsSync(fixture)).toBe(true);
  });

  it('no helper hands a pathname to a recursive removal primitive', () => {
    // The same rule the rest of the harness is held to, restated where the decoy cleanup lives: a
    // shell recursion is as unbounded as a JavaScript one, so neither appears.
    const helperDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'helpers');
    for (const helper of ['peer-fixtures.ts', 'peer-fs-child.mjs']) {
      const source = fs.readFileSync(path.join(helperDir, helper), 'utf8');
      for (const line of source.split('\n')) {
        const code = line.trim();
        if (code.startsWith('*') || code.startsWith('//') || code.startsWith('/*')) {
          continue; // prose describing the hazard is not the hazard
        }
        expect(code).not.toMatch(/\brm\s+-[a-zA-Z]*r/);
        expect(code).not.toMatch(/\brmSync\b/);
        expect(code).not.toMatch(/recursive:\s*true/);
      }
    }
  });
});
