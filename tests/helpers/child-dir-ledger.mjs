import { createRequire, syncBuiltinESMExports } from 'node:module';

/**
 * The creation recorder, loaded into every node CHILD a test run starts.
 *
 * WHY IT HAS TO EXIST. Teardown enters a directory only when this run recorded the identity it had
 * when this run created it (tests/helpers/owned-fs.ts). The wrappers there witness the creations
 * this process makes; a spawned `sthayi` uses its OWN `fs`, so the directories it writes inside a
 * fixture — a home, a skills folder, a log directory — would carry no record at all, and an
 * unrecorded directory is never entered. Without this file those fixtures leak, one per spawning
 * suite, and the run root leaks with them.
 *
 * The record is written by the process that makes the directory, at the call that makes it, on the
 * identity that call CAPTURED — never on the identity of whatever occupies the name afterwards.
 * That is the same rule the parent obeys and it exists for the same reason: a peer that moves the
 * new directory aside and stands its own tree at the name would otherwise have its tree written into
 * this ledger as run-created, and the parent's sweep would walk into it. Nothing here is read at
 * teardown to decide ownership.
 *
 * HOW IT ARRIVES. `NODE_OPTIONS=--import=<this file>?ledger=…&root=…`. The ledger path and the run
 * root travel INSIDE the loader URL rather than in environment variables, because several suites
 * hand their children a deliberately scrubbed environment to prove the CLI needs none — stripping
 * those variables must not also strip a fixture's right to be cleaned up.
 *
 * It witnesses and nothing else: same arguments, same return values, same errors, no output on any
 * stream, and every failure swallowed. A child that cannot record simply leaves a directory
 * unrecorded, and an unrecorded directory is left standing rather than removed.
 */

const require = createRequire(import.meta.url);
const fs = require('node:fs');
const path = require('node:path');

const params = new URL(import.meta.url).searchParams;
const ledger = params.get('ledger');
const root = params.get('root');

const realUmask = process.umask.bind(process);
let observedWindowsUmask = null;

if (process.platform === 'win32') {
  // Windows CRT state is process-local. This disposable child therefore owns the same deterministic
  // zero baseline as its parent test process; a later setter affects only this process.
  realUmask(0);
  observedWindowsUmask = 0;
  process.umask = (mask) => {
    if (mask === undefined) {
      return realUmask();
    }
    const previous = realUmask(mask);
    const parsed = typeof mask === 'string' ? Number.parseInt(mask, 8) : mask;
    observedWindowsUmask = parsed & 0o777;
    return previous;
  };
  syncBuiltinESMExports();
}

/** Recursion ceiling, matched to the walk's own: a deeper tree is pathological either way. */
const MAX_DEPTH = 64;

/** Whether the portable O_DIRECTORY|O_NOFOLLOW descriptor proof is available. */
const HANDLE_CAPTURE = process.platform !== 'win32';

/**
 * The test ledger's ephemeral incarnation discriminator.
 *
 * `birthtimeNs` is deliberately not treated as a general filesystem-security generation. It only
 * prevents an already-retired `(dev, ino)` pair from being mistaken for a later object during one
 * test run. Node exposes no portable inode generation, and some filesystems report no usable birth
 * time; those objects receive no cleanup authority.
 *
 * All three fields come from ONE bigint stat result. In particular, deriving the nanoseconds from a
 * second lookup or from the rounded `birthtimeMs` number would reopen the substitution/precision
 * window this discriminator exists to close.
 */
function identityFromStat(st) {
  try {
    const dev = st.dev;
    const ino = st.ino;
    const birthtimeNs = st.birthtimeNs;
    if (
      typeof dev !== 'bigint' ||
      dev < 0n ||
      typeof ino !== 'bigint' ||
      ino < 0n ||
      typeof birthtimeNs !== 'bigint' ||
      birthtimeNs <= 0n
    ) {
      return null;
    }
    return {
      dev: dev.toString(10),
      ino: ino.toString(10),
      birthtimeNs: birthtimeNs.toString(10),
    };
  } catch {
    return null;
  }
}

function sameIdentity(a, b) {
  return (
    a !== null &&
    b !== null &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.birthtimeNs === b.birthtimeNs
  );
}

function identityKey(id) {
  return `${id.dev}:${id.ino}:${id.birthtimeNs}`;
}

function slotKey(parent, name) {
  return `${identityKey(parent)}/${name}`;
}

function wireLine(id, parent, name) {
  if (
    typeof name !== 'string' ||
    name === '' ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\n') ||
    name.includes('\r')
  ) {
    return null;
  }
  return `v2 ${id.dev} ${id.ino} ${id.birthtimeNs} ${parent.dev} ${parent.ino} ${parent.birthtimeNs} ${name}`;
}

function parseDecimal(raw) {
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    return null;
  }
  return raw;
}

function parseBirthtime(raw) {
  if (!/^[1-9][0-9]*$/.test(raw)) {
    return null;
  }
  try {
    return BigInt(raw).toString(10) === raw ? raw : null;
  } catch {
    return null;
  }
}

/** Parse one complete v2 record. Legacy and malformed records confer no authority. */
function parseLedgerLine(text) {
  if (text === 'X v2 poisoned') {
    return { op: 'X' };
  }
  const match = /^([+\-ADFLM]) v2 ([0-9]+) ([0-9]+) ([0-9]+) ([0-9]+) ([0-9]+) ([0-9]+) (.+)$/.exec(
    text,
  );
  if (match === null) {
    return null;
  }
  const [, op, devRaw, inoRaw, birthRaw, parentDevRaw, parentInoRaw, parentBirthRaw, name] = match;
  const dev = parseDecimal(devRaw);
  const ino = parseDecimal(inoRaw);
  const birthtimeNs = parseBirthtime(birthRaw);
  const parentDev = parseDecimal(parentDevRaw);
  const parentIno = parseDecimal(parentInoRaw);
  const parentBirthtimeNs = parseBirthtime(parentBirthRaw);
  if (
    dev === null ||
    ino === null ||
    birthtimeNs === null ||
    parentDev === null ||
    parentIno === null ||
    parentBirthtimeNs === null ||
    name === '' ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\r')
  ) {
    return null;
  }
  return {
    op,
    id: { dev, ino, birthtimeNs },
    parent: { dev: parentDev, ino: parentIno, birthtimeNs: parentBirthtimeNs },
    name,
  };
}

function inRoot(p) {
  return typeof p === 'string' && root !== null && p.startsWith(root + path.sep);
}

/**
 * Identify the directory a creating call just made, or refuse.
 *
 * The same three legs the parent uses: a descriptor opened `O_DIRECTORY|O_NOFOLLOW` so the identity
 * belongs to an object rather than to a name, a link count read from that descriptor bounding how
 * many subdirectories the thing may hold, and a listing tied back to the descriptor's inode. A fresh
 * `mkdir` is empty and a level of a recursive `mkdir` holds exactly the level below it; a tree
 * substituted at the name wears neither shape. `null` records nothing, and an unrecorded directory
 * is never entered.
 *
 * The listing check is EQUALITY, matching the parent's: containment is what an EMPTY substitution
 * satisfies for nothing, and empty is the one shape a peer can always produce. It is still not
 * enough on its own — a peer that destroys the new directory and stands an empty one at the name in
 * the window before this call wears the right shape too, on any platform — which is why a record
 * from here authorises removing the directory and never removing anything inside it. Each entry
 * inside answers for itself, on a receipt of its own; see the receipt lines below.
 */
function proveFresh(dir, permitted, maxSubdirs) {
  const listingMatches = () => {
    try {
      const names = fs.readdirSync(dir);
      return names.length === permitted.size && names.every((n) => permitted.has(n));
    } catch {
      return false;
    }
  };
  if (!HANDLE_CAPTURE) {
    try {
      const before = fs.lstatSync(dir, { bigint: true });
      if (before.isSymbolicLink() || !before.isDirectory() || !listingMatches()) {
        return null;
      }
      const after = fs.lstatSync(dir, { bigint: true });
      const beforeId = identityFromStat(before);
      const afterId = identityFromStat(after);
      if (after.isSymbolicLink() || !after.isDirectory() || !sameIdentity(beforeId, afterId)) {
        return null;
      }
      return beforeId;
    } catch {
      return null;
    }
  }
  let fd;
  try {
    fd = fs.openSync(
      dir,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
  } catch {
    return null;
  }
  try {
    const st = fs.fstatSync(fd, { bigint: true });
    if (!st.isDirectory() || st.nlink > BigInt(2 + maxSubdirs) || !listingMatches()) {
      return null;
    }
    const held = identityFromStat(st);
    const now = identityFromStat(fs.lstatSync(dir, { bigint: true }));
    if (!sameIdentity(now, held)) {
      return null;
    }
    return held;
  } catch {
    return null;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // the descriptor outlives nothing that matters
    }
  }
}

/**
 * The ledger line for a directory whose identity is already CAPTURED.
 *
 * Keyed by the parent's full ephemeral incarnation plus one entry name — never by a pathname, which
 * a substitution inherits for free and a rename invalidates wholesale. The captured identity is
 * what gets written; the name is only checked to still answer to it.
 */
function line(dir, id) {
  try {
    const name = path.basename(dir);
    if (name === '' || name === '.' || name === '..') {
      return null;
    }
    const st = fs.lstatSync(dir, { bigint: true });
    const parentStat = fs.lstatSync(path.dirname(dir), { bigint: true });
    const current = identityFromStat(st);
    const parent = identityFromStat(parentStat);
    if (!sameIdentity(current, id) || !parentStat.isDirectory() || parent === null) {
      return null;
    }
    return wireLine(id, parent, name);
  } catch {
    return null;
  }
}

function write(op, text) {
  if (text === null) {
    return;
  }
  try {
    fs.appendFileSync(ledger, `${op} ${text}\n`, { mode: 0o600 });
  } catch {
    // unrecorded, and therefore never entered by teardown — the safe direction
  }
}

if (ledger !== null && root !== null) {
  const NO_ENTRIES = new Set();

  /**
   * Every ephemeral filesystem incarnation this child is recorded creating.
   *
   * A rename gives a directory a name without creating it, so re-keying one is only legitimate when
   * this run made it. What this child made is known directly; what an earlier process made is read
   * back out of the ledger, which is persisted evidence rather than a look at the tree. A source
   * neither of them knows is an OUTSIDE directory and is not recorded under its new name.
   */
  const mine = new Set();
  let ledgerRead = 0;
  /** What the LEDGER currently says is live, rebuilt by replaying it in order. */
  let recorded = new Set();

  const remember = (id) => {
    mine.add(identityKey(id));
  };

  /**
   * THE LEDGER IS A HISTORY, NOT A LIST OF CREATIONS, and reading it as the latter is how a number
   * the kernel has already taken back comes back to life.
   *
   * Every line is applied IN ORDER: a creation adds an inode, a retirement takes it away again, and
   * an invalidation empties the whole thing. Collecting only the creation lines would reinstate
   * every number any process ever recorded — including the ones a removal gave back — so a
   * retirement would be undone by the next question anybody asked, and a directory that inherits the
   * number would be walked into as one this run made.
   *
   * A move is deliberately not a retirement: `M` says a directory left a NAME, and the directory
   * itself is intact somewhere else, still this run's.
   */
  const replayLedger = () => {
    let text;
    try {
      text = fs.readFileSync(ledger, 'utf8');
    } catch {
      return; // unreadable: nothing new is registered, which records nothing
    }
    if (text.length === ledgerRead) {
      return;
    }
    ledgerRead = text.length;
    const live = new Set();
    for (const l of text.split('\n')) {
      if (l === '') {
        continue;
      }
      const parsed = parseLedgerLine(l);
      if (parsed === null) {
        // A legacy or malformed retirement could otherwise leave an earlier creation authoritative.
        // Drop all authority accumulated before it; later valid v2 lines can build fresh authority.
        live.clear();
        mine.clear();
        receipts.clear();
        continue;
      }
      if (parsed.op === 'X') {
        // Some process could not account for what a removal destroyed. Nothing recorded before that
        // point describes anything this recorder may rely on, including its own memory.
        live.clear();
        mine.clear();
        receipts.clear();
        continue;
      }
      const key = identityKey(parsed.id);
      if (parsed.op === '+' || parsed.op === 'A') {
        live.add(key);
      } else if (parsed.op === '-') {
        live.delete(key);
      } else if (parsed.op === 'D') {
        // A destruction stated as an IDENTITY. Everything `-` does, plus this child's own memory:
        // `mine` is what decides whether a directory moved in was made by this run, and a number
        // left in it after some process watched that directory die would adopt whatever inherits it.
        live.delete(key);
        mine.delete(key);
        for (const held of [...receipts.keys()]) {
          if (held.startsWith(`${key}/`)) {
            receipts.delete(held);
          }
        }
      }
    }
    recorded = live;
  };

  const knownCreated = (id) => {
    // Replayed FIRST, and the memory consulted afterwards: an invalidation written by another
    // process has to be able to take this one's own records away too.
    replayLedger();
    const key = identityKey(id);
    return mine.has(key) || recorded.has(key);
  };

  const record = (dir, id) => {
    remember(id);
    if (inRoot(dir)) {
      write('+', line(dir, id));
    }
  };

  /**
   * ENTRY RECEIPTS: the single named entries this child has created or altered.
   *
   * A creation record names a directory that may not be the one this child made — the window
   * between `mkdir` returning and the first look at the result cannot be closed in portable Node,
   * and an EMPTY replacement standing at the name wears exactly the shape a fresh `mkdir` has. So a
   * record permits removing the directory it names and nothing inside it, and every entry INSIDE it
   * has to answer for itself. A line here says "this child changed this exact object, in this exact
   * directory, and the syscall succeeded"; it says nothing about any other entry, which is what
   * keeps a peer's file out of the parent's sweep even when it sits beside one of ours.
   *
   * THE IDENTITY COMES FROM A DESCRIPTOR, exactly as it does in the parent. A write returns, and
   * resolving its pathname a second time to find out what was written is a different question with
   * an attacker-controllable answer: a peer that replaces the name in that window would otherwise
   * have ITS file written into this ledger, and the parent's sweep would then remove it. `fstat` on
   * the handle the bytes went through cannot be redirected. A symlink has no such handle, so its
   * receipt is written as `L` and authorises removing a symlink and nothing that holds bytes.
   *
   * A RECEIPT IS RETIRED WHEN ITS ENTRY GOES. An inode number returns to the kernel with the object
   * that held it, and the kernel hands numbers out again; a receipt left behind after an `unlink`, a
   * `rename` away, or an `rm` would vouch for whatever inherits the number, in a process that is not
   * even running any more. So every removal writes a `-` line for the entry it really did take away.
   *
   * Directories are deliberately excluded: they are authorised by the creation records above, whose
   * shape proof is stronger than "something named this path".
   *
   * One line per entry: the map is consulted first, so a file written ten thousand times costs one
   * append.
   */
  const receipts = new Map();

  /**
   * The descriptor primitives, bound before anything the child loads can reach them: a receipt has
   * to be able to name the object a syscall changed even when the program under test has replaced
   * the binding that performed it.
   */
  const realOpen = fs.openSync;
  const realFstat = fs.fstatSync;
  const realFtruncate = fs.ftruncateSync;
  const realLstat = fs.lstatSync;

  /** The directory an entry sits in, and the one name it answers to. */
  const slotOf = (target) => {
    const name = path.basename(target);
    const parentPath = path.dirname(target);
    if (parentPath === target || name === '' || name === '.' || name === '..') {
      return null;
    }
    try {
      const parentStat = fs.lstatSync(parentPath, { bigint: true });
      const parent = identityFromStat(parentStat);
      if (parentStat.isSymbolicLink() || !parentStat.isDirectory() || parent === null) {
        return null;
      }
      return { key: slotKey(parent, name), parent, name };
    } catch {
      return null;
    }
  };

  const keep = (target, slot, id, op) => {
    const held = `${op}${identityKey(id)}`;
    if (receipts.get(slot.key) === held) {
      return;
    }
    receipts.set(slot.key, held);
    write(op, wireLine(id, slot.parent, slot.name));
  };

  /** A receipt for the object a DESCRIPTOR names — the only kind that can hold bytes. */
  const receiptFromFd = (fd, target) => {
    if (!inRoot(target)) {
      return;
    }
    const slot = slotOf(target);
    if (slot === null) {
      return;
    }
    try {
      const st = fs.fstatSync(fd, { bigint: true });
      if (st.isDirectory()) {
        return;
      }
      const id = identityFromStat(st);
      if (id !== null) {
        keep(target, slot, id, 'F');
      }
    } catch {
      // unclaimed, and therefore never removed by the parent
    }
  };

  /** The narrowed receipt for a symlink this child created; see the note above. */
  const receiptForLink = (target) => {
    if (!inRoot(target)) {
      return;
    }
    const slot = slotOf(target);
    if (slot === null) {
      return;
    }
    try {
      const st = fs.lstatSync(target, { bigint: true });
      if (!st.isSymbolicLink()) {
        return;
      }
      const id = identityFromStat(st);
      if (id !== null) {
        keep(target, slot, id, 'L');
      }
    } catch {
      // unclaimed
    }
  };

  /** What a removal is about to invalidate, read while the entry it describes still exists. */
  const doomed = (target) => {
    if (!inRoot(target)) {
      return null;
    }
    const slot = slotOf(target);
    if (slot === null) {
      return null;
    }
    try {
      const st = fs.lstatSync(target, { bigint: true });
      if (st.isDirectory() && !st.isSymbolicLink()) {
        return null; // directories are retired by the vacate wrapper below
      }
      const id = identityFromStat(st);
      return id === null ? null : { slot, id };
    } catch {
      return null;
    }
  };

  /** Retire a receipt for an entry a removal really did take away; leave a survivor's alone. */
  const retire = (was, target) => {
    if (was === null || fs.lstatSync(target, { throwIfNoEntry: false }) !== undefined) {
      return;
    }
    receipts.delete(was.slot.key);
    write('-', wireLine(was.id, was.slot.parent, was.slot.name));
  };

  /** Ceiling on a removal census: a tree wider than this is pathological either way. */
  const MAX_CENSUS = 8192;

  /**
   * One entry as it stands right now, keyed the way every record here is keyed — the identity of the
   * directory it sits in plus the one name it answers to, never a pathname.
   */
  const censusEntry = (p) => {
    const slot = slotOf(p);
    if (slot === null) {
      return null;
    }
    try {
      const st = fs.lstatSync(p, { bigint: true });
      const id = identityFromStat(st);
      if (id === null) {
        return null;
      }
      return {
        path: p,
        id,
        parent: slot.parent,
        name: slot.name,
        key: slot.key,
        directory: st.isDirectory() && !st.isSymbolicLink(),
      };
    } catch {
      return null;
    }
  };

  /**
   * EVERYTHING A REMOVAL IS ABOUT TO INVALIDATE, read while it still exists to be read.
   *
   * A RECURSIVE REMOVAL DESTROYS A WHOLE TREE INSIDE ONE CALL AND NAMES ONLY THE TOP OF IT. Every
   * record and every receipt underneath describes an object that is about to stop existing, and the
   * inode numbers they name go straight back to the kernel, which hands them out again. A record
   * left behind then answers "yes, this run created that" for a directory belonging to a concurrent
   * run or a peer, and the sweep walks into it — authority conjured out of a recycled integer, held
   * by a process that has already exited. So the tree is censused BEFORE the call: afterwards there
   * is nothing left to identify.
   *
   * A symlink is an entry and never a way down: `Dirent.isDirectory()` reports what `lstat` would,
   * so a link to somebody else's tree is recorded as the one entry it is and never descended into.
   */
  const doomedTree = (target, recursive) => {
    const out = [];
    let complete = true;
    const visit = (p, depth) => {
      if (!inRoot(p)) {
        return; // nothing outside the root is recorded, so there is nothing there to account for
      }
      if (out.length >= MAX_CENSUS || depth > MAX_DEPTH) {
        complete = false; // the call will destroy what this walk is no longer counting
        return;
      }
      const entry = censusEntry(p);
      if (entry === null) {
        return;
      }
      out.push(entry);
      if (!entry.directory || !recursive) {
        return;
      }
      let names;
      try {
        names = fs.readdirSync(p, { withFileTypes: true });
      } catch (err) {
        if (err === null || typeof err !== 'object' || err.code !== 'ENOENT') {
          // A directory that vanished holds nothing left to destroy. One that cannot be LISTED may
          // hold records this walk will never see, and the removal is going in regardless.
          complete = false;
        }
        return;
      }
      for (const d of names) {
        visit(path.join(p, d.name), depth + 1);
      }
    };
    visit(target, 0);
    return { entries: out, complete };
  };

  /**
   * Retire what the removal really did take away, and nothing that survived it.
   *
   * "Really did take away" is the identity test, not an existence test: a name now answering to a
   * DIFFERENT object is a name the recorded object no longer reaches, and a record left standing
   * there would vouch for whatever arrived. A name still holding the recorded inode was not removed
   * at all — a refused `rmdir`, a partial recursion — and its record still describes it exactly.
   */
  const retireCensus = (census) => {
    for (const entry of census) {
      const st = fs.lstatSync(entry.path, { bigint: true, throwIfNoEntry: false });
      const current = st === undefined ? null : identityFromStat(st);
      if (sameIdentity(current, entry.id)) {
        continue;
      }
      if (entry.directory) {
        // The inode goes back to the kernel with the directory. `mine` is what decides whether a
        // directory moved IN was made by this run, so a number left in it would adopt whatever
        // inherits it next.
        mine.delete(identityKey(entry.id));
      } else {
        receipts.delete(entry.key);
      }
      write('-', wireLine(entry.id, entry.parent, entry.name));
    }
  };

  const absolute = (p) => (typeof p === 'string' ? path.resolve(p) : null);

  /**
   * Whether taking a descriptor on this name is safe to do at all.
   *
   * A free name or a regular file can be opened without waiting. A fifo cannot — opening one blocks
   * until the other end is opened — and a wrapper that takes a descriptor in order to record
   * something must never be able to stop the program it is recording for. A symlink cannot either:
   * following it would write into the target while the entry being recorded is the link. Both go to
   * the real call, unchanged and unclaimed.
   */
  const openable = (target) => {
    const st = fs.lstatSync(target, { throwIfNoEntry: false });
    return st === undefined || st.isFile();
  };

  /** Perform a write through a descriptor THIS wrapper opens, so the receipt names that object. */
  const writeThrough = (real, fallbackFlag) => {
    return (file, data, options) => {
      const target = absolute(file);
      const writable = typeof data === 'string' || ArrayBuffer.isView(data);
      if (target === null || !writable || !inRoot(target) || !openable(target)) {
        return real(file, data, options);
      }
      const o = typeof options === 'object' && options !== null ? options : {};
      const fd = realOpen(target, o.flag ?? fallbackFlag, o.mode ?? 0o666);
      try {
        const out = real(fd, data, options);
        receiptFromFd(fd, target);
        return out;
      } finally {
        try {
          fs.closeSync(fd);
        } catch {
          // the descriptor outlives nothing that matters
        }
      }
    };
  };

  /** Change metadata through a descriptor, so the object changed is the object recorded. */
  const throughHandle = (real, viaHandle, flags, nativeWindowsDirectory = false) => {
    return (p, ...rest) => {
      const target = absolute(p);
      if (target === null || !inRoot(target)) {
        return real(p, ...rest);
      }
      // Windows can chmod a directory by path, while fchmod on the bookkeeping descriptor raises
      // EPERM. Directories never receive file receipts, so retaining the native path operation is
      // both transparent and the strongest authority this recorder can honestly claim.
      if (nativeWindowsDirectory && process.platform === 'win32') {
        try {
          if (realLstat(target).isDirectory()) {
            return real(p, ...rest);
          }
        } catch {
          // The open/fallback path below preserves the native missing-entry refusal.
        }
      }
      let fd;
      try {
        // `O_NONBLOCK` so a fifo standing at the name cannot make a bookkeeping open wait for a
        // peer that may never arrive; `O_NOFOLLOW` so a link is refused rather than resolved.
        fd = realOpen(target, flags | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      } catch {
        return real(p, ...rest); // a symlink, a fifo, or unopenable: the real call, and no claim
      }
      try {
        const out = viaHandle(fd, ...rest);
        receiptFromFd(fd, target);
        return out;
      } finally {
        try {
          fs.closeSync(fd);
        } catch {
          // the descriptor outlives nothing that matters
        }
      }
    };
  };

  const realMkdir = fs.mkdirSync;
  fs.mkdirSync = (p, opts) => {
    const made = realMkdir(p, opts);
    if (typeof p === 'string') {
      const target = path.resolve(p);
      if (opts === undefined || opts === null || opts.recursive !== true) {
        const id = proveFresh(target, NO_ENTRIES, 0);
        if (id !== null) {
          record(target, id);
        }
      } else if (typeof made === 'string') {
        // `recursive` reports the FIRST level it had to create; every level from there down to the
        // requested path is new, and all of it is this run's work. The deepest level is empty and
        // every level above holds exactly the level below — the shape a substitution cannot wear.
        const first = path.resolve(made);
        let below = null;
        for (let cur = target, i = 0; i <= MAX_DEPTH; i += 1) {
          const id =
            below === null
              ? proveFresh(cur, NO_ENTRIES, 0)
              : proveFresh(cur, new Set([path.basename(below)]), 1);
          if (id === null) {
            break;
          }
          record(cur, id);
          below = cur;
          const up = path.dirname(cur);
          if (cur === first || up === cur) {
            break;
          }
          cur = up;
        }
      }
    }
    return made;
  };

  const realMkdtemp = fs.mkdtempSync;
  fs.mkdtempSync = (p, opts) => {
    const made = realMkdtemp(p, opts);
    if (typeof made === 'string') {
      const target = path.resolve(made);
      const id = proveFresh(target, NO_ENTRIES, 0);
      if (id !== null) {
        record(target, id);
      }
    }
    return made;
  };

  const realRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    // The identity is read from the SOURCE before the call and carried across: a rename preserves
    // the inode, so the directory that arrives is recorded as the directory that left. A moved
    // directory keeps everything inside it keyed by parents that did not move, so only its own key
    // changes — and a directory this run never created is not given one by being moved in.
    let moving = null;
    if (typeof from === 'string') {
      try {
        const st = fs.lstatSync(from, { bigint: true });
        if (!st.isSymbolicLink() && st.isDirectory()) {
          moving = identityFromStat(st);
        }
      } catch {
        // nothing to carry
      }
    }
    // A NON-DIRECTORY is identified before the call for both halves of the move: the receipt for the
    // entry that leaves is retired, and the object that arrives is named by the identity it had on
    // the way out. `rename` preserves the inode, so that identity IS the arriving object's.
    const leaving = moving === null ? doomed(absolute(from)) : null;
    // THE NAME A DIRECTORY LEAVES DOES NOT KEEP ITS AUTHORITY. Recording the destination without
    // releasing the source leaves a record saying "this run made a directory here" about a name
    // whose directory has gone, and the sweep spends a record by ENTERING whatever answers to the
    // name next. Identified here, while the source still exists to be identified.
    const fromPath = absolute(from);
    const vacating =
      moving === null || fromPath === null || !inRoot(fromPath) ? null : censusEntry(fromPath);
    // A DESTINATION THAT ALREADY HOLDS A DIRECTORY IS DESTROYED BY THIS CALL. `rename` onto an
    // existing EMPTY directory succeeds and unlinks it, so one syscall both moves a directory and
    // destroys another — and only the move is visible in the arguments. Read here, while there is
    // still something at the name to identify.
    const toPath = absolute(to);
    const destroyed =
      moving === null || toPath === null || !inRoot(toPath) ? null : censusEntry(toPath);
    realRename(from, to);
    if (
      moving !== null &&
      vacating !== null &&
      vacating.directory &&
      sameIdentity(vacating.id, moving)
    ) {
      const still = fs.lstatSync(vacating.path, { bigint: true, throwIfNoEntry: false });
      const stillId = still === undefined ? null : identityFromStat(still);
      if (!sameIdentity(stillId, moving)) {
        // `M`, never `-`: the directory is intact at its new name, so its inode record and every
        // receipt for the entries inside it — none of which the move touched — have to survive.
        write('M', wireLine(moving, vacating.parent, vacating.name));
      }
    }
    if (moving === null && leaving !== null) {
      retire(leaving, absolute(from));
      const target = absolute(to);
      const slot = target === null || !inRoot(target) ? null : slotOf(target);
      if (slot !== null) {
        try {
          const landed = fs.lstatSync(target, { bigint: true });
          const landedId = identityFromStat(landed);
          if (sameIdentity(landedId, leaving.id)) {
            keep(target, slot, leaving.id, landed.isSymbolicLink() ? 'L' : 'F');
          }
        } catch {
          // nothing arrived that this call can answer for
        }
      }
    }
    if (moving !== null && toPath !== null && inRoot(toPath)) {
      // THE DESTROYED DESTINATION FIRST, AND THE ARRIVING DIRECTORY SECOND.
      //
      // Both lines describe the same name under the same parent, and a retirement is guarded on
      // identity in the process that replays it, so it can only retire the record it names. Written
      // the other way round the reader would apply the re-record, find the retirement matching
      // nothing, and keep every stale record it had — all the lines present, and no effect.
      //
      // What goes with the destroyed directory is everything that described it: the inode, which
      // authorises it under ANY name, and every receipt keyed by it, which would otherwise license
      // removing the entries of whatever object inherits the number.
      const landed = fs.lstatSync(toPath, { bigint: true, throwIfNoEntry: false });
      const landedId = landed === undefined ? null : identityFromStat(landed);
      const arrived = sameIdentity(landedId, moving);
      if (
        arrived &&
        destroyed !== null &&
        destroyed.directory &&
        !sameIdentity(destroyed.id, moving)
      ) {
        mine.delete(identityKey(destroyed.id));
        const held = `${identityKey(destroyed.id)}/`;
        for (const key of [...receipts.keys()]) {
          if (key.startsWith(held)) {
            receipts.delete(key);
          }
        }
        const destroyedLine = wireLine(destroyed.id, destroyed.parent, destroyed.name);
        write('-', destroyedLine);
        // AND THE SAME LOSS WITHOUT REFERENCE TO THE NAME. The reader in the parent applies `-` by
        // the KEY it names, so a directory carried to this name by a move no wrapper witnessed —
        // still recorded under the name it was made at — keeps every record the `-` line should have
        // taken. `D` names the identity that was destroyed, which is what the call actually took.
        write('D', destroyedLine);
      }
      if (knownCreated(moving)) {
        write('+', line(toPath, moving));
      }
    }
  };

  // A child that DESTROYS something the harness recorded — a CLI that wipes the home it was pointed
  // at and builds a fresh one, or that deletes a file it wrote a moment ago — has to say so, or the
  // record outlives the object it named and goes on vouching for an inode number the kernel has
  // already handed on. THE WHOLE TREE IS ACCOUNTED FOR, not just the level the call names: one
  // recursive removal destroys every record and every receipt underneath it in a single syscall, and
  // every one of those is a promise about an object that no longer exists. Read before the call,
  // because afterwards there is nothing left to read, and retired only for what really did go.
  /**
   * INVALIDATE EVERYTHING THIS RECORDER HOLDS — the answer to a destruction it cannot account for.
   *
   * A census that could not be completed cannot say WHICH records described something the call is
   * about to destroy, and the records are keyed by identity rather than by path, so there is no
   * subset to select. Either every record is trustworthy or none of them is, and after a removal of
   * unknown extent none of them is. So the whole holding goes: this process's memory, and — because
   * the sweep runs somewhere that only ever sees the file — a line that makes every other process
   * drop the same records when it next reads.
   *
   * WRITTEN BEFORE THE DESTRUCTION, so a process killed halfway through has already given up its
   * authority rather than left it lying beside a half-removed tree.
   *
   * WHAT IT COSTS. Every later removal refuses for want of a record, and the fixtures leak. That is
   * the direction this file errs in everywhere else, and it is chosen over refusing the removal
   * itself: these wrappers witness, and one that made `rm` fail would change what the program under
   * test does and report a defect that belongs to the harness.
   */
  const poison = () => {
    mine.clear();
    receipts.clear();
    recorded = new Set();
    write('X', 'v2 poisoned');
  };

  const vacate = (real) => (p, opts) => {
    const target = absolute(p);
    const recursive = typeof opts === 'object' && opts !== null && opts.recursive === true;
    const census =
      target === null ? { entries: [], complete: true } : doomedTree(target, recursive);
    if (!census.complete) {
      poison();
    }
    real(p, opts);
    retireCensus(census.entries);
  };
  fs.rmdirSync = vacate(fs.rmdirSync);
  fs.rmSync = vacate(fs.rmSync);

  // The entry points that put a NON-DIRECTORY into a directory, each working through a descriptor so
  // the object recorded is the object changed. Without them a home holding only a store and a key
  // would be refused and leaked, because those files are written by a `sthayi` child and, for the
  // SQLite store, by native code no JavaScript wrapper can see at all — the only trace of the store
  // this binding ever sees is the `chmod` to 0600 that follows the native open.
  fs.writeFileSync = writeThrough(fs.writeFileSync, 'w');
  fs.appendFileSync = writeThrough(fs.appendFileSync, 'a');

  const realUnlink = fs.unlinkSync;
  fs.unlinkSync = (p) => {
    const target = absolute(p);
    const entry = target === null ? null : doomed(target);
    const out = realUnlink(p);
    if (entry !== null && target !== null) {
      retire(entry, target);
    }
    return out;
  };

  // The destination is the second argument for these three; the first names something that already
  // exists elsewhere and is nothing this child is claiming to have written.
  // The copy is performed through descriptors this wrapper holds, so the object recorded is the
  // object the bytes went into. `COPYFILE_EXCL` has an exact open-flag twin; every other shape, and
  // every snag, goes to the real call, which produces the real behaviour and the real error and
  // claims nothing.
  const realCopyFile = fs.copyFileSync;
  const nativeCopyFallback = Symbol('native-copy-fallback');
  fs.copyFileSync = (src, dest, mode) => {
    const source = absolute(src);
    const target = absolute(dest);
    const exclusive = mode === fs.constants.COPYFILE_EXCL;
    if (
      source === null ||
      target === null ||
      !inRoot(target) ||
      !(mode === undefined || mode === 0 || exclusive) ||
      !openable(target)
    ) {
      return realCopyFile(src, dest, mode);
    }
    let srcFd;
    try {
      srcFd = realOpen(source, fs.constants.O_RDONLY);
    } catch {
      return realCopyFile(src, dest, mode);
    }
    const outcome = (() => {
      try {
        const srcStat = fs.fstatSync(srcFd);
        if (!srcStat.isFile()) {
          return nativeCopyFallback;
        }
        if (process.platform === 'win32') {
          // CopyFileW propagates READONLY, and unlike O_CREAT it does not apply the process umask.
          // Shapes this descriptor copy cannot reproduce exactly stay native and receive no receipt.
          if ((srcStat.mode & 0o222) === 0) {
            return nativeCopyFallback;
          }
          if (observedWindowsUmask === null || (observedWindowsUmask & 0o200) !== 0) {
            return nativeCopyFallback;
          }
        }
        const perm = srcStat.mode & 0o7777;
        let destFd;
        try {
          destFd = realOpen(
            target,
            fs.constants.O_WRONLY | fs.constants.O_CREAT | (exclusive ? fs.constants.O_EXCL : 0),
            perm,
          );
        } catch {
          return nativeCopyFallback;
        }
        try {
          if (!exclusive) {
            const sourceId = realFstat(srcFd, { bigint: true });
            const destinationId = realFstat(destFd, { bigint: true });
            if (sourceId.dev === destinationId.dev && sourceId.ino === destinationId.ino) {
              return nativeCopyFallback;
            }
          }
          // POSIX needs this descriptor-bound chmod after the umask-filtered open. The writable
          // Windows shape already has its native synthetic mode, and fchmod on this descriptor raises
          // EPERM there.
          if (process.platform !== 'win32') {
            fs.fchmodSync(destFd, perm);
          }
          if (!exclusive) {
            realFtruncate(destFd, 0);
          }
          const buf = Buffer.allocUnsafe(64 * 1024);
          for (let at = 0; ; ) {
            const read = fs.readSync(srcFd, buf, 0, buf.length, at);
            if (read === 0) {
              break;
            }
            let written = 0;
            while (written < read) {
              written += fs.writeSync(destFd, buf, written, read - written, at + written);
            }
            at += read;
          }
          receiptFromFd(destFd, target);
          return undefined;
        } finally {
          try {
            fs.closeSync(destFd);
          } catch {
            // the descriptor outlives nothing that matters
          }
        }
      } finally {
        try {
          fs.closeSync(srcFd);
        } catch {
          // the descriptor outlives nothing that matters
        }
      }
    })();
    // Native fallback must see the descriptor state an untouched call would see. In particular,
    // same-file copy on Windows is not transparent while this wrapper's extra handles remain live.
    return outcome === nativeCopyFallback ? realCopyFile(src, dest, mode) : outcome;
  };

  const realSymlink = fs.symlinkSync;
  fs.symlinkSync = (target, at, type) => {
    const out = realSymlink(target, at, type);
    receiptForLink(absolute(at));
    return out;
  };

  // A hard link names the SAME OBJECT the source names, so the identity is read from a descriptor
  // held on the source and carried to the new name. This is the shape the vault key arrives in: it
  // is written to a temporary name and then linked into place.
  const realLink = fs.linkSync;
  fs.linkSync = (existing, at) => {
    const source = absolute(existing);
    const target = absolute(at);
    let id = null;
    if (source !== null && target !== null && inRoot(target)) {
      let fd;
      try {
        fd = realOpen(
          source,
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
        );
      } catch {
        fd = null;
      }
      if (fd !== null) {
        try {
          const st = fs.fstatSync(fd, { bigint: true });
          id = st.isDirectory() ? null : identityFromStat(st);
        } catch {
          id = null;
        } finally {
          try {
            fs.closeSync(fd);
          } catch {
            // the descriptor outlives nothing that matters
          }
        }
      }
    }
    const out = realLink(existing, at);
    if (id !== null && target !== null) {
      const slot = slotOf(target);
      if (slot !== null) {
        keep(target, slot, id, 'F');
      }
    }
    return out;
  };

  // Metadata and size are content too, and each has a descriptor-taking twin.
  for (const [name, handleName, flags] of [
    ['chmodSync', 'fchmodSync', fs.constants.O_RDONLY],
    ['chownSync', 'fchownSync', fs.constants.O_RDONLY],
    ['utimesSync', 'futimesSync', fs.constants.O_RDONLY],
    ['truncateSync', 'ftruncateSync', fs.constants.O_WRONLY],
  ]) {
    if (typeof fs[name] === 'function' && typeof fs[handleName] === 'function') {
      fs[name] = throughHandle(fs[name], fs[handleName], flags, name === 'chmodSync');
    }
  }

  fs.openSync = (p, flags, mode) => {
    const fd = realOpen(p, flags, mode);
    // Only a flag set that CREATES claims anything. The string forms that create are exactly those
    // carrying `w` or `a`; every `r` form requires the entry to exist already, and an absent flag
    // defaults to `r` — including the `O_DIRECTORY|O_NOFOLLOW` open the capture above performs.
    const creates =
      typeof flags === 'number'
        ? (flags & fs.constants.O_CREAT) !== 0
        : typeof flags === 'string' && (flags.includes('w') || flags.includes('a'));
    if (creates && typeof p === 'string') {
      receiptFromFd(fd, path.resolve(p));
    }
    return fd;
  };
}
