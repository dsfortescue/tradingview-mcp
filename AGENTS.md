# tradingview-mcp — Codex shared conventions

## Codex shared conventions

These conventions are shared across every repo Codex works in. They are restated here because Codex does not load BRAIN's guidance — only this file and the per-task brief. The canonical source for this block is `docs/protocols/codex-shared-conventions.md` in BRAIN; if this copy and the canonical disagree, the canonical wins and this copy is out of date.

1. **Codex does not commit. Ori does all git.** No `git add`, `git commit`, `git branch`, `git push`, `git stash`, no `.git/` writes of any kind. Edits stay in the working tree; Ori handles staging, commits, branches, and pushes. If a brief asks Codex to commit, refuse and say so in the report.

2. **The task brief's acceptance criteria are the definition of done.** "Done" means every AC in the brief passes against the real built artifact. Not "the code compiles," not "tsc is clean," not "my self-test passes." The ACs are the gate; meet them or report the gap.

3. **Codex does not author its own ACs.** ACs come from Tate via the brief. If the brief lacks ACs, do not invent them — report the gap and stop. Self-authored ACs describe what Codex built, not what was required; the gap between those is exactly what Tate exists to catch.
