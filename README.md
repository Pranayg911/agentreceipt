# 🧾 AgentReceipt

**The signed proof your AI coding agent actually did the work.**

AI coding agents constantly claim *"all tests pass, bug fixed, migration ran"* — and sometimes they're lying. AgentReceipt reads your **Claude Code / Cursor session** (the `.jsonl` transcript already on your disk), cross-checks every success claim against the session's own tool-call record, and gives you a signed **Trust Receipt**: a score, an archetype, and a cited verdict for each claim. Lies caught, with evidence.

```bash
npx agentreceipt
```

```
  AGENT RECEIPT  7d310499 · 7aa40d34

  TRUST  100/100   ████████████████████
  The Test-Driven Closer

  ✓ "the build is clean"
     build ran and passed — `npx tsc -p tsconfig.json` exited 0
  ✗ "all tests pass"
     claimed tests passed, but `npm test` exited 1        ← caught
  ~ "ran the migration"
     claimed the migration ran, but no migration command was run this session

  593 tool calls · 224 edits · 18 verified · 1 unproven · 1 contradicted · ~$19.79
  ✓ ed25519 signed & verifiable   key HS3Qs3Bhqp…
```

---

## Why

You let an agent run with real access. It told you it was done. **Was it?** AgentReceipt answers that — deterministically, from the transcript, in 15 seconds.

- **No LLM in the verdict.** A claim is only marked a *lie* when a relevant command actually **ran and failed** (cited, with its exit code). "Said it, never ran it" is flagged separately as *unproven* — never as a lie. Precision over drama.
- **Zero friction.** The input already exists at `~/.claude/projects/…`. No signup, no integration, no instrumentation. `npx agentreceipt` and you have a receipt.
- **Tamper-evident & shareable.** Every receipt is ed25519-signed. Edit a number and verification breaks. Each public receipt is a card you can post — and a link anyone can verify, no account.

## How it scores

| Verdict | Meaning |
|---|---|
| `✓ verified` | a relevant command ran and **passed** (exit 0 / no error) |
| `✗ contradicted` | a relevant command ran and **failed** — a cited lie |
| `~ unproven` | the claim was made but **no** relevant command was observed |

Trust starts at 100; a cited contradiction is heavy, an unproven claim is moderate, verified claims earn a little back. The **archetype** (*The Test-Driven Closer*, *The Confident Liar*, *The Vibe Coder*, *The Quiet Operator*, …) is the shareable status label.

## Use it

```bash
npx agentreceipt              # grade the latest session for this repo
npx agentreceipt --all        # latest session anywhere
npx agentreceipt path.jsonl   # a specific transcript
npx agentreceipt verify r.json
```

```ts
import { gradeSessionFile } from "agentreceipt";
const receipt = gradeSessionFile("~/.claude/projects/<proj>/<id>.jsonl");
receipt.body.trust;        // 0-100
receipt.body.archetype;    // "The Test-Driven Closer"
receipt.body.claims;       // [{ kind, claim, status, evidence }]
```

## Status

`v0.1` — Claude Code transcript parsing, the deterministic claim-vs-evidence engine, scoring/archetypes, ed25519 signing + offline verify, and the CLI all work today (validated on real 2,000-line sessions). **Next:** Cursor/Codex parsers, the public verify page + shareable card, and a `--ci` mode that gates PRs on a minimum trust score. MIT, built in the open.

## License

MIT
