import { type Memory, buildPack } from '@sthayi/core';
import { describe, expect, it } from 'vitest';

function mem(over: Partial<Memory>): Memory {
  return {
    id: 'x',
    type: 'semantic',
    scope: 'user',
    content: 'hi',
    provenance: { source: 't' },
    confidence: 0.6,
    boosts: 0,
    status: 'confirmed',
    source: 't',
    createdAt: 0,
    updatedAt: 0,
    lastRetrievedAt: null,
    decayAt: null,
    ...over,
  };
}

describe('buildPack', () => {
  it('groups by type, applies the egress mask to the WHOLE document, and includes the header', () => {
    const md = buildPack(
      [
        mem({ type: 'semantic', content: 'prefers pnpm' }),
        mem({ type: 'episodic', content: 'talked X' }),
      ],
      { scope: 'user', now: 0, mask: (c) => c.toUpperCase() },
    );
    expect(md).toMatch(/# Sthayi memory pack — scope: user/i);
    expect(md).toMatch(/## Facts & preferences/i);
    expect(md).toMatch(/PREFERS PNPM/); // mask applied to content
    expect(md).toMatch(/## From past conversations/i);
    expect(md).toMatch(/sthayi entities/i);
    // Headers pass the egress mask too — nothing in the document escapes it
    expect(md).toBe(md.toUpperCase());
  });

  it('renders an empty-scope note', () => {
    expect(buildPack([], { scope: 'user', now: 0, mask: (c) => c })).toMatch(/no memories/);
  });

  it('segregates proposals under "Unreviewed proposals" with [type] tags, mask applied', () => {
    const md = buildPack(
      [
        mem({ id: 'c1', type: 'semantic', content: 'prefers pnpm' }),
        mem({ id: 'p1', type: 'procedural', status: 'proposed', content: 'wear the red hat' }),
      ],
      { scope: 'user', now: 0, mask: (c) => c.toUpperCase() },
    );
    expect(md).toMatch(
      /_Contents: 1 confirmed memories, 1 unreviewed proposals \(labeled below\)_/i,
    );
    const proposalsAt = md.toLowerCase().indexOf('## unreviewed proposals');
    expect(proposalsAt).toBeGreaterThan(-1);
    expect(md).toMatch(/treat as unverified/i);
    expect(md).toMatch(/sthayi review/i);
    // labeled with its type AND masked like every other line (headers included)
    expect(md).toContain('- [PROCEDURAL] WEAR THE RED HAT');
    // the proposal renders ONLY in the trailing section — never in a per-type section
    expect(md.indexOf('WEAR THE RED HAT')).toBeGreaterThan(proposalsAt);
    expect(md).not.toMatch(/## How-to & instructions/i);
  });

  it('drops archived rows defensively even when passed', () => {
    const md = buildPack(
      [
        mem({ id: 'a1', status: 'archived', content: 'stale zombie row' }),
        mem({ content: 'live row' }),
      ],
      { scope: 'user', now: 0, mask: (c) => c },
    );
    expect(md).not.toMatch(/stale zombie row/);
    expect(md).toMatch(/live row/);
    expect(md).toMatch(/_Contents: 1 confirmed memories_/);
  });

  it('empty note appears only when confirmed AND proposed are both empty', () => {
    // archived-only input is still "empty"
    expect(
      buildPack([mem({ status: 'archived' })], { scope: 'user', now: 0, mask: (c) => c }),
    ).toMatch(/no memories in this scope yet/);
    // proposals alone suppress the note
    const proposalsOnly = buildPack([mem({ status: 'proposed' })], {
      scope: 'user',
      now: 0,
      mask: (c) => c,
    });
    expect(proposalsOnly).not.toMatch(/no memories in this scope yet/);
    expect(proposalsOnly).toMatch(/## Unreviewed proposals/);
    expect(proposalsOnly).toMatch(
      /_Contents: 0 confirmed memories, 1 unreviewed proposals \(labeled below\)_/,
    );
  });
});
