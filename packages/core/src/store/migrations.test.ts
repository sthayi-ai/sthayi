import { MIGRATIONS, latestVersion, pendingMigrations } from '@sthayi/core';
import { describe, expect, it } from 'vitest';

describe('migrations', () => {
  it('has strictly increasing, gap-free versions starting at 1', () => {
    const versions = MIGRATIONS.map((m) => m.version);
    expect(versions).toEqual(versions.map((_, i) => i + 1));
  });

  it('latestVersion matches the highest migration', () => {
    expect(latestVersion()).toBe(MIGRATIONS[MIGRATIONS.length - 1]?.version);
  });

  it('pendingMigrations returns all migrations from a fresh (0) store', () => {
    expect(pendingMigrations(0)).toHaveLength(MIGRATIONS.length);
  });

  it('pendingMigrations returns nothing once at the latest version', () => {
    expect(pendingMigrations(latestVersion())).toHaveLength(0);
  });

  it('pendingMigrations is ordered by version', () => {
    const pending = pendingMigrations(0).map((m) => m.version);
    expect(pending).toEqual([...pending].sort((a, b) => a - b));
  });
});
