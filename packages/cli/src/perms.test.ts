import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeHome, createFakeHome } from '../../../tests/helpers/fake-home.js';
import { runDoctor } from './doctor.js';
import { SqliteDriver } from './drivers/sqlite.js';
import { dbPath, ensureSthayiHome, sthayiHome } from './paths.js';
import { openStore } from './store.js';

const posix = process.platform !== 'win32';

function mode(p: string): number {
  return fs.statSync(p).mode & 0o777;
}

describe.skipIf(!posix)('owner-only permissions on the home + store', () => {
  let home: FakeHome;
  beforeEach(() => {
    home = createFakeHome();
  });
  afterEach(() => home.cleanup());

  it('openStore leaves ~/.sthayi 0700 and the db (incl. WAL sidecars) 0600', () => {
    const store = openStore();
    try {
      expect(mode(sthayiHome())).toBe(0o700);
      expect(mode(dbPath())).toBe(0o600);
      // SQLite copies the db file's mode onto -wal; prove the chmod happened before the pragma.
      expect(mode(`${dbPath()}-wal`) & 0o077).toBe(0);
    } finally {
      store.close();
    }
  });

  it('tightens a legacy loose home (0755) and db (0644) on next open', () => {
    fs.chmodSync(home.home, 0o755);
    const first = openStore();
    first.close();
    fs.chmodSync(dbPath(), 0o644);

    const store = openStore();
    store.close();
    expect(mode(sthayiHome())).toBe(0o700);
    expect(mode(dbPath())).toBe(0o600);
  });

  it('ensureSthayiHome creates a fresh home 0700', () => {
    fs.rmSync(home.home, { recursive: true, force: true });
    ensureSthayiHome();
    expect(mode(sthayiHome())).toBe(0o700);
  });

  it('SqliteDriver.open chmods an arbitrary db file to 0600', () => {
    const file = home.path('sub', 'x.db');
    SqliteDriver.open(file).close();
    expect(mode(file)).toBe(0o600);
  });

  it('doctor reports Home permissions + Store file permissions green on a healthy store', () => {
    openStore().close();
    const checks = runDoctor();
    const homeCheck = checks.find((c) => c.name === 'Home permissions');
    const dbCheck = checks.find((c) => c.name === 'Store file permissions');
    expect(homeCheck?.ok).toBe(true);
    expect(dbCheck?.ok).toBe(true);
  });
});
