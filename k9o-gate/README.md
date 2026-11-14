# @k9o/gate-react-native

Official React Native SDK for [Kilimanjaro](#116-about-kilimanjaro) Gate.
Sign users in from your React Native app with Gate: sign in, refresh the session and sign out, with the refresh token kept in the device's
secure storage. A Gate token also scopes each data request to the signed-in user.

## Contents

**A. Get started**

1. [Links](#1-links)
2. [Install](#2-install)
3. [Choose the right package](#3-choose-the-right-package)
4. [Quick start](#4-quick-start)

**B. Sessions**

5. [Refresh and sign out](#5-refresh-and-sign-out)
6. [Session lifetime](#6-session-lifetime)
7. [Token storage](#7-token-storage)

**C. Use the token**

8. [Custom claims](#8-custom-claims)

**D. Other end-user flows**

9. [Passkeys, authenticator apps, password reset and invitations](#9-passkeys-authenticator-apps-password-reset-and-invitations)

**E. Troubleshoot**

10. [Handle errors](#10-handle-errors)

**F. Reference**

11. [Appendix](#11-appendix)
    - 11.1 [Requirements](#111-requirements)
    - 11.2 [Client options](#112-client-options)
    - 11.3 [Error codes](#113-error-codes)
    - 11.4 [Methods](#114-methods)
    - 11.5 [Related packages](#115-related-packages)
    - 11.6 [About Kilimanjaro](#116-about-kilimanjaro)
12. [License](#12-license)

## A. Get started

### 1. Links

- Website: <https://kilimanjaro.dev>
- Documentation / Developer Hub: <https://docs.kilimanjaro.dev>
- Open source
  - Platform: <https://github.com/k9o-platform>
  - Community: <https://github.com/k9o-community>

### 2. Install

```bash
npm install @k9o/gate-react-native react-native-keychain
```

Yarn works too: `yarn add @k9o/gate-react-native react-native-keychain`. See [requirements](#111-requirements) for versions.

### 3. Choose the right package

| Package | Use it when you are… | Registry | Source |
| --- | --- | --- | --- |
| `@k9o/core-react-native` | Calling the platform from a React Native app as a signed-in user. | [npm](https://www.npmjs.com/package/@k9o/core-react-native) | [sdk-react-native](https://github.com/k9o-platform/sdk-react-native) |
| `@k9o/gate-react-native` | Signing users in: sign in, refresh and sign out. | [npm](https://www.npmjs.com/package/@k9o/gate-react-native) | [sdk-react-native](https://github.com/k9o-platform/sdk-react-native) |
| `@k9o/kibo-react-native` | Encrypting and decrypting with a key you hold in your own KMS. | [npm](https://www.npmjs.com/package/@k9o/kibo-react-native) | [sdk-kibo-react-native](https://github.com/k9o-platform/sdk-kibo-react-native) |
| `@k9o/barbican-react-native` | Checking model input and redacting model output on your own machine, with no account. | [npm](https://www.npmjs.com/package/@k9o/barbican-react-native) | [sdk-barbican-react-native](https://github.com/k9o-platform/sdk-barbican-react-native) |

### 4. Quick start

The examples use a `tasks` app whose users sign in to the `member-portal` project. See [client options](#112-client-options) for the constructor.

```ts
import { GateClient } from "@k9o/gate-react-native";

const gate = new GateClient({
  orgBaseUrl: "https://acme.api.k9o.io",
  projectSlug: "member-portal",
});
```

Sign in. The refresh token is saved to the keychain for you.

```ts
const result = await gate.signIn({ email: "user@example.com", password: "correct-horse" });

console.log(`Output: ${result.user.email}`);
console.log(`Output: ${result.session.expiresAt}`);
```

```text
Output: user@example.com
Output: 2026-01-15T10:30:00.000Z
```

The result has a `user` and a `session`. See [methods](#114-methods).

Sign-in first asks the project which region holds the email: one extra request that carries only the email. The SDK sends the
password only to a region host of your own organization and apex, and otherwise to the base URL. Nothing from that step is cached,
apart from a note of which region issued the session so that refresh and sign-out go to the same place. A `429` or `503` from that
step is raised as the usual `GateError` (`RATE_LIMITED` or `GATE_REGION_UNAVAILABLE`) and is safe to retry. If the project's locate step answers 404, the client uses the base address.

[↑ Back to Contents](#contents)

## B. Sessions

### 5. Refresh and sign out

With no arguments, `refreshToken` reads the stored refresh token and returns a new access token and the next refresh token.
Each refresh replaces the refresh token: the one you sent stops working. The client saves the new one to the keychain before `refreshToken` returns, and it refreshes one at a time, so calls made together share one request and a token is never sent twice.

```ts
const refreshed = await gate.refreshToken();

console.log(`Output: ${refreshed.accessToken.length > 0}`);
console.log(`Output: ${refreshed.expiresAt}`);
```

```text
Output: true
Output: 2026-01-15T11:30:00.000Z
```

`signOut` ends the session on the server and clears the keychain. It does nothing if no token is stored.

```ts
await gate.signOut();
```

### 6. Session lifetime

Three settings control how long an end user's session lasts. A project administrator sets them for the project in the Console, under the project's Gate settings, Sessions. The values below are the defaults, and each has a range:

| Setting | Default | Range |
|---|---|---|
| Access token lifetime | 30 minutes | 5 to 60 minutes |
| Sign out after inactivity | 30 days | 1 hour to 90 days |
| Maximum session length | 90 days | 1 hour to 365 days |

Refresh is where the limits are checked. Inactivity counts from the last successful refresh, so it is measured to within one access-token lifetime. A refresh token never outlasts either limit. A changed setting applies to existing sessions at their next refresh, and a shorter maximum ends the sessions already past it.

- **A refresh token works once.** Each refresh answers a new refresh token and the old one stops working. Sending an old one again counts as a replay: the gateway ends the session, and the refresh fails with `UNAUTHENTICATED`, `statusCode` 401 and `sessionEndReason` `replay`. The new token then fails the same way, with `revoked`. The client clears the keychain on any of these, and the user must sign in again.
- **A session that has ended says why.** `sessionEndReason` on the `GateError` is `inactive` (past the sign-out-after-inactivity limit), `max_length` (past the maximum session length), `revoked` (signed out, ended by a password reset, or ended by `revokeAllSessions`) or `replay` (see above). It is kept when `errors` is `"redacted"`. A token the gateway does not know, or one for a locked user, fails with `INVALID_CREDENTIALS` and also clears the keychain.
- **Keep your own refresh token only if you must.** If your app keeps a copy outside the keychain, replace it with the `refreshToken` that each refresh returns, and never refresh from two places at once.
- **`signOut` ends this device's session.** It revokes the session that the stored refresh token belongs to. The same user's sessions on other devices stay valid.
- **`revokeAllSessions({ accessToken })` ends every session of the user.** Pass the access token that `signIn` or `refreshToken` returned, not a refresh token. It ends the user's sessions on every device, this one included, deletes the stored refresh token and returns how many sessions ended. Each ended session's next refresh is refused with `K9O_SESSION_EXPIRED`; `sessionEndReason` on the `GateError` is `revoked`. An operator's token is refused with `K9O_TRUST_ZONE_VIOLATION` (403), and a token issued for another project with `K9O_PROJECT_SCOPE_MISMATCH` (403). The stored token is left as it was when the call fails. Access tokens already issued keep working until they expire, so drop yours too.
- **An access token outlives sign-out.** One that was already issued keeps working until it expires, up to the access token lifetime you set, because it carries no session id and Gate keeps no list of revoked access tokens. The exception is a user who is no longer active: a locked or erased user's access tokens are refused at once.
- **A session that has passed a limit is refused.** The refresh answers 401 `K9O_SESSION_EXPIRED`, and `context.reason` is `inactive`, `max_length`, `revoked` (after sign-out) or `replay` (a used refresh token sent again). Send the user through sign-in again.
- **A password reset ends every existing session of that user.** The session the reset itself opens stays. Erasing a user locks them and revokes every session; an administrator's reset of a user's second factor also revokes every session.

### 7. Token storage

By default the refresh token lives in the iOS Keychain or Android Keystore, through `react-native-keychain`.

To store it elsewhere, pass a `TokenStore`. This one keeps it in memory, which suits tests.

```ts
import { GateClient } from "@k9o/gate-react-native";
import type { TokenStore } from "@k9o/gate-react-native";

class MemoryTokenStore implements TokenStore {
  private token: string | null = null;

  async save(token: string): Promise<void> {
    this.token = token;
  }

  async load(): Promise<string | null> {
    return this.token;
  }

  async delete(): Promise<void> {
    this.token = null;
  }
}

const gate = new GateClient({
  orgBaseUrl: "https://acme.api.k9o.io",
  projectSlug: "member-portal",
  tokenStore: new MemoryTokenStore(),
});
```

[↑ Back to Contents](#contents)

## C. Use the token

### 8. Custom claims

The token carries each extension claim as a flat key, `ext.<namespace>.<name>`.
`customClaims` groups them as `{ namespace: { name: value } }`. Decoding does not verify the signature.

```ts
import { AccessToken } from "@k9o/gate-react-native";

const token = AccessToken.decode(result.session.accessToken);

if (token !== null) {
  const claims = token.customClaims;
  const partners = claims["partners"];

  if (partners !== undefined) {
    const role = partners["partner_role"];
    console.log(`Output: ${role}`);
  }
}
```

```text
Output: extension_org_admin
```

`token` also has `subject`, `issuer`, `issuedAt`, `expiresAt` and `allClaims`.

[↑ Back to Contents](#contents)

## D. Other end-user flows

### 9. Passkeys, authenticator apps, password reset and invitations

These calls are the wire layer. They carry data between your app and the gateway. The passkey calls do not open the platform's passkey sheet: you pass `begin`'s options to the platform's passkey API (for example a passkey library) and pass the credential it returns to `finish`.

Calls that need a bearer token take it as `{ bearerToken }`. React Native has no partner token, so you pass it each time: the end user's access token for the calls an end user makes, and the token your backend authenticates with for `verifySession`. Calls that answer a session store its refresh token in the keychain, as `signIn` does.

| Call | What it needs | Answer |
|---|---|---|
| `passkeys.register.begin({ bearerToken })` | The end user's access token | The registration options, with `challenge` |
| `passkeys.register.finish({ response, label? }, { bearerToken })` | The end user's access token; the credential the authenticator made | `{ passkey: { id, credentialId } }` |
| `passkeys.signIn.begin({ email? })` | Nothing; `email` is optional | The authentication options, with `challenge` |
| `passkeys.signIn.finish({ response })` | The assertion the authenticator made | `{ session }` |
| `mfa.totp.enroll({ label? }, { bearerToken })` | The end user's access token | `{ factor: { id, secret, uri } }`; the secret is shown once |
| `mfa.totp.confirm({ factorId, code, currentCode? }, { bearerToken })` | The end user's access token; `currentCode` to add a second authenticator | `{ factor: { id, verifiedAt }, session? }` |
| `mfa.methods.list({ bearerToken })` | The end user's access token | `{ methods: [{ id, type, label, verifiedAt, createdAt }] }`, oldest first |
| `mfa.methods.delete(methodId, { bearerToken, code? })` | The end user's access token; `code`, a current code from the authenticator, to remove a confirmed one | `{ deleted }` |
| `passwordReset.request({ email })` | Nothing | `{ reset: { requested, expiresAt? } }`, the same whether or not the email has an account |
| `passwordReset.redeem({ token, newPassword })` | The token from the email | `{ redeemed, endUserId }` and a `session`, or an `mfa` challenge when the account has a confirmed authenticator |
| `invitations.redeem({ token, password, displayName? })` | The token from the invitation | `{ redeemed, user, session }` |
| `verifySession({ token }, { bearerToken })` | The token your backend authenticates with | `{ valid: true, claims }`, or `{ valid: false, reason }` for a refused token |

```ts
const options = await gate.passkeys.signIn.begin({ email: "ada@example.test" });
// Pass `options` to the platform's passkey API and send the assertion it returns.
const { session } = await gate.passkeys.signIn.finish({ response: assertion });

const factor = await gate.mfa.totp.enroll({ label: "Phone" }, { bearerToken: session.accessToken });
console.log(`Output: ${factor.factor.uri.startsWith("otpauth://")}`);
```

```text
Output: true
```

A wrong, expired or used challenge or token raises a `GateError` with code `K9O_INVALID_FIELD_VALUE` (400). A wrong authenticator code raises `INVALID_CREDENTIALS` (401). Adding a second authenticator without `currentCode`, or removing a confirmed one without `code`, raises `K9O_MFA_REQUIRED`. `passwordReset.request` raises `K9O_EMAIL_NOT_CONFIGURED` (503) on a deployment without a mail relay.

[↑ Back to Contents](#contents)

## E. Troubleshoot

### 10. Handle errors

Every failure is a `GateError`. Check `code`.

```ts
import { GateError } from "@k9o/gate-react-native";

try {
  await gate.signIn({ email: "user@example.com", password: "wrong" });
} catch (error) {
  if (error instanceof GateError && error.code === "INVALID_CREDENTIALS") {
    console.log(`Output: ${error.message}`);
  }
}
```

```text
Output: Invalid credentials.
```

See [error codes](#113-error-codes) for all of them.

Show `publicMessage` to your users. It is a fixed sentence chosen by the kind of failure, never the gateway's text. Log `requestId` with it so support can find the request. `message`, `recommendation` and `context` are for your logs: they carry the gateway's own wording and detail. A gateway code this client does not type, such as `K9O_MAGIC_LINK_REDIRECT_NOT_CONFIGURED`, comes through as `code`, so a configuration fault is not read as a transient one. Pass `errors: "redacted"` to the client if you want those details removed; `code` then becomes `UNKNOWN` for an unknown gateway code, and `message` equals `publicMessage`.

| Field | Contents |
|---|---|
| `publicMessage` | The sentence to show to your users. Chosen by status class only |
| `requestId` | The `x-k9o-request-id` response header, or `null`. Log it |
| `errors` (client option) | `"full"` (default) or `"redacted"`. Redacted keeps `code`, `statusCode`, `requestId`, `publicMessage` and `retryAfterSec`, and drops `message`, `recommendation`, `context` and `body` |

[↑ Back to Contents](#contents)

## F. Reference

### 11. Appendix

- [Requirements](#111-requirements)
- [Client options](#112-client-options)
- [Error codes](#113-error-codes)
- [Methods](#114-methods)
- [Related packages](#115-related-packages)
- [About Kilimanjaro](#116-about-kilimanjaro)

#### 11.1 Requirements

| Requirement | Version |
|---|---|
| React | 18 or later |
| React Native | 0.74 or later |
| `react-native-keychain` | 8 or later (follow its native setup) |
| TypeScript (optional) | 5.3 or later |

#### 11.2 Client options

`new GateClient({ orgBaseUrl, orgSlug, projectSlug, tokenStore?, errors? })`

| Option | Required | Meaning |
|---|---|---|
| `orgBaseUrl` | Optional when `orgSlug` is given | Your organization's API host, such as `https://acme.api.k9o.io`; any apex works |
| `orgSlug` | Optional when `orgBaseUrl` is given | Your organization's slug, such as `acme` |
| `projectSlug` | Yes | The project users sign in to |
| `tokenStore` | No | Where the refresh token is kept; the keychain by default |
| `errors` | No | `"full"` (default) or `"redacted"`; what a `GateError` carries. See [Handle errors](#10-handle-errors) |

Pass `orgSlug` to use your organization's host: `orgSlug: "acme"` sends requests to `https://acme.api.k9o.io`. A full organization `orgBaseUrl` or a custom domain is used as given, and `orgSlug` does not change it. With neither `orgBaseUrl` nor `orgSlug`, construction throws a `GateError` with code `K9O_INVALID_BASE_URL` and context `{ field: "baseUrl" }`. A malformed `orgSlug` throws a `GateError` with code `K9O_INVALID_FIELD_VALUE` and context `{ field: "orgSlug", slug }`.

#### 11.3 Error codes

| Code | When |
|---|---|
| `INVALID_CREDENTIALS` | Wrong email or password |
| `RATE_LIMITED` | Too many sign-in attempts; safe to retry |
| `GATE_REGION_UNAVAILABLE` | The region that holds the email is unavailable; safe to retry |
| `UNAUTHENTICATED` | The session expired, or no refresh token is stored. `sessionEndReason` says why when the gateway ended the session |
| `FORBIDDEN` | The session is not allowed to do this |
| `NETWORK` | The request could not reach the server |
| `DECODING` | The response was not in the expected shape |
| `UNKNOWN` | Any other response; `statusCode` and `body` are set. A gateway `K9O_*` code this client does not type is its own `code` (for example `K9O_MAGIC_LINK_REDIRECT_NOT_CONFIGURED`), unless `errors` is `"redacted"` |

#### 11.4 Methods

| Method | What it does |
|---|---|
| `signIn({ email, password })` | Sign in; resolves to `{ user, session }` |
| `refreshToken({ refreshToken? })` | Resolves to `{ accessToken, refreshToken, expiresAt }` and stores the new refresh token; uses the stored token when none is passed |
| `signOut({ refreshToken? })` | Revoke the session and clear the stored token; does nothing without a token |
| `revokeAllSessions({ accessToken })` | End every session of the user, on every device, and clear the stored token; resolves to how many ended |
| `passkeys.register.begin`, `.finish`; `passkeys.signIn.begin`, `.finish` | Passkey registration and sign-in, as data between your app and the gateway; see [section 9](#9-passkeys-authenticator-apps-password-reset-and-invitations) |
| `mfa.totp.enroll`, `mfa.totp.confirm` | Set up an authenticator app |
| `mfa.methods.list`, `mfa.methods.delete` | List and remove the end user's second factors |
| `passwordReset.request`, `passwordReset.redeem` | Reset a password with an emailed token |
| `invitations.redeem` | Accept an invitation |
| `verifySession({ token }, { bearerToken })` | Check an end user's access token from your backend |
| `AccessToken.decode(jwt)` | Read an access token's claims; `null` if it is not a JWT |

| Result field | Contents |
|---|---|
| `user` | `id`, `email`, `status`, `roles`, `groups`, timestamps |
| `session` | `accessToken`, `refreshToken`, `expiresAt` |
| refresh result | `accessToken`, `refreshToken`, `expiresAt` |

#### 11.5 Related packages

| Package | Purpose |
|---|---|
| `@k9o/kibo-react-native` | Client-side encryption with your own KMS |
| `@k9o/core` | The TypeScript SDK for the rest of the platform |

#### 11.6 About Kilimanjaro

Kilimanjaro is a modular developer platform for building secure enterprise applications. You define AI agents, functions and data pipelines
on the platform. The SDKs let you deploy and invoke them, read and write your data, publish to and subscribe to streams, sign users in, and
encrypt with keys you hold.

It provides four building blocks:

- **Keep**: AI security and governance. Guardrails and policy for the agents you run.
- **Pulse**: data intelligence and real-time stream processing. Streams, analytics and live feeds.
- **Gate**: customer identity and access management. Sign-in and sessions, and automatic data scoping so a signed-in user reaches only their own data.
- **Kibo**: cryptographic keys and secrets management. Client-side encryption with keys you hold, and a secrets vault.

### 12. License

Apache-2.0 © Formelo Inc. See `LICENSE` and `NOTICE`.

[↑ Back to Contents](#contents)
