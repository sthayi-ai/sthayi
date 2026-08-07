# Sthayi — 30-second demo storyboard (charmbracelet/vhs).
# Regenerate the GIF with:  pnpm gif   (requires `vhs`)
# The storyboard is code — reviewed like code, regenerated on demand.

Output demo.gif
Set Shell bash
Set FontSize 18
Set Width 1200
Set Height 760
Set Padding 20
# Brand palette: Paper bg, Ink fg, Grove accent
Set Theme { "background": "#FAF7F1", "foreground": "#1B1E2B", "cursor": "#3E7A44", "black": "#1B1E2B", "green": "#3E7A44", "red": "#B26845", "yellow": "#B26845", "blue": "#5A5E6E", "magenta": "#B26845", "cyan": "#3E7A44", "white": "#FAF7F1", "brightBlack": "#5A5E6E", "brightGreen": "#3E7A44", "brightRed": "#B26845", "brightYellow": "#B26845", "brightBlue": "#5A5E6E", "brightMagenta": "#B26845", "brightCyan": "#3E7A44", "brightWhite": "#FAF7F1" }

Type "# sthayi — AI memory you own. One memory every AI reads."
Enter
Type "# sthayi (Sanskrit): permanent, enduring"
Enter
Sleep 1s

# The whole onboarding, in one copy-paste line: a durable user-space install, then init.
# `--prefix` is per-invocation — it mutates no npm config — and it needs no admin rights.
# `npx sthayi init` is refused — it would pin a launcher inside npm's download cache.
Type 'npm install -g --prefix "$HOME/.local" sthayi && "$HOME/.local/bin/sthayi" init --yes' Sleep 500ms Enter
Sleep 12s

# That prefix adds nothing to PATH, so the demo puts the durable launcher dir on it once.
Type 'export PATH="$HOME/.sthayi/bin:$PATH"' Sleep 500ms Enter
Sleep 500ms

Type "sthayi add 'I prefer pnpm and vitest; deploy on Fridays' --confirm" Sleep 500ms Enter
Sleep 1500ms

Type "sthayi import ~/Downloads/claude-export.zip" Sleep 500ms Enter
Sleep 2s

Type "sthayi search 'deployment preferences'" Sleep 500ms Enter
Sleep 2s

Type "# In Claude Desktop / Gemini / Codex, just ask:"
Enter
Type "#   'Use Sthayi memory: what do you know about me?'"
Enter
Sleep 1500ms

Type "sthayi pack --scope user   # context.md with secrets masked to pseudonyms" Sleep 500ms Enter
Sleep 2s

Type "sthayi status" Sleep 500ms Enter
Sleep 2500ms
