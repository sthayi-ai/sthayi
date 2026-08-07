import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { legacyHttpTokenWarning } from '../doctor.js';
import { padEndVisible } from '../format.js';
import { untrustedStatReason } from '../fs-safe.js';
import { assertReadOnlySthayiHome, dbPath, keyPath, sthayiHomeRoot } from '../paths.js';
import { ensureSkillsDir, sampleSkillPath, skillsSeeded } from '../skills.js';
import { openCliStore } from '../store.js';
import type { ClientAdapter, WireResult } from './adapter.js';
import { defaultAdapters } from './index.js';
import {
  type LauncherPlan,
  cliLauncherPath,
  launcherHealth,
  readLauncherBody,
  renderLauncher,
  writeLauncher,
} from './launcher.js';

function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

function statusIcon(ok: boolean): string {
  return ok ? '✓' : '·';
}

function printWireResult(r: WireResult): void {
  // r.message already reads "would wire" / "wired" / "already wired" / etc.
  out(`  ${statusIcon(r.wired)} ${padEndVisible(r.label, 16)} ${r.message}  (${r.configPath})`);
}

/** Known export-archive name patterns to surface in the wizard's importer offer. */
function scanDownloads(): string[] {
  const dir = path.join(os.homedir(), 'Downloads');
  if (!fs.existsSync(dir)) {
    return [];
  }
  const patterns = [
    /chatgpt/i,
    /^data-.*\.zip$/i,
    /claude.*export/i,
    /takeout.*\.zip$/i,
    /conversations.*\.zip$/i,
  ];
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => patterns.some((re) => re.test(f)))
      .map((f) => path.join(dir, f))
      .slice(0, 5);
  } catch {
    return [];
  }
}

function printDemoCard(): void {
  out('');
  out('  ── The Sixty-Second Demo ──────────────────────────────────');
  out('  1. Restart your AI clients so they pick up the new config.');
  out('  2. Ask any of them:  "Use Sthayi memory: what do you know about me?"');
  out('  3. Verify wiring anytime:  sthayi status');
  out('  ───────────────────────────────────────────────────────────');
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    // Non-interactive (CI, `curl | sh`, piped stdin): never assume consent for a config-mutating
    // operation. Unattended wiring must be explicit via `--yes`.
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question(`${question} `, resolve));
  rl.close();
  const a = answer.trim();
  return a === '' || /^y/i.test(a);
}

function select(adapters: ClientAdapter[], clientId?: string): ClientAdapter[] {
  if (!clientId) {
    return adapters;
  }
  const match = adapters.filter((a) => a.id === clientId);
  if (match.length === 0) {
    out(`unknown client '${clientId}'. Known: ${adapters.map((a) => a.id).join(', ')}`);
  }
  return match;
}

/** What `sthayi init` WOULD do — computed by pure reads only. */
export interface InitPlan {
  home: string;
  homeExists: boolean;
  db: { path: string; exists: boolean };
  key: { path: string; exists: boolean };
  launcher: { path: string; action: 'create' | 'update' | 'unchanged' };
  /** the durable general CLI launcher (`bin/sthayi`) written alongside the MCP launcher */
  cliLauncher: { path: string; action: 'create' | 'update' | 'unchanged' };
  skillsSample: { path: string; wouldCreate: boolean };
  /** adapter dry-run results for every DETECTED client */
  clients: WireResult[];
}

/**
 * Would the launcher write change what is on disk? (renderLauncher content vs disk bytes)
 *
 * The read is the hardened capped O_NOFOLLOW one, and ONLY GENUINE ABSENCE maps to 'create'. The
 * previous shape — `readFileSync` inside a bare try/catch — followed a symlinked launcher (an
 * outside target holding identical bytes was reported 'unchanged', i.e. the hijack rendered as
 * health), blocked on a FIFO, and turned every other unsafe state into 'create', which is the one
 * outcome that means "nothing is there". Unsafe states now PROPAGATE as a refusal: the dry-run
 * exits nonzero with an actionable message and still writes nothing.
 */
function launcherAction(plan: LauncherPlan): 'create' | 'update' | 'unchanged' {
  const body = readLauncherBody(plan.path);
  if (body === undefined) {
    return 'create';
  }
  return body === plan.content ? 'unchanged' : 'update';
}

/**
 * Would ensureSkillsDir seed the sample skill? Shares skills.ts's OBSERVATIONAL probe, so the
 * plan and the execution agree about what "already seeded" means — and, like the launcher
 * inspection above, a hostile skills subtree (a symlinked root, a symlinked nested skill dir, an
 * untrusted SKILL.md) is REFUSED rather than swallowed by a catch-all that reported
 * "would create" while reading through someone else's tree.
 */
function skillsSamplePlan(): { path: string; wouldCreate: boolean } {
  return { path: sampleSkillPath(), wouldCreate: !skillsSeeded() };
}

/**
 * NO-FOLLOW presence probe for a FINAL state path the plan speaks about (`sthayi.db`, `key`).
 *
 * `fs.existsSync` FOLLOWS symlinks, so it answered for the LINK'S TARGET: with
 * `~/.sthayi/sthayi.db -> /somewhere/else`, `init --dry-run` printed `keep existing db` — a
 * user-visible verdict computed from a file outside the home, whose mere existence the dry-run
 * thereby disclosed. A DANGLING link inverted the same lie into `create db` while an entry was
 * plainly planted there, and a FIFO/hard link read as a healthy store.
 *
 * So: lstat only (a symlink is seen as itself, never resolved), and anything present that is not
 * a regular, single-hard-link file owned by us is REFUSED rather than described — exactly what
 * `SqliteDriver.open` / `NodeCrypto.open` would do on the executing path, reported one step
 * earlier. Permission bits are NOT policed here (`modePolicy: 'ignore'`): the executing path
 * chmods the db to 0600 itself, so a merely-loose mode must not make the plan unusable. Being a
 * refusal, the dry-run still writes nothing — it throws before anything is created.
 */
function plannedStatePath(p: string, what: string): { path: string; exists: boolean } {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { path: p, exists: false }; // genuinely absent — the healthy "would create" case
    }
    throw new Error(
      `${what} at ${p} could not be inspected (${code ?? 'unknown error'}) — refusing to report on it`,
    );
  }
  const reason = untrustedStatReason(st, p, what, { modePolicy: 'ignore' });
  if (reason) {
    throw new Error(reason);
  }
  return { path: p, exists: true };
}

/**
 * Plan-then-execute. planInit() performs PURE READS ONLY — no store open, no launcher
 * write, no home creation — so `init --dry-run` can print exactly what would happen while leaving
 * a virgin machine byte-for-byte untouched.
 */
export function planInit(): InitPlan {
  // Observational home validation BEFORE anything is read: the launcher inspection below reads
  // files under the home, and a home that is symlinked at any depth, foreign-owned, or
  // group/world-writable must be REFUSED rather than inspected through. This creates nothing and
  // chmods nothing, so the dry-run's "not one byte written" guarantee holds on the refusal path
  // too — it throws before the first read instead of reporting on an attacker's tree.
  const homeRoot = assertReadOnlySthayiHome();
  const plan = renderLauncher();
  const cliPlan = renderLauncher({ variant: 'cli' });
  const adapters = defaultAdapters();
  const detected = adapters.filter((a) => a.detect());
  return {
    home: sthayiHomeRoot(),
    // The VALIDATOR's own answer, not a second `existsSync` on the path: it returns the canonical
    // root when the home exists and `undefined` when it does not, so "does the home exist" is
    // decided by the check that already refused a symlinked or otherwise hijacked one.
    homeExists: homeRoot !== undefined,
    db: plannedStatePath(dbPath(), 'memory database'),
    key: plannedStatePath(keyPath(), 'vault key'),
    launcher: { path: plan.path, action: launcherAction(plan) },
    cliLauncher: { path: cliPlan.path, action: launcherAction(cliPlan) },
    skillsSample: skillsSamplePlan(),
    clients: detected.map((a) => a.wire({ dryRun: true })),
  };
}

function printInitPlan(plan: InitPlan): void {
  out(`Dry run — would initialize ${plan.home}:`);
  out(`  ${plan.db.exists ? 'keep existing db      ' : 'create db             '}${plan.db.path}`);
  out(`  ${plan.key.exists ? 'keep existing key     ' : 'create key            '}${plan.key.path}`);
  const la = plan.launcher.action;
  out(
    `  ${la === 'unchanged' ? 'keep launcher         ' : la === 'update' ? 'update launcher       ' : 'create launcher       '}${plan.launcher.path}`,
  );
  const ca = plan.cliLauncher.action;
  out(
    `  ${ca === 'unchanged' ? 'keep cli launcher     ' : ca === 'update' ? 'update cli launcher   ' : 'create cli launcher   '}${plan.cliLauncher.path}`,
  );
  out(
    `  ${plan.skillsSample.wouldCreate ? 'create sample skill   ' : 'keep existing skills  '}${plan.skillsSample.path}`,
  );
  out('');
  if (plan.clients.length === 0) {
    out('No supported clients detected. Install one, then run `sthayi wire`.');
    return;
  }
  out('Dry run — would wire:');
  for (const r of plan.clients) {
    printWireResult(r);
  }
  out('');
  out('Nothing was written. Run `sthayi init` to apply.');
}

/**
 * `sthayi init` — the first-run wizard (spec §5).
 *
 * TWO GATES, IN THIS ORDER, BOTH AHEAD OF THE WRITES THEY GUARD.
 *
 * DURABILITY FIRST, because it can be. A CLI entry inside an npm/npx cache or a temp directory
 * cannot be pinned into a launcher — the launcher breaks the moment the cache is pruned — and
 * `renderLauncher` settles that by PURE READS, so it is answerable before anything exists. That
 * refusal is also the whole outcome of an `npx sthayi init`: it names the durable installs to
 * choose from and says to re-run, which is a claim that THIS run achieved nothing. Reached only
 * after the store had been opened, the claim was false — the refusal left behind a home holding
 * `sthayi.db`, the vault `key` and `journal.checkpoint`, a sealed store and a key created for an
 * installation the same message called uninitialized.
 *
 * THE STARTUP-OUTCOME GATE SECOND, because it cannot be first: it reports what OPENING the store
 * committed, so the store must be opened for it to have an answer. `init` is the command that
 * CREATES the store, so it is the one that meets the first-run seal committing while the
 * off-database anchor does not advance — and it is also the command that goes on to write a
 * launcher, seed skills, rewrite client configs and print "Sthayi initialized". Opening with
 * `openStore()` and dropping the outcome made every one of those an initialization write over a
 * store that has stopped accepting writes, announced with a success line describing a machine that
 * is not, in fact, set up. So: nothing after the gate on the blocked path.
 *
 * tests/safety/init-write-ordering.test.ts pins both orderings together.
 */
export async function runInit(opts: { yes?: boolean; dryRun?: boolean } = {}): Promise<void> {
  // The dry-run path returns BEFORE any write — no store open, no writeLauncher,
  // no ensureSkillsDir, no ensureSthayiHome. planInit() carries the same durability refusal
  // (renderLauncher is what it plans through), so a dry run of an npx-shaped install refuses
  // exactly as the real one does rather than describing a write that can never happen.
  if (opts.dryRun) {
    printInitPlan(planInit());
    return;
  }

  // 1. DURABILITY PREFLIGHT — before the store, before the home, before one byte. This is the
  //    PLAN half of the launcher write and throws precisely what `writeLauncher()` below would,
  //    while creating nothing: it reads the filesystem and returns a script body nobody persists.
  renderLauncher();

  // 2. Create the store (~/.sthayi + db + migrations) — and settle what creating it committed.
  //    `undefined` means a startup mutation is durable while the anchor is not: the report is
  //    already printed and the exit code is already 3, and NOTHING further may be initialized.
  const store = openCliStore();
  if (store === undefined) {
    return;
  }
  store.close();
  // 3. The launchers — each pinning the absolute PATHNAME of this install's CLI entry. No version
  //    is recorded and none is compared at launch, so a reinstall at the same prefix is picked up
  //    without a repin, and an entry that MOVES has to be repinned by `wire` run from the new
  //    install's own CLI path.
  const launcher = writeLauncher();
  // 4. Skills dir + sample.
  ensureSkillsDir();
  out(`Sthayi initialized at ${path.dirname(launcher)}/..`);
  out(`Launcher: ${launcher}`);
  const cli = cliLauncherPath();
  out(`CLI launcher: ${cli}`);
  out(
    `  durable \`sthayi\` command — add ${path.dirname(cli)} to your PATH, or invoke it by full path.`,
  );
  out('');

  // 5. Detect clients.
  const adapters = defaultAdapters();
  const detected = adapters.filter((a) => a.detect());
  out(`Detected ${detected.length} of ${adapters.length} clients:`);
  for (const a of adapters) {
    out(
      `  ${statusIcon(a.detect())} ${padEndVisible(a.label, 16)} ${a.detect() ? a.configPath() : '(not installed)'}`,
    );
  }
  out('');

  if (detected.length === 0) {
    out('No supported clients detected. Install one, then run `sthayi wire`.');
    return;
  }

  const go = opts.yes || (await confirm(`Wire all ${detected.length} detected clients? [Enter/n]`));
  if (!go) {
    out(
      'Skipped wiring. Run `sthayi wire` (or `sthayi init --yes` for unattended setup) when ready.',
    );
    return;
  }

  out('Wiring:');
  for (const a of detected) {
    printWireResult(a.wire());
  }

  // 7. Importer offer.
  const archives = scanDownloads();
  if (archives.length > 0) {
    out('');
    out('Found possible exports in ~/Downloads:');
    for (const f of archives) {
      out(`  ${f}`);
    }
    out('Import one with:  sthayi import <path>');
  }

  // 8. Demo card.
  printDemoCard();
}

/** `sthayi wire [--client x] [--dry-run]`. */
export function runWire(opts: { client?: string; dryRun?: boolean } = {}): void {
  const targets = select(defaultAdapters(), opts.client).filter((a) => a.detect());
  if (opts.dryRun) {
    // A dry-run writes NOTHING — not even the launcher. Report the planned action. The home is
    // validated OBSERVATIONALLY first (creates nothing, chmods nothing): the launcher inspection
    // reads through the home, so an untrusted one is refused before that read, not reported on.
    assertReadOnlySthayiHome();
    const plan = renderLauncher();
    const action = launcherAction(plan);
    out(
      `Dry run — launcher ${plan.path}: ${action === 'unchanged' ? 'unchanged' : `would ${action}`}`,
    );
    if (targets.length === 0) {
      out('No detected clients to wire.');
      return;
    }
    out('Dry run — would wire:');
    for (const a of targets) {
      printWireResult(a.wire({ dryRun: true }));
    }
    return;
  }
  writeLauncher();
  if (targets.length === 0) {
    out('No detected clients to wire.');
    return;
  }
  out('Wiring:');
  for (const a of targets) {
    printWireResult(a.wire());
  }
}

/** `sthayi unwire [--client x] [--dry-run]` — the exit right. */
export function runUnwire(opts: { client?: string; dryRun?: boolean } = {}): void {
  // Unwire's restore/delete decisions come from the wiring ledger INSIDE the home, and a real
  // unwire rewrites that ledger. Validate the home observationally up front so a hijacked one is
  // refused before a single ledger byte is read (dry-run included — nothing is created here).
  assertReadOnlySthayiHome();
  const targets = select(defaultAdapters(), opts.client);
  out(opts.dryRun ? 'Dry run — would unwire:' : 'Unwiring:');
  for (const a of targets) {
    printWireResult(a.unwire({ dryRun: opts.dryRun }));
  }
}

/** `sthayi status` — client / detected / wired (yes|no|broken) / config path.
 *  Wiring health is launcher/runtime health, not config syntax alone: a syntactically-wired
 *  client whose launcher is missing, corrupt, hijack-suspect, dangling, or pinned inside a runtime
 *  copy this build no longer maintains is BROKEN — the client will fail to launch sthayi, or will
 *  launch something nothing refreshes. Status and doctor read the
 *  same launcherHealth(), so they always name the same condition. */
export function runStatus(): void {
  // Observational home validation FIRST: status reads the launcher, the wiring ledger and the
  // token probe out of the home, so an untrusted home FAILS CLOSED with an actionable message
  // rather than producing a confident table describing an attacker's tree. Creates nothing,
  // chmods nothing — an absent home is a legitimate "nothing wired yet" state.
  assertReadOnlySthayiHome();
  const adapters = defaultAdapters();
  const lh = launcherHealth();
  out(
    `${padEndVisible('client', 16)}${padEndVisible('detected', 10)}${padEndVisible('wired', 8)}config`,
  );
  for (const a of adapters) {
    const detected = a.detect();
    const inspect = detected ? a.inspect() : undefined;
    let state = inspect?.state ?? 'absent';
    let reason = inspect?.detail;
    if (state === 'wired' && !lh.ok) {
      state = 'broken';
      reason = lh.detail;
    }
    const wiredCell = state === 'wired' ? 'yes' : state === 'broken' ? 'broken' : 'no';
    out(
      padEndVisible(a.label, 16) +
        padEndVisible(detected ? 'yes' : 'no', 10) +
        padEndVisible(wiredCell, 8) +
        a.configPath(),
    );
    if (state === 'broken' && reason) {
      out(`  ↳ ${reason}`);
    }
  }
  // Pending HTTP-token rotation (non-secret; only when a legacy unprefixed token file exists).
  // Rotation happens solely at the next `sthayi serve --http` start — status itself never
  // rotates, and the token value is never printed.
  const tokenWarning = legacyHttpTokenWarning();
  if (tokenWarning !== undefined) {
    out(`⚠ ${tokenWarning}`);
  }
}
