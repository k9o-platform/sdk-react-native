# @k9o/core-react-native — Changelog

## 1.5.2

### Changed

- `K9O_TIER_FEATURE_GATED` is no longer documented as an error to expect: the platform no longer gates features by plan.
- README: Architecture at a glance, illustrations, and the package table lists only the packages for that SDK.

## 1.5.0

### Added

- `orgSlug` as an alternative to `baseUrl`: `new CoreClient({ orgSlug: 'acme', ... })` uses `https://acme.api.k9o.io`, and a platform host such as `https://api.k9o.io` plus `orgSlug` becomes the organization host. A full organization `baseUrl` or a custom domain is used as given. With neither, the constructor throws a `KError` with code `K9O_INVALID_BASE_URL` and context `{ field: 'baseUrl' }`; a malformed slug throws a `KError` with code `K9O_INVALID_FIELD_VALUE` and context `{ field: 'orgSlug', slug }`. `baseUrl` is now optional in `CoreClientConfig`.
- `rampart`: `classify`, `jwks` and `verifyReceipt` for hosted content classification. Receipts are checked in the SDK with its own Ed25519 (RFC 8032), SHA-256 and SHA-512 and the platform canonical JSON form (`jcsCanonicalize`); the check needs `BigInt` (Hermes in React Native 0.70 or later). A long input is scored in overlapping windows and the highest injection score decides; past 16 windows (about 6,000 tokens) the answer is 413 `K9O_RAMPART_INPUT_TOO_LONG` with no verdict (`RAMPART_ERROR_CODES`, `isRampartInputTooLong`), and 503 `K9O_RAMPART_CLASSIFIER_UNAVAILABLE` still means the classifier could not answer. The verified receipt exposes `windows` (1 when the receipt has no such claim); unknown claims are ignored and a `windows` that is not a whole number of at least 1 is refused as `malformed`.
- `Moat`: a local guard around a model call. It pins the system prompt, refuses role markers in the input (also in nested values and keys), checks an input schema and an output schema, and runs a PII filter you pass. No network call. Marker matching follows the Moat contract: NFKC, combining marks (Mn, Me) removed, default-ignorable and format characters removed, a small set of Cyrillic and Greek look-alikes of the marker letters mapped to Latin (not general homoglyph detection), case-folded, horizontal whitespace collapsed, matched line by line.
- `metadata`: `filter`, `set`, `search`, `vectors.nearest`, `index.get` and `index.declare` for the columns you declare on a collection. Column names in `where`, `search` and `nearest` get the `metadata.` prefix when you leave it out; `set` writes declared columns only. The client checks the surface grammar, limits, cursor rule and the 64-column limit before sending. Gateway codes such as `K9O_METADATA_FIELD_NOT_INDEXED`, `K9O_UNKNOWN_SURFACE` and `K9O_QUERY_RESULT_TOO_LARGE` arrive as `KError`. There is no `metadata.subscribe`.
- `realtime`: `subscribe(topic, { filter, signal, onResync, ... })` follows a topic over Server-Sent Events, reconnecting with `Last-Event-ID`, yielding each event once and calling `onResync` when the gateway cannot resume. `replay(topic, { fromSequence, untilSequence, limit, afterAuditEventId })` reads one page of the topic's ledger and returns `{ topic, events, nextCursor, hasMore, resync? }`; `resync` is `reread-source` when the topic keeps no ledger (only `audit.project.*` topics do). The client checks the topic length, sequences, `limit` (1 to 10000) and `afterAuditEventId` before sending.
- `vectorSearch` on the select builder sends the embedding in the request body.
- `KError.retryAfterSec`: seconds the gateway asks you to wait, or `null`.

### Fixed

- `KError.requestId` is now filled from the gateway's `x-k9o-request-id` response header when the error body carries no `requestId`. It was `null` before.
- `KError.recommendation` is now filled when the gateway sends it as an object: the object's `action` text, or its `note`. It was `null` before.
- A client configured with the region-free address (`https://<org>.api.<domain>`) now works: calls with credentials were refused with `400 K9O_INVALID_REQUEST_SHAPE`. The client learns the regional host with one credential-free `HEAD` to the configured address, caches it and sends every request there. A regional address is used as given, with no probe.

### Added

- `requireApproval()` on single-record `insert`, `update` and `delete` (`core.from('orders').insert({...}).requireApproval()`): the write is queued for approval (HTTP 202) instead of applied. The result is the queued change (`QueuedChange`) or, when an `auto_approve` policy applies the write at once, the normal result; `isQueuedWrite(result)` tells them apart. Upserts and bulk writes do not take it.
- `ai.generate` accepts `usageType`.
- `vectors.nearest` and `vectors.upsert`: search an embedding collection with the vector in the request body, and store rows in it.

## 1.4.0 — 2026-10-26

### Added

- `query(sql, params)`: run one read-only SQL statement with positional (`$1`) or named (`:name`) parameters.
- `search(collection, { column, q })`: full-text search over one text column, best matches first.
- `from(collection)`: `select`, `insert`, `update` and `delete` with filters, `limit`, `cursor`, `count`, `textSearch` and `vectorSearch`.
- `storage`: buckets, uploads (including a picked file by `uri`), listings, removal and signed URLs.
- `streams`: `create`, `list`, `get`, `delete`, `publish`, `replay` and `subscribe`.
- `ai.generate`: generate text from a prompt (the org's default model unless `model` is given) and read the generated text, finish reason and token usage.

### Changed

- README description and sections for the new calls.

## 1.3.0 — 2026-10-26

### Changed

- The README is rewritten with install steps, a runnable example with its expected output and a reference appendix.
- Version aligned with the other SDKs. `ai.embed` is the only call.

## 1.0.0 First public release

First public release. See the README for the full API overview.
