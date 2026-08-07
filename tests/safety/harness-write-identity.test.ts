import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeHome } from '../helpers/fake-home.js';
import {
  type Identity,
  entryReceipt,
  identityFromBigStat,
  removeOwned,
  trackOwned,
} from '../helpers/owned-fs.js';
import {
  PeerFixtures,
  type PeerOperation,
  peerFs,
  runPeerOperations,
} from '../helpers/peer-fixtures.js';
import { runTempDir } from '../helpers/run-temp.js';

/**
 * SAFETY: a receipt names THE OBJECT A SYSCALL CHANGED, never whatever answers to the name
 * afterwards — and nothing beneath a tracked directory is removable without one.
 *
 * THE WINDOW. A write returns, and something then has to say which object received it. Resolving
 * the pathname a second time answers a different question: it says what is standing at that name
 * NOW. Between the two, a process sharing this uid and this temp root can unlink what the run made
 * and put its own file, with its own inode and its own bytes, at the name. A receipt taken from the
 * second answer names the peer's file — and a receipt is exactly what authorises removing an entry,
 * so the run then destroys data it never wrote a byte of. The window cannot be closed in portable
 * Node; what can be done is to stop asking the question. `fstat` on the descriptor the write went
 * through refers to that object for as long as the handle is open, whatever happens to the name.
 *
 * THE PATH. "Beneath a tracked directory" is a claim about the filesystem, and a string prefix is a
 * claim about text. `anchor/link/x` wears the prefix whether `link` is a directory this run made or
 * a symlink into somebody else's tree, and an `unlink` decided on the prefix removes an entry that
 * was never inside the anchor at all. Every component is therefore proved, and the final entry
 * still has to answer for itself with a receipt of its own.
 *
 * THE VACATED NAME. A tracked name that no longer resolves to the directory recorded there is a
 * name the run has LOST, not a name it may clear. Whatever stands there — a directory, a link, or a
 * file with a stranger's bytes — is not covered by the record that authorised the directory.
 *
 * WHAT MUST HOLD IN ALL THREE: the peer's object keeps every byte, the run's own entries are still
 * removed to the last one, and the fixture LEAKS around whatever is left.
 */
describe('safety: a receipt names the object that was written, not the name that was used', () => {
  const props: string[] = [];
  const peer = new PeerFixtures();

  afterEach(() => {
    peer.clear();
    for (const p of props.splice(0).reverse()) {
      removeOwned(p);
    }
  });

  function runPeer(operations: readonly PeerOperation[]): void {
    const r = runPeerOperations(operations);
    expect(r.status, r.stderr).toBe(0);
  }

  function idOf(p: string): Identity {
    const id = identityFromBigStat(fs.lstatSync(p, { bigint: true }));
    if (id === null) throw new Error(`no test identity for ${p}`);
    return id;
  }

  /**
   * Replace `target` with a NEW INODE holding a stranger's bytes, in the window between the
   * mutating syscall returning and the receipt being filed.
   *
   * The seam is `path.dirname`, which is how a receipt finds the directory to file itself under.
   * That call happens after the syscall has returned and before any identity is read, so firing
   * there puts the replacement exactly where a peer process lands by chance — and it lands there
   * whether the identity is about to be read from a descriptor or from the name.
   *
   * Performed by an uninstrumented child, so no wrapper in this process witnesses it and the
   * replacement is genuinely unaccounted for.
   */
  function replaceDuringReceipt(target: string, body: () => void): boolean {
    let fired = false;
    const real = path.dirname;
    (path as { dirname: unknown }).dirname = (p: string): string => {
      if (!fired && p === target) {
        fired = true;
        runPeer([peerFs.unlink(target, true), peerFs.write(target, 'THEIRS')]);
      }
      return (real as (a: string) => string)(p);
    };
    try {
      body();
    } finally {
      (path as { dirname: unknown }).dirname = real;
    }
    return fired;
  }

  /** Every write entry point that can hold a descriptor, and how the run reaches it. */
  const writers: [string, (target: string) => void][] = [
    ['writeFileSync', (t) => fs.writeFileSync(t, 'OURS', { mode: 0o600 })],
    ['appendFileSync', (t) => fs.appendFileSync(t, 'OURS', { mode: 0o600 })],
    [
      'openSync + writeSync',
      (t) => {
        const fd = fs.openSync(t, 'w', 0o600);
        try {
          fs.writeSync(fd, 'OURS');
        } finally {
          fs.closeSync(fd);
        }
      },
    ],
    [
      'copyFileSync',
      (t) => {
        const src = `${t}.source`;
        fs.writeFileSync(src, 'OURS', { mode: 0o600 });
        fs.copyFileSync(src, t);
      },
    ],
  ];

  for (const [label, write] of writers) {
    it(`${label}: an entry replaced inside the receipt window gets no receipt and survives`, () => {
      const fixture = runTempDir('sthayi-writeid-');
      props.push(fixture);
      const target = path.join(fixture, 'entry');

      const fired = replaceDuringReceipt(target, () => write(target));
      expect(fired, 'the race never actually ran').toBe(true);

      // The peer owns the name and its own inode now. Both halves matter: the run must not hold a
      // receipt naming the peer's object, and the fixture must leak around it rather than empty it.
      const standing = idOf(target);
      expect(fs.readFileSync(target, 'utf8')).toBe('THEIRS');
      const held = entryReceipt(idOf(fixture), 'entry');
      expect(
        held !== undefined && held.dev === standing.dev && held.ino === standing.ino,
        'a receipt was taken for the object the peer stood at the name',
      ).toBe(false);

      removeOwned(fixture);

      expect(fs.readFileSync(target, 'utf8')).toBe('THEIRS');
      expect(fs.existsSync(fixture)).toBe(true);
      peer.adopt(target);
    });
  }

  it('chmod: metadata changed through a handle claims the handle, not the name', () => {
    const fixture = runTempDir('sthayi-writeid-chmod-');
    props.push(fixture);
    const target = path.join(fixture, 'store');
    // Written by a program nothing here witnesses, exactly as a native database driver writes one:
    // the only trace this binding ever sees is the mode change that follows.
    runPeer([peerFs.write(target, 'OURS')]);

    const fired = replaceDuringReceipt(target, () => fs.chmodSync(target, 0o600));
    expect(fired, 'the race never actually ran').toBe(true);

    const standing = idOf(target);
    const held = entryReceipt(idOf(fixture), 'store');
    expect(held !== undefined && held.dev === standing.dev && held.ino === standing.ino).toBe(
      false,
    );

    removeOwned(fixture);

    expect(fs.readFileSync(target, 'utf8')).toBe('THEIRS');
    expect(fs.existsSync(fixture)).toBe(true);
    peer.adopt(target);
  });

  it('an entry beneath a tracked directory with no receipt is not removed by naming it', () => {
    const fixture = runTempDir('sthayi-writeid-noreceipt-');
    props.push(fixture);
    const canary = path.join(fixture, 'foreign-canary');
    runPeer([peerFs.write(canary, 'THEIRS')]);
    peer.adopt(canary);

    // The path is genuinely inside a directory this run allocated, and that buys nothing: the run
    // never named this entry, so it holds no receipt for it.
    removeOwned(canary);

    expect(fs.readFileSync(canary, 'utf8')).toBe('THEIRS');
  });

  it('a SYMLINKED component does not put an outside entry beneath a tracked directory', () => {
    const fixture = runTempDir('sthayi-writeid-link-');
    const outside = runTempDir('sthayi-writeid-outside-');
    props.push(fixture, outside);
    const canary = path.join(outside, 'foreign-canary');
    runPeer([peerFs.write(canary, 'THEIRS')]);
    peer.adopt(canary);
    fs.symlinkSync(outside, path.join(fixture, 'link'));

    // Spelled as a child of the fixture, and it is nothing of the sort: `link` resolves elsewhere,
    // so proving the components is what separates the text from the filesystem.
    removeOwned(path.join(fixture, 'link', 'foreign-canary'));

    expect(fs.readFileSync(canary, 'utf8')).toBe('THEIRS');
  });

  it('one allocation’s authority does not reach through a link into another’s', () => {
    // The shallow case is settled by the directory an entry sits in being a link. This one is not:
    // the entry's own parent is an ordinary directory, the link is one level further up, and the
    // entry is one this run really did write and really does hold a receipt for — so every check
    // that looks only at the LAST component agrees the removal is fine.
    //
    // It is not fine. The caller named something beneath ONE allocation and the name resolves into
    // a DIFFERENT one, whose own identity was never proved and whose teardown belongs to whoever
    // holds it. Containment has to be established by walking the components down from the tracked
    // directory, through nothing but directories this run recorded creating.
    const fixture = runTempDir('sthayi-writeid-deeplink-');
    const other = runTempDir('sthayi-writeid-deepother-');
    props.push(fixture, other);
    fs.mkdirSync(path.join(other, 'sub'), { mode: 0o700 });
    const ours = path.join(other, 'sub', 'ours');
    fs.writeFileSync(ours, 'OURS', { mode: 0o600 });
    fs.symlinkSync(other, path.join(fixture, 'link'));

    removeOwned(path.join(fixture, 'link', 'sub', 'ours'));

    expect(fs.readFileSync(ours, 'utf8')).toBe('OURS');
    // CONTROL: the same entry, named through the allocation that actually holds it, does go.
    removeOwned(ours);
    expect(fs.existsSync(ours)).toBe(false);
  });

  it('a foreign file standing at a VACATED tracked name is left exactly where it is', () => {
    const fixture = runTempDir('sthayi-writeid-vacated-');
    const aside = `${fixture}-aside`;
    fs.renameSync(fixture, aside);
    props.push(trackOwned(aside));
    runPeer([peerFs.write(fixture, 'THEIRS')]);
    peer.adopt(fixture);
    const planted = idOf(fixture);

    // The record describes a directory that is no longer there. It says nothing about the file a
    // stranger put at the name, and it must not be spent on it.
    removeOwned(fixture);

    expect(fs.readFileSync(fixture, 'utf8')).toBe('THEIRS');
    expect(idOf(fixture)).toEqual(planted);
  });

  it('CONTROL: every entry the run really did write is still removed', () => {
    const home = createFakeHome();
    const fixture = home.fixture;
    fs.writeFileSync(home.path('written'), 'OURS', { mode: 0o600 });
    fs.appendFileSync(home.path('appended'), 'OURS', { mode: 0o600 });
    const fd = fs.openSync(home.path('opened'), 'w', 0o600);
    fs.closeSync(fd);
    fs.copyFileSync(home.path('written'), home.path('copied'));
    fs.symlinkSync(home.path('written'), home.path('linked'));
    fs.chmodSync(home.path('copied'), 0o600);
    fs.mkdirSync(home.path('sub'), { mode: 0o700 });
    fs.writeFileSync(home.path('sub', 'nested'), 'OURS', { mode: 0o600 });

    home.cleanup();

    expect(fs.existsSync(fixture)).toBe(false);
  });

  it('CONTROL: one entry beneath a tracked directory is removable on its own receipt', () => {
    const fixture = runTempDir('sthayi-writeid-single-');
    props.push(fixture);
    const ours = path.join(fixture, 'ours');
    fs.writeFileSync(ours, 'OURS', { mode: 0o600 });

    removeOwned(ours);

    expect(fs.existsSync(ours)).toBe(false);
    expect(fs.existsSync(fixture)).toBe(true);
  });
});
