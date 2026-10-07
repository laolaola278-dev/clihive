# Real-CLI acceptance record — 2026-10-07

This is **real-process evidence**, separate from the simulated unit/API/UI
tests (which use fake CLIs and never count as collaboration success).
Produced by `node scripts/acceptance-real.mjs` (no fakes injected: real
adapters, real processes, real store, isolated temp `CLIHIVE_HOME` + workdir,
read-only permission end to end).

## Environment

- Windows, Node (see `.artifacts/*.json` for the exact version)
- `codex-cli 0.160.0`, `2.1.287 (Claude Code)` — both authenticated and available

## Attempt 1 — 09:00:25Z — NOT PASSED (kept for honesty)

- claude task: `awaiting_review`, `outcome=done`, exit 0, summary contained `4242`.
- codex task: **failed** — `codex turn timed out and the process tree was killed`
  at the 300 s task budget. Event stream showed the session started, a ~115 s
  gap before the first reasoning item, 4 tool calls, then no further events
  until the kill. Cause was model-endpoint latency, not a permission denial or
  adapter deadlock (no `permission_denied`, process tree was cleanly killed).
- The script additionally had a bug (matched task ids with a `:` prefix that
  does not exist), so its checks reported `state=undefined`; fixed afterwards.
- Budget was then raised to `taskTimeoutMs=900000`.

## Attempt 2 — 09:14:53Z → 09:16:04Z — PASSED

Run `run_muxw62dw0067617`, limits: concurrency 2, agentTurns 8,
taskTimeout 900 s, runTimeout 2700 s; 2 turns used.

| task | agent | outcome | exit | duration | session |
|------|-------|---------|------|----------|---------|
| `t-codex-report` | codex (read-only) | done → reviewed → completed | 0 | ~11 s | `01a115a4-f612-7833-b994-18ae0c0a8cc7` |
| `t-claude-verify` | claude (read-only) | done → reviewed → completed | 0 | ~69 s | `2ab7699e-5749-46d9-ad5c-f681501b649c` |

Checks (all PASS): both tasks reached `awaiting_review` (not self-completed);
both summaries contain the fixture's magic number `4242`; both receipts record
`read-only` with no permission denial; `NOTES.txt` sha256 unchanged
(`517826e6442e…`); no new files in the workdir; after operator review with
evidence both tasks → `completed` and the run → `completed`.

Raw machine-readable evidence: `.artifacts/acceptance-real-<ts>.{json,md}`
(git-ignored; regenerate by re-running the script).

## What this does and does NOT prove

Proven with real CLIs: version/availability probe, adapter spawn via stdin
prompt, structured-result parsing for both codex and claude, session ids,
read-only enforcement observed (no writes), receipts, review gate, run
completion, process cleanup on timeout (attempt 1).

**Not covered by a real-CLI run** (verified only with fakes/simulation so far):
real peer messaging between codex and claude, the model planner, resume of a
session, `workspace-write` profile, restart recovery with a live agent, and
budget exhaustion. Codex latency varied 11 s → >300 s between runs, so
timeouts should be sized generously.
