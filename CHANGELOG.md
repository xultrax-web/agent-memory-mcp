# Changelog

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
