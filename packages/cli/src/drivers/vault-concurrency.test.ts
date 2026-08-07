import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VaultService } from '@sthayi/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runTempDir } from '../../../../tests/helpers/run-temp.js';
import { NodeCrypto } from './crypto.js';
import { SqliteDriver } from './sqlite.js';

/**
 * INVARIANT: the DATABASE, not process memory, is the pseudonym allocation authority.
 * Two VaultServices over separate driver connections model two long-lived MCP processes sharing
 * one store — a stale per-process cache alone breaks allocation here; no concurrency required.
 */
describe('vault allocation across processes', () => {
  let dir: string;
  let dbFile: string;
  let keyFile: string;

  const openProcess = () => {
    const driver = SqliteDriver.open(dbFile);
    driver.migrate();
    const crypto = NodeCrypto.open(keyFile);
    return { driver, vault: new VaultService(driver, crypto) };
  };

  beforeEach(() => {
    // realpath, like every other fixture here: os.tmpdir() is itself reached through a symlink on
    // macOS (/var -> private/var), and the drivers validate the WHOLE ancestor chain of the db and
    // the key before creating or reading anything. A canonical temp dir is the honest fixture;
    // hostile tests plant their own symlinks explicitly.
    dir = runTempDir('sthayi-vault-');
    dbFile = path.join(dir, 'sthayi.db');
    keyFile = path.join(dir, 'key');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('two warmed processes allocate different secrets without colliding', () => {
    const a = openProcess();
    const b = openProcess();
    // Both processes warm their cache on the same seeded secret (count = 1 each).
    expect(a.vault.allocate('APIKEY', 'sk-first')).toBe('APIKEY_01');
    expect(b.vault.allocate('APIKEY', 'sk-first')).toBe('APIKEY_01');
    // A mints the next pseudonym…
    expect(a.vault.allocate('APIKEY', 'sk-second')).toBe('APIKEY_02');
    // …and B, whose cache still says count 1, must NOT collide on APIKEY_02.
    expect(b.vault.allocate('APIKEY', 'sk-third')).toBe('APIKEY_03');
    expect(a.driver.listEntities('APIKEY')).toHaveLength(3);
    a.driver.close();
    b.driver.close();
  });

  it('the same canonical from a stale process resolves to the existing pseudonym', () => {
    const a = openProcess();
    const b = openProcess();
    expect(a.vault.allocate('APIKEY', 'sk-first')).toBe('APIKEY_01');
    b.vault.allocate('APIKEY', 'sk-warm'); // warms B's cache without seeing sk-shared
    expect(a.vault.allocate('APIKEY', 'sk-shared')).toBe('APIKEY_03');
    // B has never seen sk-shared: it must find A's row, not mint a duplicate canonical.
    expect(b.vault.allocate('APIKEY', 'sk-shared')).toBe('APIKEY_03');
    expect(a.driver.listEntities('APIKEY')).toHaveLength(3);
    a.driver.close();
    b.driver.close();
  });

  it('restart decrypts every mapping minted by either process', () => {
    const a = openProcess();
    const b = openProcess();
    a.vault.allocate('APIKEY', 'sk-first');
    b.vault.allocate('EMAIL', 'user@example.com');
    a.driver.close();
    b.driver.close();

    const restarted = openProcess();
    const mappings = restarted.vault.listMappings();
    expect(mappings).toContainEqual(
      expect.objectContaining({ kind: 'APIKEY', pseudonym: 'APIKEY_01', value: 'sk-first' }),
    );
    expect(mappings).toContainEqual(
      expect.objectContaining({ kind: 'EMAIL', pseudonym: 'EMAIL_01', value: 'user@example.com' }),
    );
    restarted.driver.close();
  });

  it('a failed containing write leaves no orphan entity and no phantom cache entry', () => {
    const p = openProcess();
    expect(() =>
      p.driver.writeTransaction(() => {
        p.vault.allocate('APIKEY', 'sk-doomed');
        throw new Error('containing write failed');
      }),
    ).toThrow('containing write failed');
    // The entity insert rolled back with the containing transaction…
    expect(p.driver.listEntities('APIKEY')).toHaveLength(0);
    // …and the cache did not keep a phantom mapping: a retry re-mints and persists for real.
    expect(p.vault.allocate('APIKEY', 'sk-doomed')).toBe('APIKEY_01');
    expect(p.driver.listEntities('APIKEY')).toHaveLength(1);
    p.driver.close();
  });

  // Allocation × masking composition: maskSecrets mints AND re-allocates (its warnings loop)
  // inside the caller's write transaction. A re-allocate that rebuilt the instance cache FROM
  // INSIDE the open transaction would cache the uncommitted mint, so a rollback leaves a phantom
  // pseudonym: a retried write of the same secret returns a pseudonym with ZERO entity rows
  // (unrecoverable mapping), and the next different secret re-derives counts from the empty
  // table and collides on the same pseudonym number.
  it('a rolled-back maskSecrets leaves no phantom cache: the retry mints a REAL row', () => {
    const p = openProcess();
    const secret = `sk-${'D'.repeat(24)}`;
    expect(() =>
      p.driver.writeTransaction(() => {
        const masked = p.vault.maskSecrets(`token ${secret}`);
        expect(masked.masked).not.toContain(secret); // masking itself worked in-transaction
        throw new Error('containing write failed');
      }),
    ).toThrow('containing write failed');
    // rollback: no entity row survived…
    expect(p.driver.listEntities()).toHaveLength(0);

    // …and the retry MINTS A REAL ROW (a phantom pseudonym would leave zero rows behind).
    const retry = p.vault.maskSecrets(`token ${secret}`);
    const entities = p.driver.listEntities('APIKEY');
    expect(entities).toHaveLength(1);
    expect(retry.masked).toContain(entities[0]?.pseudonym as string);
    expect(retry.masked).not.toContain(secret);

    // a DIFFERENT secret can never share the pseudonym identity
    const other = p.vault.maskSecrets(`token sk-${'E'.repeat(24)}`);
    const all = p.driver.listEntities('APIKEY');
    expect(all).toHaveLength(2);
    expect(new Set(all.map((e) => e.pseudonym)).size).toBe(2);
    expect(other.masked).not.toContain(entities[0]?.pseudonym as string);
    p.driver.close();
  });
});
