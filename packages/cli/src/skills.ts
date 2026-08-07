import fs from 'node:fs';
import path from 'node:path';
import {
  assertTrustedDirReadOnly,
  establishTrustedDir,
  safeReadTextFile,
  safeWriteFileAtomic,
  untrustedStatReason,
} from './fs-safe.js';
import { assertReadOnlySthayiHome, ensureSthayiHome, skillsDir } from './paths.js';

export interface SkillInfo {
  name: string;
  description: string;
  tags: string[];
  path: string;
}

export interface SkillDetail extends SkillInfo {
  content: string;
}

/** Minimal front-matter reader — enough to pull name/description/tags from a SKILL.md header. */
function parseFrontmatter(md: string): { name?: string; description?: string; tags?: string[] } {
  const match = md.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    return {};
  }
  const body = match[1] ?? '';
  const out: { name?: string; description?: string; tags?: string[] } = {};
  for (const line of body.split('\n')) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) {
      continue;
    }
    const key = kv[1];
    const value = (kv[2] ?? '').trim();
    if (key === 'name') {
      out.name = value;
    } else if (key === 'description') {
      out.description = value;
    } else if (key === 'tags') {
      out.tags = value
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
    }
  }
  return out;
}

const SAMPLE_SKILL = `---
name: using-sthayi-memory
description: How an AI assistant should read from and write to Sthayi memory over MCP.
tags: [meta, memory]
---

# Using Sthayi memory

Before asking the user for something you might already know (their name, preferences, current
projects, past decisions), call \`memory_search\` first.

When the user states a durable fact, preference, or decision, propose it with \`memory_write\`
(it enters the review queue as a proposal). Never write secrets, API keys, or passwords into memory.

Use \`journal_recent\` to see what has been read and written recently.
`;

/** The seeded sample's directory name (also its front-matter `name`). */
const SAMPLE_SKILL_DIR = 'using-sthayi-memory';

/** A SKILL.md is prose an assistant reads at prompt time; 256 KiB is already far past useful.
 *  The cap is what stops a manifest swapped for a huge file from being buffered whole. */
export const SKILL_READ_CAP_BYTES = 256 * 1024;

/** Where the seeded sample lives — the path `init --dry-run` reports without touching anything. */
export function sampleSkillPath(): string {
  return path.join(skillsDir(), SAMPLE_SKILL_DIR, 'SKILL.md');
}

/**
 * The skill directories under a VALIDATED skills root, with their manifests trust-checked.
 *
 * Everything hostile is REFUSED rather than skipped: a symlinked entry (a nested skill directory
 * repointed outside the home is exactly the hijack this subtree invites), and a SKILL.md that is a
 * symlink, a FIFO, a directory, hard-linked, foreign-owned, group/world-writable, or over the cap.
 * Silently skipping them would leave `skill_list` looking healthy while the tree it describes is
 * someone else's.
 */
function skillEntries(dir: string): { name: string; file: string }[] {
  const out: { name: string; file: string }[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(
        `skill directory ${full} is a symlink (possible hijack) — refusing to follow it; remove it and re-run \`sthayi init\``,
      );
    }
    if (!entry.isDirectory()) {
      continue; // stray files at the skills root are not skills — nothing is read through them
    }
    const file = path.join(full, 'SKILL.md');
    let st: fs.Stats;
    try {
      st = fs.lstatSync(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        continue; // a directory without a manifest is simply not a skill
      }
      throw new Error(
        `skill manifest ${file} could not be inspected (${(err as NodeJS.ErrnoException).code ?? 'unknown error'}) — refusing to use it`,
      );
    }
    const reason = untrustedStatReason(st, file, `skill manifest '${entry.name}'`, {});
    if (reason) {
      throw new Error(reason);
    }
    if (st.size > SKILL_READ_CAP_BYTES) {
      throw new Error(
        `skill manifest '${entry.name}' at ${file} is ${st.size} bytes — over the ${SKILL_READ_CAP_BYTES}-byte cap for a skill; refusing to read it (repair or delete the file)`,
      );
    }
    out.push({ name: entry.name, file });
  }
  return out;
}

/**
 * Ensure `~/.sthayi/skills/` exists; seed a sample SKILL.md the first time so the tools are useful.
 *
 * `skills/` is established as a REAL TRUSTED CHILD of the home (owner-only, no symlink at any
 * depth) before anything is written into it. Raw `mkdirSync(recursive)` + `writeFileSync` FOLLOWED a
 * `skills -> outside` symlink: the seeded sample landed in the attacker's directory, and every
 * later read came back out of it.
 */
export function ensureSkillsDir(): string {
  ensureSthayiHome();
  const dir = establishTrustedDir(skillsDir(), 'skills directory', { mode: 0o700 });
  if (skillEntries(dir).length === 0) {
    // The nested skill dir is its own established child — a symlink raced in at that level is
    // refused too, instead of the write resolving through it.
    const sampleDir = establishTrustedDir(path.join(dir, SAMPLE_SKILL_DIR), 'skill directory', {
      mode: 0o700,
    });
    safeWriteFileAtomic(path.join(sampleDir, 'SKILL.md'), SAMPLE_SKILL, { mode: 0o600 });
  }
  return dir;
}

/**
 * The HOME, validated observationally, BEFORE any metadata beneath it is probed — then the skills
 * root beneath that validated root. Returns the canonical skills directory, or `undefined` when
 * there is nothing there to read.
 *
 * Validating `skills/` alone is not enough, and the gap is reachable over MCP. The skills root's
 * own check walks its ANCESTORS, and that walk deliberately forgives a STICKY world-writable
 * directory (`/tmp`, mode 1777) — correct for a path that merely passes through /tmp, wrong for
 * the home itself: sticky stops a peer from deleting or renaming OUR entries, it does not stop
 * them from CREATING new ones. A home left at 1777 would therefore let any local user plant a
 * `skills/` tree (or a whole new skill beside it) for `skill_list` to enumerate and `skill_get`
 * to serve verbatim to the model. The home is Sthayi's trust boundary, so it is held to the
 * boundary rule — owner-only, never group- or world-WRITABLE, sticky or not — before a single
 * entry beneath it is inspected. Creates nothing and chmods nothing: `init --dry-run` and the
 * read-only MCP tools both run through here.
 */
function trustedSkillsRoot(): string | undefined {
  if (assertReadOnlySthayiHome() === undefined) {
    return undefined; // no home at all — nothing beneath it to probe
  }
  // skillsDir() derives from the CANONICAL root the validator just cached, not the logical
  // STHAYI_HOME string, so the entries below are enumerated out of the directory that was checked.
  return assertTrustedDirReadOnly(skillsDir(), 'skills directory');
}

/**
 * Is any skill already installed? OBSERVATIONAL — creates nothing and chmods nothing, so
 * `init --dry-run` can report the seeding decision on a virgin machine. Refuses (throws) on a
 * hostile subtree exactly as the read paths do; an ABSENT skills dir is simply "not seeded yet".
 */
export function skillsSeeded(): boolean {
  const dir = trustedSkillsRoot();
  return dir === undefined ? false : skillEntries(dir).length > 0;
}

export function listSkills(tag?: string): SkillInfo[] {
  // Observational validation FIRST — the home, then `skills/` (and every ancestor): each must be a
  // real, owner-controlled directory. `existsSync` FOLLOWS a symlinked skills root, which would
  // let `skill_list` over MCP enumerate — and `skill_get` return — files from wherever it points;
  // an unvalidated home opens the same hole one level up.
  const dir = trustedSkillsRoot();
  if (dir === undefined) {
    return [];
  }
  const skills: SkillInfo[] = [];
  for (const entry of skillEntries(dir)) {
    // Capped O_NOFOLLOW read: the lstat in skillEntries is a path check, and only the descriptor
    // itself can refuse a manifest swapped after it.
    const body = safeReadTextFile(entry.file, `skill manifest '${entry.name}'`, {
      maxBytes: SKILL_READ_CAP_BYTES,
    });
    if (body === undefined) {
      continue; // raced away between the lstat and the open — genuinely absent
    }
    const fm = parseFrontmatter(body);
    const info: SkillInfo = {
      name: fm.name ?? entry.name,
      description: fm.description ?? '',
      tags: fm.tags ?? [],
      path: entry.file,
    };
    if (!tag || info.tags.includes(tag)) {
      skills.push(info);
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export function getSkill(name: string): SkillDetail | undefined {
  const found = listSkills().find((s) => s.name === name);
  if (!found) {
    return undefined;
  }
  // Re-validated on its own descriptor rather than trusting the path listSkills just returned.
  const content = safeReadTextFile(found.path, `skill manifest '${found.name}'`, {
    maxBytes: SKILL_READ_CAP_BYTES,
  });
  return content === undefined ? undefined : { ...found, content };
}
