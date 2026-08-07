import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeHome, createFakeHome } from '../../../../tests/helpers/fake-home.js';
import {
  type ClientState,
  clearClientState,
  getClientState,
  readState,
  setClientState,
} from './state.js';

const STATE: ClientState = {
  backupPath: '/tmp/backup.json',
  existedBefore: true,
  wiredAt: 1_700_000_000_000,
  wireHash: 'abc123',
};

describe('clients-state.json ledger (hardened read/write)', () => {
  let home: FakeHome;
  beforeEach(() => {
    home = createFakeHome();
  });
  afterEach(() => home.cleanup());

  it('round-trips: set → get → clear, with byte-exact stable JSON on disk', () => {
    expect(readState()).toEqual({});
    setClientState('cursor', STATE);
    expect(getClientState('cursor')).toEqual(STATE);
    // byte-exact ledger shape (2-space JSON + trailing newline) — the legacy format
    expect(fs.readFileSync(home.path('clients-state.json'), 'utf8')).toBe(
      `${JSON.stringify({ cursor: STATE }, null, 2)}\n`,
    );
    clearClientState('cursor');
    expect(getClientState('cursor')).toBeUndefined();
    expect(fs.readFileSync(home.path('clients-state.json'), 'utf8')).toBe('{}\n');
  });

  it('absent ledger reads as {} and clearing a missing id writes nothing', () => {
    expect(readState()).toEqual({});
    clearClientState('nope');
    expect(fs.existsSync(home.path('clients-state.json'))).toBe(false);
  });

  it('an unparseable ledger degrades to {} (adapters fall back to surgical removal)', () => {
    fs.mkdirSync(home.path(), { recursive: true });
    fs.writeFileSync(home.path('clients-state.json'), 'not json{', { mode: 0o600 });
    expect(readState()).toEqual({});
  });

  it.skipIf(process.platform === 'win32')(
    'a new ledger is created 0600; writes leave no temp debris',
    () => {
      setClientState('cursor', STATE);
      expect(fs.lstatSync(home.path('clients-state.json')).mode & 0o777).toBe(0o600);
      const debris = fs.readdirSync(home.home).filter((f) => f.includes('.sthayi-tmp'));
      expect(debris).toEqual([]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'a SYMLINKED ledger fails closed on read AND write — the external target is never touched',
    () => {
      const victim = home.path('victim.json');
      fs.writeFileSync(victim, '{"planted": true}', { mode: 0o600 });
      fs.symlinkSync(victim, home.path('clients-state.json'));
      expect(() => readState()).toThrow(/symlink/);
      expect(() => setClientState('cursor', STATE)).toThrow(/symlink/);
      expect(() => clearClientState('cursor')).toThrow(/symlink/);
      expect(fs.lstatSync(home.path('clients-state.json')).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(victim, 'utf8')).toBe('{"planted": true}');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'a HARD-LINKED ledger (nlink > 1) fails closed on read and write',
    () => {
      const victim = home.path('victim.json');
      fs.writeFileSync(victim, '{}', { mode: 0o600 });
      fs.linkSync(victim, home.path('clients-state.json'));
      expect(() => readState()).toThrow(/hard links/);
      expect(() => setClientState('cursor', STATE)).toThrow(/hard links/);
      expect(fs.readFileSync(victim, 'utf8')).toBe('{}');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'a group/world-writable ledger fails closed with an actionable chmod message',
    () => {
      fs.mkdirSync(home.path(), { recursive: true });
      fs.writeFileSync(home.path('clients-state.json'), '{}');
      fs.chmodSync(home.path('clients-state.json'), 0o666); // writeFileSync mode is umask-filtered
      expect(() => readState()).toThrow(/chmod 600/);
    },
  );

  it('an existing healthy ledger keeps its permission bits through a rewrite', () => {
    setClientState('a', STATE);
    if (process.platform !== 'win32') {
      fs.chmodSync(home.path('clients-state.json'), 0o644);
    }
    setClientState('b', STATE);
    expect(readState()).toEqual({ a: STATE, b: STATE });
    if (process.platform !== 'win32') {
      expect(fs.lstatSync(home.path('clients-state.json')).mode & 0o777).toBe(0o644);
    }
  });
});
