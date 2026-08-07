import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NodeCrypto } from '../../packages/cli/src/drivers/crypto.js';
import { SqliteDriver } from '../../packages/cli/src/drivers/sqlite.js';
import { ensureBuiltCli } from '../helpers/build-cli.js';
import { removeOwned } from '../helpers/owned-fs.js';
import { runTempDir } from '../helpers/run-temp.js';

/**
 * SAFETY: shared-store reliability across real processes. Spawns the BUILT
 * CLI several times at once against one fresh STHAYI_HOME — the exact shapes concurrency breaks
 * on: first-run migration races crashing the loser, `database is locked` losing writes, and stale
 * per-process vault counters colliding on `entities.pseudonym`. Requires `pnpm build`
 * (same as keyless-matrix): the dist under test must include the current source.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const distEntry = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');

/** Detector-valid synthetic secrets (same family as vault-secrets CANARY) — never real keys. */
const fakeKey = (i: number) => `sk-proj-MPWRITE${String(i).padStart(2, '0')}${'a'.repeat(24)}`;

interface RunResult {
  status: number | null;
  out: string;
}

function runCli(home: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [distEntry, ...args], {
      env: { ...process.env, STHAYI_HOME: home },
      cwd: os.tmpdir(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      out += d.toString();
    });
    child.on('close', (status) => resolve({ status, out }));
  });
}

describe('safety: concurrent multi-process writes on one store', () => {
  let home: string;

  beforeAll(() => {
    // Shared build-once lock: guarantees the dist exists AND is not being rebuilt by another
    // safety file (keyless-matrix) while these children are spawned. See helpers/build-cli.
    ensureBuiltCli();
  }, 300_000);

  beforeEach(() => {
    // realpath: os.tmpdir() is reached through /var -> private/var on macOS, and a STHAYI_HOME
    // reached through any symlink is refused — homes are named by their canonical real path.
    home = runTempDir('sthayi-mp-');
  });

  afterEach(() => {
    removeOwned(home);
  });

  const expectAllSucceeded = (results: RunResult[]) => {
    for (const r of results) {
      expect(r.status, `a concurrent write failed:\n${r.out}`).toBe(0);
    }
  };

  it('3 simultaneous first writes (distinct secrets) all land, with distinct pseudonyms', async () => {
    const results = await Promise.all(
      [0, 1, 2].map((i) => runCli(home, ['add', `note ${i} key ${fakeKey(i)}`])),
    );
    expectAllSucceeded(results);

    const verify = await runCli(home, ['journal', '--verify']);
    expect(verify.status, verify.out).toBe(0);

    const driver = SqliteDriver.open(path.join(home, 'sthayi.db'));
    try {
      expect(driver.countMemories()).toBe(3);
      const entities = driver.listEntities('APIKEY');
      expect(entities).toHaveLength(3);
      expect(new Set(entities.map((e) => e.pseudonym)).size).toBe(3);
      // Every canonical is decryptable after the dust settles (no key-race orphans).
      const crypto = NodeCrypto.open(path.join(home, 'key'));
      const values = entities.map((e) => (e.valueEnc ? crypto.decrypt(e.valueEnc) : ''));
      expect(new Set(values).size).toBe(3);
    } finally {
      driver.close();
    }
  }, 60_000);

  it('14 simultaneous first writes all land exactly once', async () => {
    const results = await Promise.all(
      Array.from({ length: 14 }, (_, i) => runCli(home, ['add', `burst note ${i}`])),
    );
    expectAllSucceeded(results);

    const verify = await runCli(home, ['journal', '--verify']);
    expect(verify.status, verify.out).toBe(0);

    const driver = SqliteDriver.open(path.join(home, 'sthayi.db'));
    try {
      expect(driver.countMemories()).toBe(14);
    } finally {
      driver.close();
    }
  }, 120_000);

  it('the same secret written by 3 processes maps to exactly one pseudonym', async () => {
    const shared = fakeKey(99);
    const results = await Promise.all(
      [0, 1, 2].map((i) => runCli(home, ['add', `proc ${i} shares ${shared}`])),
    );
    expectAllSucceeded(results);

    const driver = SqliteDriver.open(path.join(home, 'sthayi.db'));
    try {
      const entities = driver.listEntities('APIKEY');
      expect(entities).toHaveLength(1);
      expect(entities[0]?.pseudonym).toBe('APIKEY_01');
      for (const m of driver.listMemories()) {
        expect(m.content).toContain('APIKEY_01');
        expect(m.content).not.toContain(shared);
      }
    } finally {
      driver.close();
    }
  }, 60_000);
});
