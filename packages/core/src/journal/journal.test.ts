import type { JournalRecord } from '@sthayi/core';
import { JournalService, computeHash, sealEntry, verifyChain } from '@sthayi/core';
import { describe, expect, it } from 'vitest';
import { FakeStore } from '../../../../tests/helpers/fake-store.js';

describe('journal hash chain', () => {
  it('seals an entry with a hash derived from prevHash + fields', () => {
    const sealed = sealEntry(
      { ts: 1, actor: 'cli', op: 'memory_write', payload: { id: 'x' } },
      null,
    );
    expect(sealed.prevHash).toBeNull();
    expect(sealed.hash).toBe(
      computeHash({ ts: 1, actor: 'cli', op: 'memory_write', payload: { id: 'x' } }, null),
    );
  });

  it('the same payload with reordered keys produces the same hash', () => {
    const h1 = computeHash({ ts: 1, actor: 'cli', op: 'o', payload: { a: 1, b: 2 } }, null);
    const h2 = computeHash({ ts: 1, actor: 'cli', op: 'o', payload: { b: 2, a: 1 } }, null);
    expect(h1).toBe(h2);
  });

  it('appends a valid, verifiable chain through the service', () => {
    const store = new FakeStore();
    const journal = new JournalService(store);
    const first = journal.append({ ts: 10, actor: 'cli', op: 'a', payload: { n: 1 } }).record;
    const second = journal.append({ ts: 20, actor: 'cli', op: 'b', payload: { n: 2 } }).record;
    const third = journal.append({ ts: 30, actor: 'mcp:test', op: 'c', payload: { n: 3 } }).record;

    expect(first.prevHash).toBeNull();
    expect(second.prevHash).toBe(first.hash);
    expect(third.prevHash).toBe(second.hash);

    const result = journal.verify();
    expect(result.ok).toBe(true);
    expect(result.length).toBe(3);
  });

  it('detects a tampered payload (hash mismatch)', () => {
    const store = new FakeStore();
    const journal = new JournalService(store);
    journal.append({ ts: 1, actor: 'cli', op: 'a', payload: { n: 1 } });
    journal.append({ ts: 2, actor: 'cli', op: 'b', payload: { secret: 'keep' } });
    journal.append({ ts: 3, actor: 'cli', op: 'c', payload: { n: 3 } });

    // Tamper: mutate entry 2's payload in place (hash left unchanged).
    const rows = store.allJournal();
    const target = rows[1] as JournalRecord;
    (target.payload as { secret: string }).secret = 'leaked';

    const result = verifyChain(rows);
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(2);
    expect(result.reason).toMatch(/tampered/);
  });

  it('detects a broken link (removed entry)', () => {
    const store = new FakeStore();
    const journal = new JournalService(store);
    journal.append({ ts: 1, actor: 'cli', op: 'a' });
    journal.append({ ts: 2, actor: 'cli', op: 'b' });
    journal.append({ ts: 3, actor: 'cli', op: 'c' });

    const rows = store.allJournal();
    const withHole = [rows[0], rows[2]] as JournalRecord[]; // drop the middle entry
    const result = verifyChain(withHole);
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(3);
    expect(result.reason).toMatch(/broken link/);
  });

  it('verifies an empty chain', () => {
    expect(verifyChain([])).toEqual({ ok: true, length: 0 });
  });

  // Hash-what-you-persist — the hash must commit to the JSON-normalized payload,
  // because that is the value the store persists and verification later reads back.
  it('normalizes undefined-valued keys out of the payload before hashing AND persisting', () => {
    const sealed = sealEntry(
      { ts: 1, actor: 'cli', op: 'o', payload: { a: undefined, b: 1 } },
      null,
    );
    expect(sealed.payload).toEqual({ b: 1 });
    // hash equals the hash of the normalized payload — a JSON round-trip changes nothing
    expect(sealed.hash).toBe(
      computeHash({ ts: 1, actor: 'cli', op: 'o', payload: { b: 1 } }, null),
    );
    const roundTripped = JSON.parse(JSON.stringify(sealed.payload)) as unknown;
    expect(computeHash({ ts: 1, actor: 'cli', op: 'o', payload: roundTripped }, null)).toBe(
      sealed.hash,
    );
  });

  it('normalizes toJSON objects (Date) before hashing AND persisting', () => {
    const d = new Date('2026-01-02T03:04:05.000Z');
    const sealed = sealEntry({ ts: 1, actor: 'cli', op: 'o', payload: { d } }, null);
    expect(sealed.payload).toEqual({ d: '2026-01-02T03:04:05.000Z' });
    const roundTripped = JSON.parse(JSON.stringify(sealed.payload)) as unknown;
    expect(computeHash({ ts: 1, actor: 'cli', op: 'o', payload: roundTripped }, null)).toBe(
      sealed.hash,
    );
  });
});

// FakeStore mirrors SqliteDriver.afterCommit: the journal's external checkpoint mirror runs
// right after the OUTERMOST transaction commits — never mid-transaction, never on rollback.
describe('external checkpoint flush via afterCommit (FakeStore mirror)', () => {
  function setup() {
    const store = new FakeStore();
    const crypto = { mac: (data: string) => `fake-mac:${data}` };
    const external: { value?: string; read(): string | undefined; write(v: string): void } = {
      value: undefined,
      read() {
        return this.value;
      },
      write(v: string) {
        if (store.inTransaction()) {
          throw new Error('external checkpoint written INSIDE an open transaction');
        }
        this.value = v;
      },
    };
    const journal = new JournalService(store, { crypto, external });
    return { store, external, journal };
  }

  it('a nested append flushes the external copy right after the outer commit', () => {
    const { store, external, journal } = setup();
    store.writeTransaction(() => {
      journal.append({ ts: 1, actor: 'cli', op: 'memory_write', payload: { id: 'm1' } });
      // still inside the transaction: nothing may have reached the external store yet
      expect(external.value).toBeUndefined();
    });
    // committed → drained: the external copy now matches the meta checkpoint
    expect(external.value).toBeDefined();
    const cp = JSON.parse(external.value as string) as { count: number };
    expect(cp.count).toBe(1);
    expect(journal.verify()).toMatchObject({ ok: true, state: 'ok' });
  });

  it('a rolled-back transaction discards the queued flush', () => {
    const { store, external, journal } = setup();
    journal.append({ ts: 1, actor: 'cli', op: 'memory_write', payload: { id: 'm1' } });
    const before = external.value;
    expect(before).toBeDefined();
    expect(() =>
      store.writeTransaction(() => {
        journal.append({ ts: 2, actor: 'cli', op: 'memory_write', payload: { id: 'doomed' } });
        throw new Error('rollback');
      }),
    ).toThrow('rollback');
    expect(external.value).toBe(before); // untouched — the queued callback never ran
    expect(journal.verify()).toMatchObject({ ok: true, state: 'ok' });
  });
});

// Trust-anchor completion: unreadable checkpoints fail CLOSED, and prior-install evidence keeps
// an erased installation from ever verifying as pristine (TOFU is first-use only).
describe('verify() fails closed on unreadable checkpoints and erased installations', () => {
  const crypto = { mac: (data: string) => `fake-mac:${data}` };

  function throwingExternal(): { read(): string | undefined; write(v: string): void } {
    return {
      read() {
        throw new Error('EACCES: permission denied');
      },
      write() {
        throw new Error('EACCES: permission denied');
      },
    };
  }

  it('an external checkpoint read that THROWS is a verification failure, not "absent"', () => {
    const store = new FakeStore();
    const journal = new JournalService(store, { crypto, external: throwingExternal() });
    const r = journal.verify();
    expect(r.ok).toBe(false);
    expect(r.state).toBeUndefined();
    expect(r.reason).toMatch(/journal checkpoint file unreadable — refusing to verify/);
    expect(r.reason).toMatch(/fix permissions or restore the file/);
  });

  it('a meta checkpoint read that THROWS is a verification failure', () => {
    const store = new FakeStore();
    const journal = new JournalService(store, { crypto });
    store.getMeta = () => {
      throw new Error('database disk image is malformed');
    };
    const r = journal.verify();
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/journal checkpoint unreadable — refusing to verify/);
  });

  it('an unreadable external file blocks the TOFU auto-seal (zero writes)', () => {
    const store = new FakeStore();
    const journal = new JournalService(store, { crypto, external: throwingExternal() });
    const sealed = journal.seal('migrate', 1, { onlyIfMissing: true });
    expect(sealed.ok).toBe(false);
    expect(sealed.reason).toMatch(/unreadable — refusing to auto-seal/);
    expect(store.allJournal()).toHaveLength(0);
    expect(store.getMeta('journal_checkpoint')).toBeUndefined();
  });

  it('priorInstall + empty journal + no checkpoints → FAIL, never pristine', () => {
    const store = new FakeStore();
    const journal = new JournalService(store, { crypto, priorInstall: true });
    const r = journal.verify();
    expect(r.ok).toBe(false);
    expect(r.state).toBeUndefined();
    expect(r.reason).toMatch(/initialized installation with erased journal history/);
    expect(r.reason).toMatch(/journal reseal/);
  });

  it('priorInstall blocks the TOFU auto-seal on an empty journal; explicit seal remains the escape hatch', () => {
    const store = new FakeStore();
    const journal = new JournalService(store, { crypto, priorInstall: true });
    const sealed = journal.seal('migrate', 1, { onlyIfMissing: true });
    expect(sealed.ok).toBe(false);
    expect(sealed.reason).toMatch(/erased journal history — refusing to auto-seal/);
    expect(store.allJournal()).toHaveLength(0); // zero writes

    // the explicit trust decision (`sthayi journal reseal`) still works
    expect(journal.seal('cli', 2).ok).toBe(true);
    expect(journal.verify()).toMatchObject({ ok: true, state: 'ok' });
  });

  it('a rows-bearing checkpoint-less store REFUSES the auto-seal (fail closed); explicit reseal blesses it', () => {
    // A store with rows but no checkpoint anywhere — the shape of BOTH a legitimate
    // pre-checkpoint upgrade AND a truncated/replaced database whose checkpoints were erased.
    // They are indistinguishable, so the automatic path must fail closed with zero writes;
    // only the explicit `sthayi journal reseal` (seal without onlyIfMissing) may bless it.
    const store = new FakeStore();
    const legacy = new JournalService(store); // checkpoint-disabled writer
    legacy.append({ ts: 1, actor: 'cli', op: 'memory_write', payload: { id: 'm1' } });
    const journal = new JournalService(store, { crypto, priorInstall: true });
    const rowsBefore = store.allJournal();
    const sealed = journal.seal('migrate', 2, { onlyIfMissing: true });
    expect(sealed.ok).toBe(false);
    expect(sealed.reason).toMatch(/no authenticated checkpoint — refusing to auto-seal/);
    expect(sealed.reason).toMatch(/journal reseal/);
    // zero writes: no seal entry, no minted checkpoint
    expect(store.allJournal()).toEqual(rowsBefore);
    expect(store.getMeta('journal_checkpoint')).toBeUndefined();
    expect(journal.verify().ok).toBe(false);

    // the explicit trust decision still works
    expect(journal.seal('cli', 3).ok).toBe(true);
    expect(journal.verify()).toMatchObject({ ok: true, state: 'ok' });
  });

  it('rows-bearing auto-seal refusal does not depend on priorInstall (core wiring without it)', () => {
    const store = new FakeStore();
    const legacy = new JournalService(store);
    legacy.append({ ts: 1, actor: 'cli', op: 'memory_write', payload: { id: 'm1' } });
    const journal = new JournalService(store, { crypto }); // no priorInstall (browser/core builds)
    const sealed = journal.seal('migrate', 2, { onlyIfMissing: true });
    expect(sealed.ok).toBe(false);
    expect(sealed.reason).toMatch(/refusing to auto-seal/);
    expect(store.getMeta('journal_checkpoint')).toBeUndefined();
  });

  it('the auto-seal still initializes a genuinely empty first-run store', () => {
    const store = new FakeStore();
    const journal = new JournalService(store, { crypto, priorInstall: false });
    const sealed = journal.seal('migrate', 1, { onlyIfMissing: true });
    expect(sealed.ok).toBe(true);
    expect(store.allJournal().filter((r) => r.op === 'journal_seal')).toHaveLength(1);
    expect(journal.verify()).toMatchObject({ ok: true, state: 'ok' });
  });

  it('without priorInstall (fresh machine / core tests) an empty store is still pristine', () => {
    const store = new FakeStore();
    expect(new JournalService(store, { crypto }).verify()).toEqual({
      ok: true,
      length: 0,
      state: 'pristine',
    });
    expect(new JournalService(store, { crypto, priorInstall: false }).verify()).toEqual({
      ok: true,
      length: 0,
      state: 'pristine',
    });
  });
});

/**
 * Append gate + non-healing verification: an ordinary append REFUSES (throws, zero writes) every
 * state verify() fails on, `verify({ heal: false })` never touches the external file, and the
 * external mirror refuses to overwrite an authentic checkpoint whose tip is not an ancestor of
 * the current chain (equal and higher counts included). Only seal() accepts untrusted history.
 */
describe('append gate: ordinary writes refuse failed authenticity states (non-healing)', () => {
  const crypto = { mac: (data: string) => `fake-mac:${data}` };

  interface MemExternal {
    value?: string;
    read(): string | undefined;
    write(v: string): void;
  }

  function memoryExternal(): MemExternal {
    return {
      value: undefined,
      read() {
        return this.value;
      },
      write(v: string) {
        this.value = v;
      },
    };
  }

  /** An authentic checkpoint (same fake mac) from a DIVERGENT branch of `count` entries. */
  function divergentCheckpoint(count: number): string {
    const store = new FakeStore();
    const external = memoryExternal();
    const journal = new JournalService(store, { crypto, external });
    for (let i = 1; i <= count; i++) {
      journal.append({ ts: 1000 + i, actor: 'other', op: 'x', payload: { branch: 'B', i } });
    }
    return external.value as string;
  }

  it('erased-history shape: priorInstall + erased store — append THROWS with zero writes; explicit seal unlocks', () => {
    const store = new FakeStore();
    const external = memoryExternal();
    const journal = new JournalService(store, { crypto, external, priorInstall: true });
    expect(() =>
      journal.append({ ts: 1, actor: 'cli', op: 'memory_write', payload: { id: 'm1' } }),
    ).toThrow(/refusing to append.*erased journal history/s);
    // nothing written anywhere: no rows, no meta checkpoint minted, no external file
    expect(store.allJournal()).toHaveLength(0);
    expect(store.getMeta('journal_checkpoint')).toBeUndefined();
    expect(external.value).toBeUndefined();

    // the explicit trust decision unlocks ordinary appends again
    expect(journal.seal('cli', 2).ok).toBe(true);
    journal.append({ ts: 3, actor: 'cli', op: 'memory_write', payload: { id: 'm2' } });
    expect(journal.verify()).toMatchObject({ ok: true, state: 'ok' });
  });

  it('divergent-checkpoint shape: authentic DIVERGENT external at EQUAL count — append THROWS, the file value survives', () => {
    const store = new FakeStore();
    const external = memoryExternal();
    const journal = new JournalService(store, { crypto, external });
    journal.append({ ts: 1, actor: 'cli', op: 'a', payload: { i: 1 } });
    journal.append({ ts: 2, actor: 'cli', op: 'b', payload: { i: 2 } });
    const divergent = divergentCheckpoint(2); // same count as our chain, different history
    external.value = divergent;

    expect(journal.verify().ok).toBe(false);
    expect(() => journal.append({ ts: 3, actor: 'cli', op: 'c', payload: { i: 3 } })).toThrow(
      /refusing to append.*does not match this journal's history/s,
    );
    // zero effects: rows unchanged, the divergent external (the evidence) untouched
    expect(store.allJournal()).toHaveLength(2);
    expect(external.value).toBe(divergent);
    expect(journal.verify().ok).toBe(false);
  });

  it('verify({heal: false}) NEVER writes the external file; it REPORTS the lag instead of assuming a heal', () => {
    const store = new FakeStore();
    const external = memoryExternal();
    const journal = new JournalService(store, { crypto, external });
    journal.append({ ts: 1, actor: 'cli', op: 'a' });
    const lagging = external.value as string; // authentic ancestor checkpoint (count 1)
    journal.append({ ts: 2, actor: 'cli', op: 'b' });
    external.value = lagging; // the file lags the meta copy by one entry

    // Zero side effects is the contract, and so is the VERDICT. Reporting a lagging anchor as
    // ok/'ok' on the promise that a later heal will fix it never establishes that the heal
    // arrived — a file frozen at count 1 would go on vouching for a store at counts 2, 3, 4…
    // A non-healing verification reports what is actually true right now.
    const v = journal.verify({ heal: false });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/external journal checkpoint is STALE/);
    expect(external.value).toBe(lagging); // non-healing: byte-identical

    // …and the HEALING verify is where the lag is resolved
    expect(journal.verify()).toMatchObject({ ok: true, state: 'ok' });
    expect(external.value).not.toBe(lagging); // healing mode advanced the file
  });

  it('a COMMITTED lagging external is brought CURRENT by the gate BEFORE the entry is written', () => {
    const store = new FakeStore();
    const external = memoryExternal();
    const countsWhenAppended: number[] = [];
    const journal = new JournalService(store, { crypto, external });
    const watched = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'appendJournal') {
          return (entry: Parameters<FakeStore['appendJournal']>[0]) => {
            // what the anchor holds at the instant the row is written
            countsWhenAppended.push(
              (JSON.parse(external.value as string) as { count: number }).count,
            );
            return target.appendJournal(entry);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as FakeStore;
    const watchedJournal = new JournalService(watched, { crypto, external });
    journal.append({ ts: 1, actor: 'cli', op: 'a' });
    const lagging = external.value as string;
    journal.append({ ts: 2, actor: 'cli', op: 'b' });
    external.value = lagging; // lag by one, ACROSS A COMMIT — no mirror is in flight

    watchedJournal.append({ ts: 3, actor: 'cli', op: 'c' });
    // the gate closed the gap first: entry 3 was written onto a store whose anchor was CURRENT at
    // count 2, never onto one anchored at count 1
    expect(countsWhenAppended).toEqual([2]);
    expect((JSON.parse(external.value as string) as { count: number }).count).toBe(3);
    expect(journal.verify()).toMatchObject({ ok: true, state: 'ok' });
  });

  it('a lagging external that CANNOT be advanced refuses the append outright', () => {
    // The frozen anchor: the gate tries to close the gap, the write fails closed, and the append
    // refuses rather than proceeding on a store nothing outside the database vouches for.
    const store = new FakeStore();
    const external: MemExternal = {
      value: undefined,
      read() {
        return this.value;
      },
      write() {
        throw new Error('journal checkpoint lock is held by another writer');
      },
    };
    const journal = new JournalService(store, { crypto });
    journal.append({ ts: 1, actor: 'cli', op: 'a' }); // seed the chain without the external wiring
    const frozen = JSON.parse(store.getMeta('journal_checkpoint') as string) as { count: number };
    expect(frozen.count).toBe(1);
    external.value = store.getMeta('journal_checkpoint');
    const gated = new JournalService(store, { crypto, external });
    gated.append({ ts: 2, actor: 'cli', op: 'b' }); // anchor was current: allowed, mirror then fails
    expect((JSON.parse(external.value as string) as { count: number }).count).toBe(1);

    expect(() => gated.append({ ts: 3, actor: 'cli', op: 'c' })).toThrow(
      /refusing to append.*external journal checkpoint is STALE/s,
    );
    expect(store.allJournal()).toHaveLength(2); // zero writes
    expect((JSON.parse(external.value as string) as { count: number }).count).toBe(1); // untouched
  });

  it('an ABSENT external is never CREATED by an ordinary append — that is the explicit verify', () => {
    // Advancing an authentic prefix asserts nothing new. Creating the anchor asserts "this history
    // is the real one" with nothing outside the database to corroborate it, which is the trust
    // decision TOFU guards — an ordinary write may not make it.
    const store = new FakeStore();
    const external = memoryExternal();
    const journal = new JournalService(store, { crypto, external });
    journal.append({ ts: 1, actor: 'cli', op: 'a' });
    external.value = undefined; // the anchor is gone

    expect(() => journal.append({ ts: 2, actor: 'cli', op: 'b' })).toThrow(
      /refusing to append.*NO checkpoint file outside it/s,
    );
    expect(store.allJournal()).toHaveLength(1);
    expect(external.value).toBeUndefined(); // the gate created nothing

    // read() rather than .value: the assignment above narrows the property's type to `undefined`
    const anchored = (): number =>
      (JSON.parse(external.read() as string) as { count: number }).count;
    expect(journal.verify()).toMatchObject({ ok: true, state: 'ok' }); // the explicit verify does
    expect(anchored()).toBe(1);
    journal.append({ ts: 2, actor: 'cli', op: 'b' }); // and writes resume
    expect(anchored()).toBe(2);
  });

  it('an IN-FLIGHT lag does not block batched appends; the mirror still runs only post-commit', () => {
    // The legitimate lag the invariant must preserve: inside ONE caller transaction the mirror is
    // deferred to the commit, so appends 2..n of a batch necessarily see a file that is behind.
    // What makes it legitimate — and distinguishes it from the committed stale anchor above — is
    // that the file still holds EXACTLY the checkpoint that was committed when the transaction
    // began, and a mirror for that transaction is genuinely outstanding.
    const store = new FakeStore();
    const writesInTransaction: boolean[] = [];
    const external: MemExternal = {
      value: undefined,
      read() {
        return this.value;
      },
      write(v: string) {
        writesInTransaction.push(store.inTransaction());
        this.value = v;
      },
    };
    const journal = new JournalService(store, { crypto, external });
    journal.append({ ts: 1, actor: 'cli', op: 'a' });
    const atTransactionStart = external.value as string;

    store.writeTransaction(() => {
      journal.append({ ts: 2, actor: 'cli', op: 'b' });
      // mid-transaction: the file is deliberately still the count-1 copy…
      expect(external.value).toBe(atTransactionStart);
      journal.append({ ts: 3, actor: 'cli', op: 'c' }); // …and that does not block the next append
      expect(external.value).toBe(atTransactionStart);
      journal.append({ ts: 4, actor: 'cli', op: 'd' });
    });

    const mirrored = JSON.parse(external.value as string) as { count: number };
    expect(mirrored.count).toBe(4); // mirrored to the committed tip…
    expect(writesInTransaction.every((inTx) => inTx === false)).toBe(true); // …only post-commit
    expect(journal.verify()).toMatchObject({ ok: true, state: 'ok' });
  });

  it("an open transaction buys nothing: a FROZEN anchor refuses at the batch's FIRST append", () => {
    // The in-flight tolerance is keyed to the checkpoint committed when the transaction began AND
    // to a mirror of ours genuinely being outstanding — never to "a transaction is open". An
    // attacker who freezes the anchor must not be able to buy a run of appends by starting a batch.
    const store = new FakeStore();
    const external: MemExternal = {
      value: undefined,
      read() {
        return this.value;
      },
      write() {
        throw new Error('journal checkpoint lock is held by another writer');
      },
    };
    const seed = new JournalService(store, { crypto });
    seed.append({ ts: 1, actor: 'cli', op: 'a' });
    const stale = store.getMeta('journal_checkpoint') as string;
    seed.append({ ts: 2, actor: 'cli', op: 'b' });
    external.value = stale; // frozen one behind, across a commit, and unadvanceable

    const journal = new JournalService(store, { crypto, external });
    expect(() =>
      store.writeTransaction(() => {
        journal.append({ ts: 3, actor: 'cli', op: 'c' });
        journal.append({ ts: 4, actor: 'cli', op: 'd' });
      }),
    ).toThrow(/refusing to append.*external journal checkpoint is STALE/s);
    expect(store.allJournal()).toHaveLength(2); // the whole batch rolled back
    expect(external.value).toBe(stale);
  });

  it('the external mirror refuses to overwrite an authentic NON-ANCESTOR checkpoint swapped in after the gate ran', () => {
    // Defense in depth for the gate→flush race: another process swaps the external file
    // between the in-transaction precondition and the post-commit mirror. The mirror must
    // keep the evidence, not overwrite it.
    const store = new FakeStore();
    const warnings: string[] = [];
    const writes: string[] = [];
    const swapped: { raw?: string } = {};
    const external = {
      read(): string | undefined {
        // inside the transaction (the gate) the file still matches the meta copy;
        // outside (the post-commit mirror) it has been swapped for a divergent one
        return swapped.raw !== undefined && !store.inTransaction()
          ? swapped.raw
          : store.getMeta('journal_checkpoint');
      },
      write(v: string): void {
        writes.push(v);
      },
    };
    const journal = new JournalService(store, {
      crypto,
      external,
      warn: (m) => warnings.push(m),
    });
    journal.append({ ts: 1, actor: 'cli', op: 'a', payload: { i: 1 } });
    swapped.raw = divergentCheckpoint(2); // equal to the post-append count, foreign history
    journal.append({ ts: 2, actor: 'cli', op: 'b', payload: { i: 2 } });

    // the mirror refused: no write with the swapped file present, and it said why
    expect(writes.some((w) => (JSON.parse(w) as { count: number }).count === 2)).toBe(false);
    expect(warnings.some((w) => /not part of this journal's history/.test(w))).toBe(true);
  });

  // REPLACES "steady-state appends never read the full journal (O(1) gate fast path)". That fast
  // path authenticated the checkpoints and the TIP only and never walked the chain's interior, so
  // a tampered interior row left verify() red while ordinary appends kept succeeding on top of
  // it. The gate now always runs the full non-healing verification; this test pins that.
  it('every steady-state append reads the full journal (the gate walks the whole chain)', () => {
    const inner = new FakeStore();
    let allJournalCalls = 0;
    const store = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === 'allJournal') {
          return (): ReturnType<FakeStore['allJournal']> => {
            allJournalCalls++;
            return target.allJournal();
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as FakeStore;
    const external = memoryExternal();
    const journal = new JournalService(store, { crypto, external });
    journal.append({ ts: 1, actor: 'cli', op: 'a' });
    allJournalCalls = 0;
    journal.append({ ts: 2, actor: 'cli', op: 'b' });
    expect(allJournalCalls).toBeGreaterThanOrEqual(1);
    const afterFirst = allJournalCalls;
    journal.append({ ts: 3, actor: 'cli', op: 'c' }); // per-append, not once per process
    expect(allJournalCalls).toBeGreaterThan(afterFirst);
    expect(journal.verify()).toMatchObject({ ok: true, length: 3, state: 'ok' });
  });
});
