# AgentReceipt

**Signed verification for AI-generated code work.**

AI coding agents can edit files, run commands, and say "done." AgentReceipt turns the session into a signed Trust Receipt that answers a better question:

> Did this AI-made change earn trust before merge or deploy?

It auto-detects supported local agent evidence, adds repo context from `git status` and `package.json`, then checks for failed commands, skipped expected checks, missing migrations, dependency risk, and unsupported success claims.

```bash
npx --yes github:Pranayg911/agentreceipt --web https://agentreceipt.dev
```

Example output:

```text
  AGENT RECEIPT  7d310499 / 7aa40d34

  TRUST  69/100   ##############------
  The Optimist

  FAIL Tests failed during the session
     tests failed after 5 changed files - `npm test` exited 1
  GAP Build was skipped for changed code
     package.json has a build script, but no build command was observed
  PASS Typecheck ran after changes
     typecheck passed after 5 changed files - `tsc --noEmit` exited 0

  138 tool calls / 5 edits / 1 verified / 1 gap / 1 failed / ~$4.18
  PASS ed25519 signed & verifiable   key HS3Qs3Bhqp...
```

## What It Verifies

AgentReceipt uses deterministic evidence, not an LLM judge.

| Evidence | What it catches |
|---|---|
| Claude Code transcript | Claimed tests/build/deploy vs actual tool results |
| Codex rollout logs | Assistant messages, command calls, command outputs, patch applications |
| Cursor checkpoints | Agent-touched files when full transcript logs are not available |
| Bash results | Failed tests, failed builds, failed deploys |
| Edit/write tools | Whether files were actually changed |
| Git status | What files changed in the working tree |
| package.json scripts | Expected checks that were skipped |
| Schema/dependency files | Missing migrations, installs, builds, or tests |

## Why This Gap Exists

CI tells you whether a configured command passed. AgentReceipt tells you whether the agent's work was actually verified relative to what changed.

That matters when agents:

- Edit app code but never run tests.
- Touch schema files but never run migrations.
- Change dependencies but never install/build.
- Claim "all good" after a failing command.
- Produce a PR where the reviewer needs a fast evidence trail.

## Use It

```bash
npx --yes github:Pranayg911/agentreceipt --web              # latest session, open signed web receipt
npx --yes github:Pranayg911/agentreceipt --agent codex      # force Codex
npx --yes github:Pranayg911/agentreceipt --agent cursor     # force Cursor checkpoint mode
npx --yes github:Pranayg911/agentreceipt --agent claude     # force Claude Code
npx --yes github:Pranayg911/agentreceipt --url              # print receipt URL without opening browser
npx --yes github:Pranayg911/agentreceipt                    # terminal-only receipt
npx --yes github:Pranayg911/agentreceipt --all              # latest session anywhere
npx --yes github:Pranayg911/agentreceipt path.jsonl         # specific transcript
npx --yes github:Pranayg911/agentreceipt verify r.json      # verify saved receipt
```

When published to npm, this becomes:

```bash
npx agentreceipt --web
```

## Library

```ts
import { collectProjectContext, gradeSessionFile } from "agentreceipt";

const receipt = gradeSessionFile("~/.claude/projects/<proj>/<id>.jsonl", Date.now(), {
  project: collectProjectContext(),
});

receipt.body.trust;     // 0-100
receipt.body.archetype; // "The Optimist"
receipt.body.claims;    // signed evidence findings
```

## Status

`v0.1` supports Claude Code transcripts, Codex rollout logs, Cursor checkpoint metadata, deterministic claim checking, repo-aware skipped-check detection, scoring/archetypes, ed25519 signing, offline verification, and self-contained web receipt URLs.

Next: GitHub Action PR comments, CI log ingestion, richer Cursor transcript parsing, and `--ci --min-trust` for merge gates.

## License

MIT
