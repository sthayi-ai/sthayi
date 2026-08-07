import path from 'node:path';
import { safeReadTextFile, safeWriteFileAtomic } from '../fs-safe.js';
import { assertReadOnlySthayiHome, ensureSthayiHome } from '../paths.js';

/**
 * Per-client wiring bookkeeping (`~/.sthayi/clients-state.json`). Records exactly what wire changed
 * so unwire can restore the EXACT prior state (spec §5): whether the config file existed before,
 * and where the pre-wire backup was written. Also powers `sthayi status`.
 *
 * Trust boundary (fs-safe): the ledger steers unwire's restore/delete decisions, so a hostile
 * ledger path — symlink, hard link, foreign owner, group/world-writable — FAILS CLOSED with an
 * actionable error on both read and write; it must never silently degrade to "no ledger", and a
 * write must never travel through a planted link. Writes are exclusive-create random-temp +
 * atomic rename; a new ledger is created 0600, an existing one keeps its mode.
 */
export interface ClientState {
  backupPath: string | null;
  existedBefore: boolean;
  wiredAt: number;
  /**
   * SHA-256 of the config exactly as wire wrote it. Unwire restores/deletes wholesale only while
   * the file still matches this hash; any post-wire edit (clients rewrite their own configs)
   * drops it to surgical removal so those edits survive. Absent in ledgers written before this
   * field existed — treated as drifted.
   */
  wireHash?: string;
}

type StateFile = Record<string, ClientState>;

/**
 * The ledger path beneath an ALREADY-VALIDATED canonical home root. Every entry point below
 * establishes (writes) or observes (reads) the home boundary FIRST and passes the root in — the
 * ledger path is never derived from an unvalidated home. Deriving it from the logical STHAYI_HOME
 * string was how a retargeted ancestor still leaked: the logical path does not prefix-match the
 * established boundary, so no boundary was found and the weaker outside-a-boundary check let the
 * write land in the link's new target.
 */
function statePathIn(root: string): string {
  return path.join(root, 'clients-state.json');
}

function readStateIn(root: string): StateFile {
  // safeReadTextFile THROWS on an untrusted ledger (fail closed). Absent stays {}; unparseable
  // content stays {} — the legacy semantic (adapters then fall back to surgical removal).
  const text = safeReadTextFile(statePathIn(root), 'client wiring ledger');
  if (text === undefined) {
    return {};
  }
  try {
    return JSON.parse(text) as StateFile;
  } catch {
    return {};
  }
}

/** Read the ledger, refusing an untrusted home before touching it. An ABSENT home is simply "no
 *  ledger" ({}), reached without a single filesystem read inside it — never a creation. */
export function readState(): StateFile {
  const root = assertReadOnlySthayiHome();
  if (root === undefined) {
    return {};
  }
  return readStateIn(root);
}

export function getClientState(id: string): ClientState | undefined {
  return readState()[id];
}

export function setClientState(id: string, state: ClientState): void {
  // Writable validation FIRST (it creates the home 0700 when absent, refuses a hijacked one), and
  // the read + the write both hang off the root it returns — one boundary, one directory.
  const root = ensureSthayiHome();
  const all = readStateIn(root);
  all[id] = state;
  safeWriteFileAtomic(statePathIn(root), `${JSON.stringify(all, null, 2)}\n`);
}

export function clearClientState(id: string): void {
  // Observational first: clearing an entry that is not there must not CREATE a home that does not
  // exist (unwire on a never-initialized machine). Only a real change escalates to the writable
  // validator.
  const observed = assertReadOnlySthayiHome();
  if (observed === undefined) {
    return; // no home → no ledger to clear
  }
  const all = readStateIn(observed);
  if (!(id in all)) {
    return;
  }
  delete all[id];
  const root = ensureSthayiHome();
  safeWriteFileAtomic(statePathIn(root), `${JSON.stringify(all, null, 2)}\n`);
}
