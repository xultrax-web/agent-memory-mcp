# Changelog

## 0.15.0 — Real enforcement, zero-config guardrails, semantic recall

### Added

- **Real enforcement via host hooks.** `agent-memory hook` plugs into Claude
  Code's `PreToolUse` hook: it maps the agent's proposed Bash command / file
  write to a rule category and **denies** the call on a hard-rule match (**asks**
  on soft). `agent-memory install-hooks` wires it into `settings.json` (project
  or `--global`), idempotently. Rules now enforce on the agent's REAL actions,
  not just the server's own `delete_memory`.
- **`agent-memory init`** (and the `init` tool) — a starter guardrail pack
  (protect main, no `rm -rf`, no prod-data destruction, no `curl|sh`, flag
  secrets) emitted to every tool. Zero-config protection on first install.
- **Semantic recall (opt-in).** Set `AGENT_MEMORY_EMBED_MODEL` (optional
  `AGENT_MEMORY_EMBED_URL`, default local Ollama) and `relevant_memories` ranks
  by embedding cosine similarity, cached on disk per (model, content-hash).
  Falls back silently to lexical when unset or unreachable.
- **CRP federation.** `validate_receipt` tool + `agent-memory validate-receipt`
  CLI validate ANOTHER server's CRP 1.1 (Ed25519) receipt with its public key —
  no shared secret. The primitive that makes Compliance Receipts a standard.
- One-click install: `smithery.yaml` + a Cursor "Add to Cursor" deeplink badge.

### Improved

- **Better default recall.** `relevant_memories` blends Fuse with query/body
  token overlap, so reworded queries that share keywords surface results Fuse
  alone returned nothing for.
- `--version` now reports the real package version (was hard-coded `0.2.0`).

## 0.14.0 — Security hardening

### Security

- **Critical · the signing key no longer leaks via `sync`.** `.keyring/` (the
  receipt-signing HMAC key and Ed25519 private key) was not in the sync ignore
  list, so `sync init` / `sync push` committed and pushed it to the remote —
  anyone with read access to the synced repo could forge Compliance Receipts for
  any action. The keyring (and the new single-use ledger) are now always
  excluded from sync, a new hygiene step rewrites the ignore policy and
  `git rm --cached`s a keyring that an older version already committed, and
  `doctor` flags a git-tracked keyring with remediation steps.
- **Receipts are bound to their target.** `delete_memory` now requires the
  receipt's `action_hash` caveat to match `delete memory <name>`, so a receipt
  minted for one memory can no longer be used to delete a different one.
- **Receipts are single-use.** A consumed receipt is rejected for the rest of its
  TTL (replay protection), tracked in a per-machine, auto-pruned ledger and
  enforced inside the write lock so it can't be double-spent.
- **ReDoS protection.** Rule `matches` patterns are screened for catastrophic
  backtracking (nested unbounded quantifiers like `(a+)+`): rejected at
  `save_rule`, skipped defensively at check time (for hand-edited / imported /
  federated rules), and the tested input is length-capped.

### Added

- **`rotate_key`** tool + `agent-memory rotate-key` CLI — regenerate the HMAC /
  Ed25519 signing keys, immediately invalidating every outstanding receipt. The
  remediation path after a suspected key leak.

### Fixed

- The event log (`.events.jsonl`) now rotates at 5 MB instead of growing
  unbounded (keeps one previous generation, `.events.jsonl.1`).
- Atomic writes use a `pid + random` temp-file name to avoid same-process
  collisions before the rename.

### Upgrading

If you ever ran `sync` on a previous version, your signing key was pushed to the
remote. Run `agent-memory rotate-key`, then `agent-memory sync push` (which now
auto-untracks the keyring), and purge `.keyring` from the remote's git history.
