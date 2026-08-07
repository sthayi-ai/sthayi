import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PII_REMASK_META_KEY } from '../../packages/cli/src/store.js';
import { ensureBuiltCli } from '../helpers/build-cli.js';
import { removeOwned } from '../helpers/owned-fs.js';
import { runTempDir } from '../helpers/run-temp.js';

/**
 * SAFETY: a server SETTLES the startup gate before it creates anything a server owns.
 *
 * THE HAZARD. Both MCP transports refuse to serve a store whose startup COMMITTED while the
 * off-database anchor did not advance — the store has stopped accepting writes, and a model handed
 * one would write into refusals while every tool result still read clean. The refusal is only
 * honest if it is also complete: a transport that seeds the assistant-facing skills tree, mints a
 * bearer token, or opens a listener BEFORE the gate is evaluated has performed a server's
 * initialization on a machine it is simultaneously telling the operator no server ran on. The
 * skills sample is the sharpest case — it is prompt-time instructions to the model about a store
 * that cannot accept a single memory_write.
 *
 * THE INVARIANT. `openServerStore()` is the FIRST thing either transport does. Skills, the HTTP
 * token, the listener and every "server starting" log line come after it, so a blocked startup
 * leaves the home exactly as the store open found it.
 *
 * STDOUT stays untouched for stdio, where it is the JSON-RPC channel: the refusal goes to the file
 * log (the only channel a stdio server owns) and to STDERR, rendered by the CLI layer, at exit 3.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const distEntry = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');

/** The exit code reserved for committed-but-unanchored (packages/cli/src/index.ts). */
const EXIT_COMMITTED_UNANCHORED = 3;

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function homeEnv(home: string): NodeJS.ProcessEnv {
  return { ...process.env, STHAYI_HOME: home, HOME: home };
}

/** Run to completion with stdin already at EOF — a stdio server started this way connects and
 *  then shuts down on the closed transport, so the success path terminates on its own. */
function runCli(home: string, args: string[]): RunResult {
  const r = spawnSync(process.execPath, [distEntry, ...args], {
    env: homeEnv(home),
    cwd: home,
    encoding: 'utf8',
    timeout: 60_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Jam every checkpoint replacement in `home`, permanently and deterministically. */
function jam(home: string): void {
  fs.mkdirSync(path.join(home, 'journal.checkpoint.lock'), { recursive: true });
}

/** What a LEGACY unmasked build left behind: plaintext PII in a memory row, marker cleared. The
 *  next open remasks and journals it — the second startup mutation that can commit unanchored. */
function makeLegacy(home: string): void {
  const db = new Database(path.join(home, 'sthayi.db'));
  try {
    const row = db.prepare('SELECT id FROM memories LIMIT 1').get() as { id: string };
    db.prepare('UPDATE memories SET content = ? WHERE id = ?').run(
      'email me at legacy.pii@example-leak.io about the launch',
      row.id,
    );
    db.prepare('DELETE FROM meta WHERE k = ?').run(PII_REMASK_META_KEY);
  } finally {
    db.close();
  }
}

/** All three facts a durable-but-unanchored report must state. */
function expectDegradedText(text: string, label: string): void {
  expect(text, label).toMatch(/DEGRADED/);
  expect(text, label).toMatch(/COMMITTED/);
  expect(text, label).toMatch(/DO NOT RETRY/);
  expect(text, label).toMatch(/Further writes are BLOCKED/);
  expect(text, label).toMatch(/journal reseal/);
}

/** Every artifact a SERVER owns — none of which may exist after a refusal to serve. */
function expectNoServerArtifacts(home: string, label: string): void {
  // the assistant-facing skills tree, and the sample the seeding writes into it
  expect(fs.existsSync(path.join(home, 'skills')), `${label}: skills dir`).toBe(false);
  expect(
    fs.existsSync(path.join(home, 'skills', 'using-sthayi-memory', 'SKILL.md')),
    `${label}: skills sample`,
  ).toBe(false);
  // the HTTP transport's bearer credential
  expect(fs.existsSync(path.join(home, 'http-token')), `${label}: http token`).toBe(false);
  // the launchers `init` writes — a serve refusal has no business creating them either
  expect(fs.existsSync(path.join(home, 'bin')), `${label}: launcher dir`).toBe(false);
  // NO log line attributable to a server that started. The refusal itself IS logged, and that is
  // the point: it is written after the gate settled, and the file log is the only channel a stdio
  // server owns.
  const logFile = path.join(home, 'logs', 'mcp.log');
  if (fs.existsSync(logFile)) {
    const log = fs.readFileSync(logFile, 'utf8');
    expect(log, `${label}: refusal logged`).toMatch(/REFUSING TO SERVE/);
    expect(log, `${label}: no start line`).not.toMatch(/server start(ing|ed)/i);
    expect(log, `${label}: no connect line`).not.toMatch(/serving tools/i);
  }
}

/** Wait for `ready(text)` to hold over the child's accumulated stdout, or fail with what it said. */
async function waitForLine(
  child: ChildProcess,
  seen: { out: string; err: string; exited: boolean },
  ready: (out: string) => boolean,
  what: string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!ready(seen.out)) {
    if (seen.exited) {
      throw new Error(`child exited before ${what}\nstdout: ${seen.out}\nstderr: ${seen.err}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}\nstdout: ${seen.out}\nstderr: ${seen.err}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** A port the OS just handed out and nothing holds — `--port 0` means the 3737 default here, so a
 *  live HTTP control has to name one. A collision surfaces as a loud bind error from the child,
 *  never as a silently skipped assertion. */
async function freePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', resolve);
  });
  const addr = srv.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

describe('safety: MCP transports settle the startup gate before creating any server artifact', () => {
  const homes: string[] = [];
  beforeAll(() => {
    ensureBuiltCli();
  }, 300_000);
  afterEach(() => {
    for (const h of homes.splice(0)) {
      removeOwned(path.join(h, 'journal.checkpoint.lock'));
      removeOwned(h);
    }
  });

  function freshHome(prefix: string): string {
    const home = runTempDir(prefix);
    homes.push(home);
    return home;
  }

  /** A jammed FIRST RUN: the seal commits into the database and the anchor never follows. */
  function jammedFirstRun(prefix: string): string {
    const home = freshHome(prefix);
    jam(home); // jammed BEFORE the store has ever been opened
    return home;
  }

  /** A jammed LEGACY store: the PII remask commits and the anchor never follows. Seeding uses
   *  `add`, which creates no server artifact — so anything found afterwards came from `serve`. */
  function jammedLegacy(prefix: string): string {
    const home = freshHome(prefix);
    expect(runCli(home, ['add', 'a placeholder fact']).status).toBe(0);
    makeLegacy(home);
    jam(home);
    expect(fs.existsSync(path.join(home, 'skills'))).toBe(false);
    return home;
  }

  for (const [name, make] of [
    ['first-run seal', jammedFirstRun],
    ['PII migration', jammedLegacy],
  ] as const) {
    it(`stdio: ${name} blocked — exit 3, stdout untouched, and NOTHING a server owns is created`, () => {
      const home = make(`sthayi-mcpart-stdio-${name.split(' ')[0]}-`);
      const r = runCli(home, ['serve']);
      const label = `${name}\n${r.stdout}\n---\n${r.stderr}`;
      expect(r.status, label).toBe(EXIT_COMMITTED_UNANCHORED);
      // stdout is the JSON-RPC channel: a client must never find a report where a frame belongs,
      // so the refusal travels on stderr (CLI layer) and in ~/.sthayi/logs/mcp.log.
      expect(r.stdout, label).toBe('');
      expectDegradedText(r.stderr, label);
      expect(r.stderr, label).toMatch(/This command did NOT run/);
      expectNoServerArtifacts(home, `stdio/${name}`);
    });

    it(`http: ${name} blocked — exit 3, no token, no listener, and no skills seeded`, () => {
      const home = make(`sthayi-mcpart-http-${name.split(' ')[0]}-`);
      const r = runCli(home, ['serve', '--http', '--port', '0']);
      const label = `${name}\n${r.stdout}\n---\n${r.stderr}`;
      expect(r.status, label).toBe(EXIT_COMMITTED_UNANCHORED);
      expect(r.stdout, label).toBe('');
      expectDegradedText(r.stderr, label);
      expect(r.stderr, label).toMatch(/This command did NOT run/);
      // The endpoint line is the CLI's only claim that something is listening, and the process has
      // exited — so no socket outlives this assertion either.
      expect(r.stdout, label).not.toMatch(/MCP endpoint listening/);
      expectNoServerArtifacts(home, `http/${name}`);
    });
  }

  it('stdio CONTROL: an unjammed store DOES seed the skills sample and exits 0', () => {
    // The gate is an ORDERING, not a deletion: the seeding still happens on the path that serves.
    const home = freshHome('sthayi-mcpart-stdio-ok-');
    const r = runCli(home, ['serve']);
    const label = `${r.stdout}\n---\n${r.stderr}`;
    expect(r.status, label).toBe(0);
    expect(r.stdout, label).toBe('');
    expect(fs.existsSync(path.join(home, 'skills', 'using-sthayi-memory', 'SKILL.md')), label).toBe(
      true,
    );
    const log = fs.readFileSync(path.join(home, 'logs', 'mcp.log'), 'utf8');
    expect(log, label).toMatch(/serving tools/);
    expect(log, label).not.toMatch(/REFUSING TO SERVE/);
  });

  it('http CONTROL: an unjammed store listens, seeds the skills sample and mints the token', async () => {
    const home = freshHome('sthayi-mcpart-http-ok-');
    const port = await freePort();
    const child = spawn(process.execPath, [distEntry, 'serve', '--http', '--port', String(port)], {
      env: homeEnv(home),
      cwd: home,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const seen = { out: '', err: '', exited: false };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (c: string) => {
      seen.out += c;
    });
    child.stderr?.on('data', (c: string) => {
      seen.err += c;
    });
    const exited = new Promise<void>((resolve) =>
      child.once('exit', () => {
        seen.exited = true;
        resolve();
      }),
    );
    try {
      await waitForLine(child, seen, (o) => /MCP endpoint listening/.test(o), 'the endpoint line');
      expect(seen.out).toContain(`http://127.0.0.1:${port}/mcp`);
      expect(fs.existsSync(path.join(home, 'skills', 'using-sthayi-memory', 'SKILL.md'))).toBe(
        true,
      );
      expect(fs.existsSync(path.join(home, 'http-token'))).toBe(true);
    } finally {
      child.kill('SIGTERM');
      await exited;
    }
  }, 60_000);
});
