# AgentReceipt

**Signed evidence for AI-generated code work.**

AgentReceipt turns a coding-agent session into a verifiable Trust Receipt: what changed, what was checked, what failed, what was skipped, whether the final claims are backed by real tool evidence, and what should happen next.

Live product: https://agentreceipt.vercel.app

```bash
npx --yes github:Pranayg911/agentreceipt --web
npx --yes github:Pranayg911/agentreceipt --ci --min-trust 80
```

## Why It Exists

AI coding agents can edit files, run commands, and confidently say "done." That is not enough for a reviewer, founder, or CI system deciding whether to merge or deploy.

CI answers: did this configured command pass?

AgentReceipt answers: did the agent actually verify the work it produced, and what should the reviewer do next?

It checks the agent transcript against local repo evidence, then signs the result so anyone can inspect the receipt without trusting another model's opinion.

## What It Catches

| Evidence | What AgentReceipt verifies |
|---|---|
| Claude Code transcript | Claims vs actual tool calls and command results |
| Codex rollout logs | Assistant messages, shell commands, outputs, and patches |
| Cursor checkpoints | Agent-touched files when full transcript logs are unavailable |
| Bash results | Failed tests, failed builds, failed deploys |
| Edit/write tools | Whether files were actually changed |
| Git status | What changed in the working tree |
| package.json scripts | Expected tests/builds/typechecks/lints that were skipped |
| Schema/dependency files | Missing migrations, installs, builds, or tests |

## Example Receipt

```text
  AGENT RECEIPT  codex - 7d310499 - 7aa40d34

  TRUST  69/100   ##############------
  The Optimist
  Do not merge yet
  Trust 69/100 because AgentReceipt found 1 failed or contradicted finding and 1 unproven gap. Fix the failed evidence before merge.

  FAIL Tests failed during the session
     tests failed after 5 changed files - `npm test` exited 1
  GAP Build was skipped for changed code
     package.json has a build script, but no build command was observed
  PASS Typecheck ran after changes
     typecheck passed after 5 changed files - `tsc --noEmit` exited 0

  NEXT
  1. Fix the failing tests, rerun the test command after the final edit, then regenerate the receipt.
  2. Run the repo build after the final edit so reviewers can trust the artifact.

  138 tool calls / 5 edits / 1 verified / 1 gap / 1 failed / ~$4.18
  PASS ed25519 signed & verifiable   key HS3Qs3Bhqp...
```

## Use The CLI

```bash
# Latest supported local session, open the signed web receipt.
npx --yes github:Pranayg911/agentreceipt --web

# Print the signed receipt URL instead of opening a browser.
npx --yes github:Pranayg911/agentreceipt --url

# CI-friendly failure gate. Defaults to the live Vercel receipt viewer.
npx --yes github:Pranayg911/agentreceipt --ci --min-trust 80

# Machine-readable reports.
npx --yes github:Pranayg911/agentreceipt --format json
npx --yes github:Pranayg911/agentreceipt --format markdown --output agentreceipt.md

# Force an adapter.
npx --yes github:Pranayg911/agentreceipt --agent claude
npx --yes github:Pranayg911/agentreceipt --agent codex
npx --yes github:Pranayg911/agentreceipt --agent cursor

# Audit a specific transcript/checkpoint.
npx --yes github:Pranayg911/agentreceipt path/to/session.jsonl

# Verify a saved receipt offline.
npx --yes github:Pranayg911/agentreceipt verify receipt.json
```

When published to npm, the command becomes:

```bash
npx agentreceipt --web
```

## GitHub Action

Use AgentReceipt as a pull-request evidence gate:

```yaml
name: AgentReceipt

on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

jobs:
  verify-ai-work:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: Pranayg911/agentreceipt@main
        with:
          agent: auto
          min-trust: 80
          comment: true
```

The Action writes a markdown receipt to the GitHub Actions step summary. With `comment: true`, it also comments the receipt on the pull request.

Cloud runners cannot read agent logs stored on your laptop. If the transcript/checkpoint is produced earlier in CI, pass it explicitly:

```yaml
- uses: Pranayg911/agentreceipt@main
  with:
    session-file: .agentreceipt/session.jsonl
    min-trust: 80
```

## Why Models Do Not Replace It

AgentReceipt is not an LLM judge. Models can make AgentReceipt better by running more checks, producing richer transcripts, and attaching more evidence. But the trust layer remains outside the model:

- Deterministic analysis, not vibes.
- Repo-aware skipped-check detection.
- Signed receipts that can be verified offline.
- Shareable web receipts that do not require raw transcript uploads.
- CI thresholds that fail merges when evidence is weak.

That is the product wedge: AI agents create the work; AgentReceipt proves whether the work earned trust and tells teams the next safest action.

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

`v0.1` supports Claude Code transcripts, Codex rollout logs, Cursor checkpoint metadata, deterministic claim checking, repo-aware skipped-check detection, signed decisions, next-action guidance, ed25519 signing, offline verification, self-contained web receipt URLs, CI thresholds, markdown/json reports, and a GitHub Action.

Next: CI log ingestion, richer Cursor transcript parsing, policy packs, team ledgers, and first-class npm distribution.

## Links

- Product: https://agentreceipt.vercel.app
- Core repository: https://github.com/Pranayg911/agentreceipt
- Web app source: https://github.com/Pranayg911/agentreceipt-web

## License

MIT
