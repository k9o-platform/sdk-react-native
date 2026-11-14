# @k9o/gate-react-native — Changelog

## 1.5.2

### Changed

- README: Architecture at a glance, illustrations, and the package table lists only the packages for that SDK.

## 1.5.0

### Added

- The end-user flow calls, as the wire layer: `passkeys.register.begin` and `.finish`, `passkeys.signIn.begin` and `.finish`, `mfa.totp.enroll` and `.confirm`, `passwordReset.request` and `.redeem`, `invitations.redeem`, and `verifySession`. The passkey calls carry the options and credentials between your app and the gateway; they do not call the platform's passkey API. Calls that need a bearer token take `{ bearerToken }`. Calls that answer a session store its refresh token in the keychain. The names and shapes match `@k9o/gate`.
- `mfa.methods.list({ bearerToken })` and `mfa.methods.delete(methodId, { bearerToken, code? })`: the end user lists and removes their own second factors. Removing a confirmed authenticator app takes its current code as `code`. The names and shapes match `@k9o/gate`.
- `orgSlug` as an alternative to `orgBaseUrl`: `new GateClient({ orgSlug: "acme", ... })` uses `https://acme.api.k9o.io`, and a platform host such as `https://api.k9o.io` plus `orgSlug` becomes the organization host. A full organization `orgBaseUrl` or a custom domain is used as given. With neither, the constructor throws a `GateError` with code `K9O_INVALID_BASE_URL` and context `{ field: "baseUrl" }`; a malformed slug throws a `GateError` with code `K9O_INVALID_FIELD_VALUE` and context `{ field: "orgSlug", slug }`. `orgBaseUrl` is now optional.
- `signIn` first asks the project which region holds the email (one extra request with only the email) and sends the password to that region's host, if it is a region host of your own organization and apex; otherwise to the base URL. `refreshToken` and `signOut` go to the region that issued the session.
- `GateError` codes `RATE_LIMITED` and `GATE_REGION_UNAVAILABLE`, raised when that step answers `429` or `503`. Nothing is retried and no password is sent. If that step answers `404`, the client uses the base URL instead.
- `GateError.publicMessage`: a fixed sentence an app shows to its users, chosen by status class (401/403, 404, 429, 5xx, network failure, anything else). It never carries gateway text.
- `GateError.requestId`: the `x-k9o-request-id` response header, or `null`.
- `GateError.retryAfterSec`: the wait the gateway asked for, from the body's `recommendation` or the `Retry-After` header given in seconds; `null` when there is none.
- `GateClient` option `errors: "full" | "redacted"` (default `"full"`). `"redacted"` keeps `code`, `statusCode`, `requestId`, `publicMessage` and `retryAfterSec`, and sets `message` to `publicMessage`; it drops `recommendation`, `context` and `body`. Any other value throws a `GateError` with code `K9O_INVALID_FIELD_VALUE` and context `{ field: "errors", value }`.

### Changed

- README description.
- A gateway `K9O_*` code this client does not type keeps its wire code as `GateError.code` (for example `K9O_MAGIC_LINK_REDIRECT_NOT_CONFIGURED`), with `recommendation`, `context` and `requestId`. Before, it was reported as `UNKNOWN` with no code. With `errors: "redacted"` it is `UNKNOWN`. Known codes are unchanged.
- `GateError.code` is typed as `GateErrorCode` or any other string, so an unknown gateway code type-checks.

## 1.3.0 — 2026-10-26

### Changed

- `refreshToken({ refreshToken? })` resolves to `{ accessToken, expiresAt }`. It leaves the token store alone.
- `refreshToken` no longer takes `projectHint`.
- `AccessToken.customClaims` groups the token's flat `ext.<namespace>.<name>` keys as `{ namespace: { name: value } }`.
- Regional host lookup works for any `<org>.api.<apex>` host. No apex is hardcoded.

### Removed

- The `projectHint` input of `refreshToken`.

### Added

- Nothing.

## 1.1.1 — 2026-10-25

- Documentation links corrected: the documentation hub is https://docs.kilimanjaro.dev, with the website, platform API and console listed in a Links section. Package metadata points at the same places.

## 1.1.0 — 2026-10-25

- Documentation rewritten with runnable examples and expected output; internal cross-references removed from the published sources. No change to the public API.

## 1.0.0 — 2026-10-23

First public release. See the README for the full API overview.
