/** A skill is a SKILL.md living under `~/.sthayi/skills/`; the row indexes it. */
export interface Skill {
  id: string;
  name: string;
  version: string | null;
  path: string;
  tags: string[];
  addedAt: number;
}
