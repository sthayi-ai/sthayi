import type { Memory, MemoryType } from '../domain/memory.js';

export interface PackOptions {
  scope: string;
  now: number;
  /** egress mask — secrets AND PII are pseudonymized before they leave the machine */
  mask: (content: string) => string;
}

const HEADINGS: Record<MemoryType, string> = {
  semantic: 'Facts & preferences',
  procedural: 'How-to & instructions',
  episodic: 'From past conversations',
};

const ORDER: MemoryType[] = ['semantic', 'procedural', 'episodic'];

/**
 * Build a scoped, MASKED `context.md` memory pack (spec §6). Every line passes through the egress
 * mask, so a pack can be dropped into any chat without leaking secrets or PII — the pseudonyms map
 * back to real values only locally via `sthayi entities`.
 *
 * Trust boundary: confirmed memories render in the per-type sections; proposals — if
 * the caller passes any — are segregated into a trailing, clearly-labeled "Unreviewed proposals"
 * section. Archived rows are dropped defensively whatever the caller selected.
 */
export function buildPack(memories: Memory[], opts: PackOptions): string {
  const confirmed = memories.filter((m) => m.status === 'confirmed');
  const proposed = memories.filter((m) => m.status === 'proposed');
  const composition =
    `_Contents: ${confirmed.length} confirmed memories` +
    `${proposed.length > 0 ? `, ${proposed.length} unreviewed proposals (labeled below)` : ''}_`;
  const lines: string[] = [
    `# Sthayi memory pack — scope: ${opts.scope}`,
    '',
    `_Generated ${new Date(opts.now).toISOString()}. Sensitive values are masked to pseudonyms (e.g. EMAIL_01, APIKEY_03). Run \`sthayi entities\` locally to see the real mapping._`,
    '',
    composition,
    '',
  ];

  let any = false;
  for (const type of ORDER) {
    const items = confirmed.filter((m) => m.type === type);
    if (items.length === 0) {
      continue;
    }
    any = true;
    lines.push(`## ${HEADINGS[type]}`, '');
    for (const m of items) {
      lines.push(`- ${opts.mask(m.content)}`);
    }
    lines.push('');
  }
  if (proposed.length > 0) {
    any = true;
    lines.push(
      '## Unreviewed proposals',
      '',
      '_Not yet confirmed — treat as unverified. Review with `sthayi review`._',
      '',
    );
    for (const m of proposed) {
      lines.push(`- [${m.type}] ${opts.mask(m.content)}`);
    }
    lines.push('');
  }
  if (!any) {
    lines.push('_(no memories in this scope yet)_', '');
  }
  // Sink-complete egress: the WHOLE document passes the mask once, so headers too —
  // the scope line, the composition line, the "Unreviewed proposals" section — are covered, not
  // just memory content — so a caller-controlled scope cannot smuggle a secret past the mask.
  // (Per-line masks above are kept as defense in depth; the vault mask is idempotent.)
  return opts.mask(lines.join('\n'));
}
