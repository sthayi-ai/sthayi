import fs from 'node:fs';
import { parse as parseToml } from 'smol-toml';
import {
  type ClientAdapter,
  type InspectResult,
  SERVER_NAME,
  type WireResult,
  atomicWrite,
  contentHash,
  createBackup,
  isRegularFile,
  unsafeConfigPathReason,
} from './adapter.js';
import { clearClientState, getClientState, setClientState } from './state.js';

export interface TomlAdapterOptions {
  id: string;
  label: string;
  resolveConfigPath: () => string;
  detect: () => boolean;
  launcherCommand: () => string;
  now?: () => number;
}

/**
 * Line-based removal of the `[mcp_servers.sthayi]` table (and any `[mcp_servers.sthayi.*]`
 * sub-tables): drop lines from a sthayi table header up to the next table header. Line-based
 * because a character regex cannot use `[` as the terminator — the table body itself contains
 * `args = []`.
 */
/** Does any line open a `[mcp_servers.sthayi]` (or sub-)table? Used to classify unparseable TOML:
 *  a config that names sthayi but does not parse is a BROKEN wiring, not an absent one. */
const STHAYI_TABLE_HEADER = new RegExp(
  `^\\s*\\[\\s*mcp_servers\\.${SERVER_NAME}\\s*(\\]|\\.)`,
  'm',
);

function stripServerTable(text: string): string {
  const anyHeader = /^\s*\[/;
  const sthayiHeader = new RegExp(`^\\s*\\[\\s*mcp_servers\\.${SERVER_NAME}\\s*(\\]|\\.)`);
  const kept: string[] = [];
  let skipping = false;
  for (const line of text.split('\n')) {
    if (anyHeader.test(line)) {
      skipping = sthayiHeader.test(line);
    }
    if (!skipping) {
      kept.push(line);
    }
  }
  return kept.join('\n');
}

/**
 * Post-strip probe: does a sthayi entry STILL exist? Inline (`sthayi = { … }` under
 * `[mcp_servers]`) and dotted (`mcp_servers.sthayi = …`) forms carry no `[mcp_servers.sthayi]`
 * header line, so the line-based stripper cannot remove them — and appending the canonical
 * header table next to them would REDEFINE the key, making the WHOLE config unparseable
 * (spec §1 invariant 4: never corrupt a config). Returns undefined when the text does not parse.
 */
function sthayiStillPresent(text: string): boolean | undefined {
  try {
    const parsed = parseToml(text) as { mcp_servers?: Record<string, unknown> };
    return parsed.mcp_servers?.[SERVER_NAME] !== undefined;
  } catch {
    return undefined;
  }
}

/**
 * Adapter for Codex CLI (`~/.codex/config.toml`, `[mcp_servers.<name>]` tables). wire APPENDS a
 * `[mcp_servers.sthayi]` table (preserving all existing content, comments, and other tables);
 * detection parses via smol-toml; unwire restores the EXACT prior state from the backup while the
 * config is untouched since wire, and strips only the sthayi table once it has drifted.
 */
export class TomlMcpAdapter implements ClientAdapter {
  private readonly now: () => number;

  constructor(private readonly opts: TomlAdapterOptions) {
    this.now = opts.now ?? (() => Date.now());
  }

  get id(): string {
    return this.opts.id;
  }
  get label(): string {
    return this.opts.label;
  }
  configPath(): string {
    return this.opts.resolveConfigPath();
  }
  detect(): boolean {
    return this.opts.detect();
  }

  isWired(): boolean {
    return this.inspect().state === 'wired';
  }

  inspect(): InspectResult {
    const p = this.configPath();
    let text: string;
    try {
      text = fs.readFileSync(p, 'utf8');
    } catch {
      return { state: 'absent' };
    }
    let parsed: { mcp_servers?: Record<string, unknown> };
    try {
      parsed = parseToml(text) as { mcp_servers?: Record<string, unknown> };
    } catch {
      // Unparseable TOML that still CONTAINS a sthayi table header: the client will fail to load
      // this config, so a sthayi wiring exists and is broken — not absent.
      return STHAYI_TABLE_HEADER.test(text)
        ? { state: 'broken', detail: 'config does not parse as TOML' }
        : { state: 'absent' };
    }
    const entry = parsed.mcp_servers?.[SERVER_NAME];
    if (entry === undefined) {
      return { state: 'absent' };
    }
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { state: 'broken', detail: 'sthayi entry is not a table' };
    }
    const e = entry as Record<string, unknown>;
    const expected = this.opts.launcherCommand();
    const command = typeof e.command === 'string' ? e.command : undefined;
    if (command !== expected) {
      return {
        state: 'broken',
        command,
        detail:
          command === undefined
            ? 'sthayi entry has no command'
            : `command is ${JSON.stringify(command)} (expected ${JSON.stringify(expected)})`,
      };
    }
    const args = e.args === undefined ? [] : e.args;
    if (JSON.stringify(args) !== '[]') {
      return {
        state: 'broken',
        command,
        detail: `args are ${JSON.stringify(e.args)} (expected [])`,
      };
    }
    return { state: 'wired', command };
  }

  wire(opts?: { dryRun?: boolean }): WireResult {
    const p = this.configPath();
    // Trust boundary FIRST — before any read, backup, or write. A symlinked config (or a
    // symlinked parent dir) is refused outright: we never write through or replace a symlink.
    const unsafe = unsafeConfigPathReason(p);
    if (unsafe) {
      return this.result({
        changed: false,
        wired: false,
        dryRun: opts?.dryRun ?? false,
        message: `refusing to wire: ${unsafe}`,
      });
    }
    const ins = this.inspect();
    if (ins.state === 'wired') {
      return this.result({ changed: false, wired: true, dryRun: false, message: 'already wired' });
    }
    if (opts?.dryRun) {
      return this.result({
        changed: false,
        wired: false,
        dryRun: true,
        message:
          ins.state === 'broken'
            ? `would repair (${ins.detail ?? 'entry does not match the launcher'})`
            : 'would wire',
      });
    }

    const existed = fs.existsSync(p);
    const original = existed ? fs.readFileSync(p, 'utf8') : '';
    // Broken repair: strip the existing sthayi table first, then append the canonical
    // one — the config must never end up with two `[mcp_servers.sthayi]` tables.
    let base = ins.state === 'broken' ? stripServerTable(original) : original;
    if (ins.state === 'broken') {
      const residual = sthayiStillPresent(base);
      if (residual !== false) {
        // Inline/dotted sthayi entry the stripper cannot remove, or TOML still unparseable after
        // the strip: appending our table would corrupt the whole config. Refuse, write nothing.
        return this.result({
          changed: false,
          wired: false,
          dryRun: false,
          message:
            residual === true
              ? `refusing to repair: ${p} declares sthayi as an inline or dotted entry that cannot be removed safely — remove the sthayi entry under [mcp_servers] by hand, then re-run \`sthayi wire\``
              : `refusing to repair: ${p} does not parse as TOML even without the sthayi table — fix the file by hand, then re-run \`sthayi wire\``,
        });
      }
    }
    if (base.length > 0 && !base.endsWith('\n')) {
      base += '\n';
    }

    const command = JSON.stringify(this.opts.launcherCommand()); // valid TOML basic string
    const block = `\n[mcp_servers.${SERVER_NAME}]\ncommand = ${command}\nargs = []\nenabled = true\n`;
    const next = base + block;
    // Config-safety net (spec §1 invariant 4): never write a config the client cannot parse (e.g. a root-level
    // inline `mcp_servers = { … }` table that the appended header table would redefine).
    try {
      parseToml(next);
    } catch {
      return this.result({
        changed: false,
        wired: false,
        dryRun: false,
        message: `refusing to wire: adding the [mcp_servers.${SERVER_NAME}] table would make ${p} invalid TOML (an existing mcp_servers declaration conflicts with table form) — add the sthayi entry by hand, or convert mcp_servers to \`[mcp_servers.<name>]\` tables and re-run \`sthayi wire\``,
      });
    }
    let backupPath: string | null = null;
    if (existed) {
      backupPath = createBackup(p, this.now());
    }
    atomicWrite(p, next);
    setClientState(this.id, {
      backupPath,
      existedBefore: existed,
      wiredAt: this.now(),
      wireHash: contentHash(next),
    });
    return this.result({
      changed: true,
      wired: true,
      dryRun: false,
      message: ins.state === 'broken' ? 'repaired' : 'wired',
      backupPath: backupPath ?? undefined,
    });
  }

  unwire(opts?: { dryRun?: boolean }): WireResult {
    const p = this.configPath();
    // Same trust boundary as wire, before any read or mutation: unwire restores, deletes, or
    // rewrites the target — none of which may ever act through a symlink.
    const unsafe = unsafeConfigPathReason(p);
    if (unsafe) {
      return this.result({
        changed: false,
        wired: true,
        dryRun: opts?.dryRun ?? false,
        message: `refusing to unwire: ${unsafe}`,
      });
    }
    // Gate on 'absent', not 'wired': a broken entry must still be removable.
    if (this.inspect().state === 'absent') {
      return this.result({ changed: false, wired: false, dryRun: false, message: 'not wired' });
    }
    if (opts?.dryRun) {
      return this.result({ changed: false, wired: true, dryRun: true, message: 'would unwire' });
    }

    const state = getClientState(this.id);
    const current = fs.readFileSync(p, 'utf8');
    // Wholesale restore/delete is only safe while the config is EXACTLY what wire wrote; any
    // post-wire edit must survive unwire. A ledger without wireHash predates the drift check.
    const pristine = state?.wireHash !== undefined && contentHash(current) === state.wireHash;

    let message = 'unwired';
    let backupPath: string | undefined;
    if (pristine && state?.existedBefore === false) {
      fs.rmSync(p, { force: true });
    } else if (pristine && state?.backupPath && isRegularFile(state.backupPath)) {
      // isRegularFile: a symlink swapped in at the recorded backup path is never followed.
      fs.copyFileSync(state.backupPath, p);
    } else {
      // Drifted since wire (or no ledger/backup): strip only the sthayi table, keep the rest.
      const stripped = stripServerTable(current);
      if (sthayiStillPresent(stripped) !== false) {
        // The stripper could not remove it (inline/dotted entry, or the TOML does not parse
        // without the sthayi table): writing would either report success while removing nothing
        // or corrupt the file. Refuse, write nothing, keep the ledger (spec §1 invariant 4).
        return this.result({
          changed: false,
          wired: true,
          dryRun: false,
          message: `cannot unwire: ${p} declares sthayi in a form the surgical remover cannot handle safely (inline or dotted entry, or unparseable TOML) — remove the sthayi entry under [mcp_servers] by hand`,
        });
      }
      atomicWrite(p, stripped);
      if (state?.backupPath && isRegularFile(state.backupPath)) {
        backupPath = state.backupPath;
        message = `unwired (config changed since wire — removed only the sthayi table; pre-wire backup kept at ${backupPath})`;
      } else if (state) {
        message = 'unwired (config changed since wire — removed only the sthayi table)';
      }
    }
    clearClientState(this.id);
    return this.result({ changed: true, wired: false, dryRun: false, message, backupPath });
  }

  private result(
    partial: Pick<WireResult, 'changed' | 'wired' | 'dryRun' | 'message'> &
      Partial<Pick<WireResult, 'backupPath'>>,
  ): WireResult {
    return {
      id: this.id,
      label: this.label,
      configPath: this.configPath(),
      detected: this.detect(),
      ...partial,
    };
  }
}
