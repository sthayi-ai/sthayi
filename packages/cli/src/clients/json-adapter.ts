import fs from 'node:fs';
import * as jsonc from 'jsonc-parser';
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

export interface JsonAdapterOptions {
  id: string;
  label: string;
  resolveConfigPath: () => string;
  detect: () => boolean;
  launcherCommand: () => string;
  /** top-level object holding server entries (default "mcpServers"; VS Code uses "servers") */
  containerKey?: string;
  /** entry written under <containerKey>.sthayi — default {command, args: []}; clients like
   *  VS Code (type: "stdio") and Cline (disabled/autoApprove) want extra fields */
  entryValue?: (launcherCommand: string) => Record<string, unknown>;
  now?: () => number;
}

const FORMAT: jsonc.FormattingOptions = { insertSpaces: true, tabSize: 2, eol: '\n' };

/**
 * Adapter for clients whose MCP config is JSON with an `mcpServers` object (Claude Desktop, Claude
 * Code, Cursor, Gemini CLI). Edits are surgical via jsonc-parser (preserving unknown keys and
 * formatting); wire backs up first; unwire restores the EXACT prior state (spec §1 invariant 4)
 * while the config is untouched since wire, and removes only the sthayi entry once it has drifted.
 */
export class JsonMcpAdapter implements ClientAdapter {
  private readonly containerKey: string;
  private readonly now: () => number;

  constructor(private readonly opts: JsonAdapterOptions) {
    this.containerKey = opts.containerKey ?? 'mcpServers';
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

  /** The canonical entry wire writes — inspect compares the live entry's command/args to this. */
  private expectedEntry(): Record<string, unknown> {
    return this.opts.entryValue
      ? this.opts.entryValue(this.opts.launcherCommand())
      : { command: this.opts.launcherCommand(), args: [] as string[] };
  }

  inspect(): InspectResult {
    const p = this.configPath();
    let text: string;
    try {
      text = fs.readFileSync(p, 'utf8');
    } catch {
      return { state: 'absent' };
    }
    const parsed = jsonc.parse(text) as Record<string, unknown> | undefined;
    const container =
      parsed && typeof parsed === 'object'
        ? (parsed[this.containerKey] as Record<string, unknown> | undefined)
        : undefined;
    const entry = container && typeof container === 'object' ? container[SERVER_NAME] : undefined;
    if (entry === undefined) {
      return { state: 'absent' };
    }
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { state: 'broken', detail: 'sthayi entry is not an object' };
    }
    const e = entry as Record<string, unknown>;
    const expected = this.expectedEntry();
    const command = typeof e.command === 'string' ? e.command : undefined;
    if (command !== expected.command) {
      return {
        state: 'broken',
        command,
        detail:
          command === undefined
            ? 'sthayi entry has no command'
            : `command is ${JSON.stringify(command)} (expected ${JSON.stringify(expected.command)})`,
      };
    }
    // Missing args means "no args" to every client — canonicalize to [] before comparing.
    const args = e.args === undefined ? [] : e.args;
    if (JSON.stringify(args) !== JSON.stringify(expected.args ?? [])) {
      return {
        state: 'broken',
        command,
        detail: `args are ${JSON.stringify(e.args)} (expected ${JSON.stringify(expected.args ?? [])})`,
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
    const original = existed ? fs.readFileSync(p, 'utf8') : '{}\n';
    let backupPath: string | null = null;
    if (existed) {
      backupPath = createBackup(p, this.now());
    }

    // jsonc.modify REPLACES an existing entry at this path, so the broken-repair case
    // overwrites the bad entry in place — never a duplicate.
    const value = this.expectedEntry();
    const edits = jsonc.modify(original, [this.containerKey, SERVER_NAME], value, {
      formattingOptions: FORMAT,
    });
    const next = jsonc.applyEdits(original, edits);
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
    // Wholesale restore/delete is only safe while the config is EXACTLY what wire wrote — clients
    // rewrite their own configs (Claude Code rewrites ~/.claude.json constantly), and those
    // post-wire changes must survive unwire. A ledger without wireHash predates the drift check.
    const pristine = state?.wireHash !== undefined && contentHash(current) === state.wireHash;

    let message = 'unwired';
    let backupPath: string | undefined;
    if (pristine && state?.existedBefore === false) {
      // We created the file and nothing touched it since — restore the "absent" prior state.
      fs.rmSync(p, { force: true });
    } else if (pristine && state?.backupPath && isRegularFile(state.backupPath)) {
      // Byte-exact restore of the pre-wire config (isRegularFile: a symlink swapped in at the
      // recorded backup path is never followed — treat it as "no backup" and fall through).
      fs.copyFileSync(state.backupPath, p);
    } else {
      // Drifted since wire (or no ledger/backup): remove only the sthayi entry, keep the rest.
      const edits = jsonc.modify(current, [this.containerKey, SERVER_NAME], undefined, {
        formattingOptions: FORMAT,
      });
      atomicWrite(p, jsonc.applyEdits(current, edits));
      if (state?.backupPath && isRegularFile(state.backupPath)) {
        backupPath = state.backupPath;
        message = `unwired (config changed since wire — removed only the sthayi entry; pre-wire backup kept at ${backupPath})`;
      } else if (state) {
        message = 'unwired (config changed since wire — removed only the sthayi entry)';
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
