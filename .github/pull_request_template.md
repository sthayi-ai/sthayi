## What & why

<!-- One paragraph: what this changes, why it is needed, and the issue it addresses (if any). -->

## Checklist

- [ ] Commits are signed off (`git commit -s`) — **DCO required**
- [ ] `pnpm verify` passes locally (lint + typecheck + tests)
- [ ] Safety suite green (`pnpm test:safety`) — no safety test weakened or skipped
- [ ] `docs/DECISIONS.md` updated if a decision or new dependency landed
- [ ] New runtime dependency? Justified in `docs/DECISIONS.md`
- [ ] Golden invariants upheld (keyless core, journal append-only, client-config byte-exact, browser-clean core, no secrets at rest)
