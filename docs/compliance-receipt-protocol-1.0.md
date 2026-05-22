# Compliance Receipt Protocol 1.0

> **Status:** Draft. Reference implementation in [`agent-memory-mcp`](https://github.com/xultrax-web/agent-memory-mcp) v0.11.2+.
> **Editor:** xultrax-web · agent-memory-mcp maintainer.
> **License:** This document is published under the [MIT License](../LICENSE), matching the reference implementation.

## Abstract

This document specifies the **Compliance Receipt Protocol** (CRP) — a protocol-level enforcement primitive for MCP (Model Context Protocol) servers. CRP defines short-lived, HMAC-signed bearer tokens with attached caveats that gate access to destructive or otherwise sensitive operations.

CRP solves a specific problem in MCP-based agent workflows: **MCP Sampling is unevenly supported across clients.** Claude Code, Cursor, Cline, and OpenAI Codex CLI — the most-used coding clients as of mid-2026 — do not implement MCP Sampling. Servers that need to enforce policy on agent actions therefore cannot rely on Sampling-based LLM judgment as a critical path. CRP gives servers a protocol-level enforcement mechanism that works on every MCP client because the server controls both ends (issue + validate).

CRP is intentionally narrow. It does not specify _what_ policies are enforced; only _how_ compliance with arbitrary server-defined policies is asserted and verified.

## Motivation

MCP servers expose tools to agents. Some of those tools are destructive (file deletes, database writes, deployments, refund issuance, etc.). Today, MCP servers have two ways to gate such tools:

1. **Trust the agent.** The agent reads server-provided instructions or static rules and "voluntarily" complies. The server has no protocol guarantee that the agent actually checked.
2. **MCP Sampling.** The server calls back to the LLM via `sampling/createMessage` to ask "does this action violate the rules?". Works well — when the client supports Sampling. Doesn't work at all on the four highest-use clients.

CRP defines a third option:

3. **Compliance Receipts.** The server publishes a separate tool (e.g. `check_action`) that the agent calls before any destructive operation. The server evaluates the proposed action against its rules and either issues a receipt or returns a structured rejection. Destructive tools require a valid receipt before executing. Because the server controls both ends of the receipt lifecycle (issue + validate), enforcement works on every client.

## Terminology

- **Server** · An MCP server implementing CRP.
- **Agent** · An MCP client interacting with the server.
- **Policy** · A constraint the server enforces. CRP does not specify policy semantics.
- **Receipt** · A signed token asserting that the server approved a specific action.
- **Caveat** · A constraint attached to a receipt that narrows its scope (e.g. "this receipt is only valid for action_type='deletions'").
- **Rules-version hash** · A digest of the current policy state. Receipts bind to this hash so that policy changes invalidate stale receipts.

## Receipt structure

A Compliance Receipt is a JSON object with the following fields:

```typescript
interface ComplianceReceipt {
  id: string; // 'rcpt_' + 16 hex chars (random, 64 bits of entropy)
  issued_at: number; // Unix epoch seconds, UTC
  expires_at: number; // Unix epoch seconds, UTC
  rules_version: string; // 16 hex chars (first 16 of sha256 of policy state)
  caveats: Caveat[]; // Attached constraints; may be empty
  signature: string; // 64 hex chars (HMAC-SHA256, lowercase)
}

interface Caveat {
  type: string; // Caveat kind; reserved values defined below
  value: string; // Type-specific value, exact-string-compared
}
```

### Field semantics

- **`id`** · Opaque identifier. MUST be unpredictable (cryptographic RNG); 64 bits of entropy is RECOMMENDED. Used for audit logging; not for security.
- **`issued_at`** · Seconds since the Unix epoch (UTC) when the receipt was issued.
- **`expires_at`** · Seconds since the Unix epoch (UTC) after which the receipt is invalid. MUST be strictly greater than `issued_at`. A 60-second default TTL is RECOMMENDED; servers MAY allow caller-controlled override within reasonable bounds.
- **`rules_version`** · A digest of the server's current policy state. MUST change whenever any policy that could affect approval decisions changes. Receipts MUST be rejected when the server's current `rules_version` does not match the receipt's value. See [Rules-version hashing](#rules-version-hashing).
- **`caveats`** · Zero or more constraints. Caveats are attenuations: holders can add caveats (narrow scope) but never remove them (widen). Each caveat is a `{type, value}` pair compared by exact string equality. See [Reserved caveat types](#reserved-caveat-types).
- **`signature`** · HMAC-SHA256 over the canonical form of the receipt excluding the signature itself, encoded as a 64-character lowercase hex string.

## Canonical encoding

To compute or verify a signature, the receipt MUST first be canonicalized:

1. Construct an object with the fields `{id, issued_at, expires_at, rules_version, caveats}` (note: the `signature` field is excluded).
2. Sort `caveats` by `(type, value)` ascending. Sort `type` first using lexicographic UTF-16 code-unit comparison; within the same `type`, sort `value` the same way.
3. Serialize the object using JSON with the following constraints:
   - No insignificant whitespace.
   - Keys in the order shown above (`id`, `issued_at`, `expires_at`, `rules_version`, `caveats`).
   - Numbers serialized as JavaScript would: no leading zeros, no trailing decimal point, integers as integers (not `1.0`).
   - Strings escaped per JSON RFC 8259.

The reference implementation uses `JSON.stringify` after a manual caveat sort, which produces compliant output in V8/JavaScriptCore/SpiderMonkey runtimes.

The canonical form is the byte sequence over which HMAC-SHA256 is computed.

## Signing

A server implementing CRP MUST maintain a private HMAC key, the **signing key**, as follows:

- The signing key MUST be at least 256 bits (32 bytes) of cryptographically secure random data.
- The signing key MUST be stored with access restricted to the server process (POSIX mode `0600` or equivalent on Windows).
- The signing key SHOULD be rotated periodically. Active receipts signed with a retired key SHOULD be rejected.
- The signing key MUST NOT be exposed in logs, transmitted to clients, or written to any location accessible to other processes.

The signature is computed as:

```
signature = lowercase_hex(HMAC_SHA256(signing_key, canonical_form))
```

The reference implementation stores the signing key at `<MEMORY_DIR>/.keyring/hmac-key` and rotates by overwriting the file (with operator opt-in via `agent-memory rotate-key` in a forthcoming release).

## Validation

To validate a receipt, an implementation MUST perform the following checks in order. If any check fails, the receipt MUST be rejected with a descriptive reason.

1. **Schema check** · Receipt has all required fields with correct types.
2. **Signature check** · Recompute the canonical form (steps in [Canonical encoding](#canonical-encoding)), recompute HMAC with the signing key, and compare to `receipt.signature` using a **constant-time** comparison (e.g. `crypto.timingSafeEqual` in Node, `hmac.compare_digest` in Python).
3. **Expiry check** · Current Unix time MUST be `<= expires_at`. Servers MUST use a monotonic or wall clock with second resolution.
4. **Rules-version check** · The receipt's `rules_version` MUST match the server's current `rules_version`. If the server allows transitions (e.g. a brief grace period), it MUST document the policy publicly.
5. **Required-caveat check** · The caller of `validate` provides a list of required caveats. Each must appear on the receipt (exact `(type, value)` match). Receipts with extra caveats beyond what is required are still valid — extra caveats are attenuations, not violations.

A receipt that passes all checks is **valid**. Implementations MAY perform additional checks (e.g. session binding) provided they reject only with documented reasons.

## Rules-version hashing

The `rules_version` field binds a receipt to the policy state at issuance time. Any change to a policy that could affect approval decisions MUST cause `rules_version` to change.

CRP does not mandate a specific hashing scheme. The reference implementation uses:

```
rules_version = first_16_hex_chars(SHA-256(concatenated_policy_contents))
```

where `concatenated_policy_contents` is the concatenation of policy files in canonical (sorted by path) order.

Implementations MAY use any approach (Merkle tree, content-addressed store, monotonic counter, etc.) as long as the property holds: **`rules_version` changes iff approval decisions might change.**

## Reserved caveat types

The following caveat `type` values are reserved by this specification. Implementations SHOULD honor them when present.

| Type             | Value semantics                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| `action_type`    | Action category the receipt approves (e.g. `"deletions"`, `"commits"`, `"file_writes"`). Server-defined values.     |
| `action_hash`    | Hash of the specific action description, for receipt-to-action binding. Servers SHOULD use first 16 hex of SHA-256. |
| `session`        | Session identifier. When present, the receipt is only valid in that session.                                        |
| `expires_before` | A second-level Unix timestamp. Validators MUST reject if current time exceeds this value (an additional expiry).    |

Other caveat types are reserved for future versions of this specification. Implementations MAY define custom caveat types prefixed with `x-` (e.g. `x-tenant-id`). Custom types without the `x-` prefix MAY conflict with future reserved types.

## Receipt lifecycle

```
                        Agent                          Server
                          │                              │
                          │  check_action(proposed)      │
                          ├─────────────────────────────►│
                          │                              │ Evaluate policy
                          │                              │ Issue receipt
                          │  Receipt {id, sig, caveats}  │
                          │◄─────────────────────────────┤
                          │                              │
                          │  destructive_tool(args,      │
                          │      receipt: <receipt>)     │
                          ├─────────────────────────────►│
                          │                              │ Validate receipt
                          │                              │ Execute action
                          │  ok                          │
                          │◄─────────────────────────────┤
                          │                              │
```

A typical lifecycle:

1. Agent proposes an action via a CRP-defined tool (e.g. `check_action`).
2. Server evaluates the action against its policies. On approval, issues a receipt and returns it. On denial, returns a structured rejection naming the policies that blocked.
3. Agent calls a destructive tool, passing the receipt as an argument.
4. Server validates the receipt against required caveats and current rules-version. Executes on success; refuses on failure.

## MCP integration

CRP is transport-agnostic. The reference implementation uses MCP Tools:

- A `check_action` tool returns the receipt as a JSON-encoded string inside the tool response.
- Destructive tools accept the receipt as an additional argument (object or JSON string).

CRP MAY also be carried in MCP Resources (e.g. for long-lived receipts) or Prompts. This specification does not constrain transport choice.

## Backwards compatibility

Implementations adopting CRP after launching destructive tools without receipts SHOULD support an **observation period** in which:

- Destructive tools accept calls without receipts and log the gap.
- The audit interface surfaces unreceipted destructive ops.
- A future version (typically a major release) makes receipts required.

The reference implementation uses this pattern: `delete_memory` accepts an optional `receipt` argument in v0.11.x and will require it in v0.12.0.

## Security considerations

- **Signing key compromise** · Exposes ability to mint arbitrary receipts. Implementations MUST protect the signing key and SHOULD rotate periodically.
- **Receipt replay** · Short TTLs and rules-version binding limit replay windows. Implementations MAY additionally track issued receipt IDs to enforce single-use semantics.
- **Caveat downgrade** · Macaroon-style caveats are _attenuations_; holders can only narrow, never widen. Validators MUST enforce required caveats by checking _presence_, not absence-of-prohibition.
- **Timing attacks** · Signature comparison MUST use constant-time equality. The reference implementation uses `crypto.timingSafeEqual`.
- **Time skew** · If clocks differ between issuing and validating systems, `expires_at` checks MAY produce false rejections or false accepts. CRP is designed for same-process issue+validate (a single MCP server), where skew is not a concern.

## Cross-server adoption

CRP is designed so multiple MCP servers can honor receipts issued by a coordinator server. To interoperate:

- The coordinator publishes its public verification material (out of scope for v1.0; will be specified in v1.1 with asymmetric signing).
- Honoring servers store the verification material and validate receipts against it.
- Receipts MUST carry sufficient caveats for the honoring server to determine which action the receipt approves.

**v1.0 limitations:** This version uses HMAC, which requires shared secrets. Cross-server adoption in v1.0 is therefore limited to tightly coupled deployments where servers can share a key. v1.1 will define an asymmetric (Ed25519) signing mode for true federation.

## Test vectors

Reference test vectors for canonical encoding and signature computation:

### Vector 1: minimal receipt with no caveats

```
key            (hex)  = "0000000000000000000000000000000000000000000000000000000000000000"
id                    = "rcpt_0123456789abcdef"
issued_at             = 1700000000
expires_at            = 1700000060
rules_version         = "a1b2c3d4e5f60718"
caveats               = []

canonical form        = {"id":"rcpt_0123456789abcdef","issued_at":1700000000,"expires_at":1700000060,"rules_version":"a1b2c3d4e5f60718","caveats":[]}

expected signature    = (computed by reference implementation)
```

### Vector 2: receipt with two caveats (out of order on input)

```
caveats (as supplied) = [
  {"type": "session", "value": "abc"},
  {"type": "action_type", "value": "deletions"}
]

caveats (canonical)   = [
  {"type": "action_type", "value": "deletions"},
  {"type": "session", "value": "abc"}
]
```

(Sorted by `type` lexicographically; `"action_type"` < `"session"`.)

A full test-vector file will accompany the reference implementation at `tests/crp-vectors.json` in a forthcoming release.

## Versioning

This document specifies **CRP 1.0**. Future versions will be backwards-compatible at the receipt structure level (additive fields with default values) and will define a `version` caveat (e.g. `{type: "crp_version", value: "1.1"}`) for explicit version negotiation when needed.

Implementations MUST reject receipts whose structure does not conform to the version they claim to support.

## Reference implementation

The reference implementation lives at:

- Repository: <https://github.com/xultrax-web/agent-memory-mcp>
- Package: `@xultrax-web/agent-memory-mcp` on npm (v0.11.2+)
- MCP Registry: `io.github.xultrax-web/agent-memory-mcp`

Source files:

- `src/index.ts` · `issueReceipt`, `validateReceipt`, `canonicalizeReceipt`, `computeRulesVersion`
- `tests/receipts.test.ts` · primitive tests
- `tests/check_action.test.ts` · CRP-via-MCP-tool integration tests

## Acknowledgments

CRP is built on **Macaroons** as described in:

> A. Birgisson, J. G. Politz, Ú. Erlingsson, A. Taly, M. Vrable, M. Lentczner, "Macaroons: Cookies with Contextual Caveats for Decentralized Authorization in the Cloud", _Proceedings of the Network and Distributed System Security Symposium (NDSS)_, 2014. <https://research.google/pubs/pub41892/>

CRP narrows the Macaroon model to a specific use case (MCP destructive-tool gating), simplifies the caveat language (exact string match only, no predicate language), and adds rules-version binding for policy-change invalidation.

## Change log

| Version | Date       | Notes                                                |
| ------- | ---------- | ---------------------------------------------------- |
| 1.0     | 2026-05-22 | Initial draft. Reference implementation in v0.11.2+. |
