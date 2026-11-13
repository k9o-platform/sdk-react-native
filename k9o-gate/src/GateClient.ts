import { ErrorsMode, GateError } from "./GateError";
import {
  AuthResult,
  BearerOptions,
  BeginPasskeySignInInput,
  ConfirmTotpInput,
  ConfirmTotpResult,
  DeleteMfaMethodOptions,
  DeleteMfaMethodResult,
  ListMfaMethodsResult,
  EnrollTotpInput,
  EnrollTotpResult,
  FinishPasskeyRegistrationInput,
  FinishPasskeyRegistrationResult,
  FinishPasskeySignInInput,
  FinishPasskeySignInResult,
  PasskeyAuthenticationOptions,
  PasskeyRegistrationOptions,
  RedeemInvitationInput,
  RedeemInvitationResult,
  RedeemPasswordResetInput,
  RedeemPasswordResetResult,
  RefreshResult,
  RequestPasswordResetInput,
  RequestPasswordResetResult,
  Session,
  VerifySessionInput,
  VerifySessionResult,
} from "./Models";
import { GateAuthClient } from "./GateAuthClient";
import { forgetSessionOrigin, rememberSessionOrigin, sessionOriginHint } from "./locate";
import { KeychainTokenStore, TokenStore } from "./KeychainTokenStore";

/**
 * Kilimanjaro Gate React Native SDK
 *
 * `GateClient` is the primary entry point. Initialise once per project
 * and call `signIn`, `refreshToken`, or `signOut`. `orgBaseUrl` is the org's gateway host, optional when `orgSlug` is given; a region-free host
 * (`<org>.api.<apex>`) is resolved once to its regional host before credentials are sent.
 *
 * Refresh tokens are automatically persisted via `tokenStore`, and each refresh stores the next one (defaults
 * to `KeychainTokenStore` backed by `react-native-keychain`).
 * Pass a custom `TokenStore` for testing or alternative persistence.
 *
 * Example:
 * ```ts
 * import { GateClient, KeychainTokenStore } from '@k9o/gate-react-native';
 *
 * const gate = new GateClient({
 *   orgBaseUrl: 'https://acme.api.k9o.io',
 *   projectSlug: 'my-project',
 * });
 *
 * const result = await gate.signIn({ email: 'user@example.com', password: 'pass' });
 * ```
 */
export class GateClient {
  private readonly client: GateAuthClient;
  private readonly tokenStore: TokenStore;
  /** The refresh of the stored token in flight, if any. Loading, sending and storing are one step, so a late caller never sends the old token. */
  private storedFlight: Promise<RefreshResult> | null = null;
  /** Refreshes of a token passed in by the caller, by token. */
  private readonly flights = new Map<string, Promise<RefreshResult>>();

  /**
   * Passkeys (WebAuthn). These methods are the wire layer: they carry the options and credentials between your app and
   * the gateway and do not call the platform's passkey API. Hand `begin`'s options to that API and pass the credential
   * it makes to `finish`.
   *
   * Routes: `POST /@<projectSlug>/gate/passkeys/{register,signin}/{begin,finish}`.
   */
  readonly passkeys = {
    register: {
      /** Start adding a passkey to the signed-in end user. Needs the end user's access token as `bearerToken`. */
      begin: (options: BearerOptions): Promise<PasskeyRegistrationOptions> =>
        this.client.post<PasskeyRegistrationOptions>("passkeys/register/begin", undefined, undefined, {
          bearer: options.bearerToken,
        }),

      /**
       * Finish adding a passkey with the credential the authenticator made from `begin`'s options. Needs the end user's
       * access token as `bearerToken`. Throws `GateError` `K9O_INVALID_FIELD_VALUE` (400) when the challenge is invalid,
       * expired or already used, or the credential does not verify.
       */
      finish: (input: FinishPasskeyRegistrationInput, options: BearerOptions): Promise<FinishPasskeyRegistrationResult> =>
        this.client.post<FinishPasskeyRegistrationResult>("passkeys/register/finish", { ...input }, undefined, {
          bearer: options.bearerToken,
        }),
    },

    signIn: {
      /** Start a passkey sign-in. No bearer token is sent. Pass `email` to name the account, or omit it. */
      begin: (input: BeginPasskeySignInInput = {}): Promise<PasskeyAuthenticationOptions> =>
        this.client.post<PasskeyAuthenticationOptions>("passkeys/signin/begin", { ...input }),

      /**
       * Finish a passkey sign-in with the assertion the authenticator made from `begin`'s options. No bearer token is
       * sent. Persists the refresh token on success. Throws `GateError` `K9O_INVALID_FIELD_VALUE` (400) when the challenge is
       * invalid, expired or already used, the passkey is unknown, or the assertion does not verify.
       */
      finish: async (input: FinishPasskeySignInInput): Promise<FinishPasskeySignInResult> => {
        const result = await this.client.post<FinishPasskeySignInResult>("passkeys/signin/finish", { ...input });
        await this.keepSession(result.session);
        return result;
      },
    },
  };

  /**
   * Second factors for the signed-in end user. Routes: `POST /@<projectSlug>/gate/mfa/totp/{enroll,confirm}` and
   * `GET`, `DELETE /@<projectSlug>/gate/mfa/methods[/<methodId>]`. All need the end user's access token as `bearerToken`.
   */
  readonly mfa = {
    methods: {
      /** List the end user's second factors, oldest first. Includes a factor still being set up (`verifiedAt: null`). */
      list: (options: BearerOptions): Promise<ListMfaMethodsResult> =>
        this.client.get<ListMfaMethodsResult>("mfa/methods", { bearer: options.bearerToken }),

      /**
       * Remove one of the end user's second factors by its `id`. Removing a confirmed authenticator app needs its current
       * code as `code`; without it the call throws `GateError` `K9O_MFA_REQUIRED`. A wrong or expired code throws
       * `INVALID_CREDENTIALS` (401), and too many wrong codes `RATE_LIMITED` (429). An id that is not this end user's
       * resolves to `{ deleted: false }`.
       */
      delete: (methodId: string, options: DeleteMfaMethodOptions): Promise<DeleteMfaMethodResult> =>
        this.client.delete<DeleteMfaMethodResult>(
          `mfa/methods/${encodeURIComponent(methodId)}`,
          options.code !== undefined ? { code: options.code } : undefined,
          { bearer: options.bearerToken },
        ),
    },

    totp: {
      /**
       * Start setting up an authenticator app. The answer has `factor.id`, the base32 `secret` and the `otpauth://` `uri`
       * for a QR code; the secret is shown only in this answer. The factor does nothing until `confirm` succeeds.
       */
      enroll: (input: EnrollTotpInput, options: BearerOptions): Promise<EnrollTotpResult> =>
        this.client.post<EnrollTotpResult>("mfa/totp/enroll", { ...input }, undefined, { bearer: options.bearerToken }),

      /**
       * Finish setting up an authenticator app with its first code. To add a second authenticator, also pass
       * `currentCode` from one already confirmed. When this is the person's first confirmed authenticator, their other
       * sessions are ended and the answer carries a new `session`, whose refresh token is persisted.
       * Throws `K9O_MFA_REQUIRED` when a second authenticator is added without `currentCode`, and `INVALID_CREDENTIALS` (401)
       * on a wrong or expired code.
       */
      confirm: async (input: ConfirmTotpInput, options: BearerOptions): Promise<ConfirmTotpResult> => {
        const result = await this.client.post<ConfirmTotpResult>("mfa/totp/confirm", { ...input }, undefined, {
          bearer: options.bearerToken,
        });
        if (result.session !== undefined) await this.keepSession(result.session);
        return result;
      },
    },
  };

  /** Password reset by email. Routes: `POST /@<projectSlug>/gate/password-reset/{request,redeem}`. No bearer token is sent. */
  readonly passwordReset = {
    /**
     * Email a reset link to the address. The answer is the same whether or not the address has an account. The token is
     * valid for one hour and works once. A deployment without a mail relay answers 503 `K9O_EMAIL_NOT_CONFIGURED`.
     * Asks the project which region holds the email first, like `signIn`.
     */
    request: async (input: RequestPasswordResetInput): Promise<RequestPasswordResetResult> => {
      const origin = await this.client.locate(input.email);
      return this.client.post<RequestPasswordResetResult>("password-reset/request", { ...input }, origin);
    },

    /**
     * Set a new password with the token from the email. The answer carries a `session` (its refresh token is
     * persisted) or, when the account has a confirmed authenticator, an `mfa` challenge and no session. Throws
     * `GateError` `K9O_INVALID_FIELD_VALUE` (400) on a wrong, expired or used token, or a password the project refuses.
     */
    redeem: async (input: RedeemPasswordResetInput): Promise<RedeemPasswordResetResult> => {
      const result = await this.client.post<RedeemPasswordResetResult>("password-reset/redeem", { ...input });
      if (result.session !== undefined) await this.keepSession(result.session);
      return result;
    },
  };

  /** Invitations. An operator creates an invitation from the Console or the API; the invited person redeems it here. */
  readonly invitations = {
    /**
     * Accept an invitation. The token from the invitation and a password create the end user. The answer has `user`
     * and a `session`, whose refresh token is persisted. No bearer token is sent. Throws `GateError`
     * `K9O_INVALID_FIELD_VALUE` (400) on a wrong, expired or used token, or a password the project refuses.
     */
    redeem: async (input: RedeemInvitationInput): Promise<RedeemInvitationResult> => {
      const result = await this.client.post<RedeemInvitationResult>("invitations/redeem", { ...input });
      await this.keepSession(result.session);
      return result;
    },
  };

  /**
   * `errors` sets what a `GateError` carries. `"full"` (default) keeps the gateway's `message`, `recommendation`,
   * `context` and `body`, and reports an unknown `K9O_*` code as `code`. `"redacted"` keeps only `code` (`UNKNOWN`
   * for an unknown one), `status`, `requestId`, `publicMessage` and `retryAfterSec`, and sets `message` to `publicMessage`.
   */
  constructor(opts: {
    orgBaseUrl?: string;
    orgSlug?: string;
    projectSlug: string;
    tokenStore?: TokenStore;
    errors?: ErrorsMode;
  }) {
    const errors = opts.errors ?? "full";
    if (errors !== "full" && errors !== "redacted") throw GateError.invalidErrorsMode(opts.errors);
    this.client = new GateAuthClient(opts.orgBaseUrl, opts.projectSlug, opts.orgSlug, errors);
    this.tokenStore = opts.tokenStore ?? new KeychainTokenStore();
  }

  /** Persist a session's refresh token and remember the origin it was issued from. */
  private async keepSession(session: Session | undefined): Promise<void> {
    if (session === undefined || typeof session.refreshToken !== "string" || session.refreshToken.length === 0) return;
    rememberSessionOrigin(session.refreshToken, await this.client.originFor(undefined));
    await this.tokenStore.save(session.refreshToken);
  }

  // MARK: - Public API surface

  /**
   * Check an end user's access token from your backend. The call is authenticated with the bearer you pass as
   * `bearerToken`; the token to check goes in `input.token`. The answer is `{ valid: true, claims }`, or
   * `{ valid: false, reason }` for an invalid or expired token, a token for another project, or an end user who is no
   * longer active. A refused token is an answer with `valid: false`, not an error.
   *
   * Mirrors: `POST /@<projectSlug>/gate/verify-session`
   */
  verifySession(input: VerifySessionInput, options: BearerOptions): Promise<VerifySessionResult> {
    return this.client.post<VerifySessionResult>("verify-session", { ...input }, undefined, { bearer: options.bearerToken });
  }

  /**
   * Sign in an existing end-user with email and password.
   *
   * Persists the refresh token on success.
   * Throws `GateError` with code `INVALID_CREDENTIALS` on bad credentials.
   *
   * Asks the project which region holds the email first (`POST /@<projectSlug>/gate/locate`, email only) and sends the
   * password to that region's host. A 429 or 503 from that step is raised as `RATE_LIMITED` or
   * `GATE_REGION_UNAVAILABLE`, and no password is sent.
   *
   * Mirrors: `POST /@<projectSlug>/gate/signin`
   */
  async signIn(input: { email: string; password: string }): Promise<AuthResult> {
    const origin = await this.client.locate(input.email);
    const result = await this.client.post<AuthResult>(
      "signin",
      { email: input.email, password: input.password },
      origin,
    );
    rememberSessionOrigin(result.session?.refreshToken, origin);
    await this.tokenStore.save(result.session.refreshToken);
    return result;
  }

  /**
   * Get a new access token using the stored (or supplied) refresh token.
   *
   * If `refreshToken` is omitted, loads the token from the store. Each refresh replaces the refresh token: the answer
   * carries the next one, the client stores it before this call returns, and the one you sent stops working. Refreshes
   * run one at a time: a call made while another is in flight for the same token shares that answer, so the same token
   * is never sent twice (the gateway treats a second use as a replay and ends the session).
   *
   * Throws `GateError` with code `UNAUTHENTICATED` and `sessionEndReason` set (`inactive`, `max_length`, `revoked` or
   * `replay`) when the gateway has ended the session; the stored token is cleared and the user must sign in again.
   * `INVALID_CREDENTIALS` (an unknown token or a locked user) clears it the same way.
   *
   * Mirrors: `POST /@<projectSlug>/gate/refresh`
   */
  refreshToken(input?: { refreshToken?: string }): Promise<RefreshResult> {
    const explicit = input?.refreshToken;
    if (explicit === undefined) {
      this.storedFlight ??= this.refreshOnce(undefined).finally(() => {
        this.storedFlight = null;
      });
      return this.storedFlight;
    }
    let flight = this.flights.get(explicit);
    if (flight === undefined) {
      flight = this.refreshOnce(explicit).finally(() => this.flights.delete(explicit));
      this.flights.set(explicit, flight);
    }
    return flight;
  }

  private async refreshOnce(explicit: string | undefined): Promise<RefreshResult> {
    const stored = await this.tokenStore.load();
    const token = explicit ?? stored;
    if (!token) throw GateError.unauthenticated();
    const origin = await this.client.originFor(sessionOriginHint(token));
    let result: RefreshResult;
    try {
      result = await this.client.post<RefreshResult>("refresh", { refreshToken: token }, origin);
    } catch (e) {
      if (e instanceof GateError && e.statusCode === 401 && (e.code === "UNAUTHENTICATED" || e.code === "INVALID_CREDENTIALS")) {
        forgetSessionOrigin(token);
        if (token === stored) await this.tokenStore.delete();
      }
      throw e;
    }
    if (typeof result.refreshToken === "string" && result.refreshToken.length > 0) {
      forgetSessionOrigin(token);
      rememberSessionOrigin(result.refreshToken, origin);
      // Stored before returning, so the next refresh sends the new token.
      if (token === stored || explicit === undefined) await this.tokenStore.save(result.refreshToken);
    }
    return result;
  }

  /**
   * Sign out the current session. Clears the token store.
   *
   * If `refreshToken` is omitted, loads the token from the store.
   * No-op if no token is available.
   *
   * Mirrors: `POST /@<projectSlug>/gate/signout`
   */
  async signOut(input?: { refreshToken?: string }): Promise<void> {
    // A refresh in flight is about to replace the stored token; sign out the new one.
    if (input?.refreshToken === undefined) await this.storedFlight?.catch(() => undefined);
    const token = input?.refreshToken ?? (await this.tokenStore.load());
    if (!token) return;
    const origin = await this.client.originFor(sessionOriginHint(token));
    await this.client.post<{ revoked: boolean }>("signout", { refreshToken: token }, origin);
    forgetSessionOrigin(token);
    await this.tokenStore.delete();
  }

  /**
   * End every live session of this end user, on every device, this one included, and clear the token store.
   *
   * Call it with the end user's `accessToken` (the one `signIn` or `refreshToken` returned), not a refresh token.
   * Resolves to how many sessions ended. Each ended session's next refresh is refused with `sessionEndReason`
   * `revoked`; access tokens already issued keep working until they expire, so drop yours too. An operator's token
   * raises a `GateError` with code `K9O_TRUST_ZONE_VIOLATION` (403), and a token issued for another project one with
   * code `K9O_PROJECT_SCOPE_MISMATCH` (403); the store is left as it was.
   *
   * A refresh in flight finishes first, so it cannot store a token for a session that is about to end.
   *
   * Mirrors: `POST /@<projectSlug>/auth/sessions/revoke-all`
   */
  async revokeAllSessions(input: { accessToken: string }): Promise<number> {
    await this.storedFlight?.catch(() => undefined);
    const stored = await this.tokenStore.load();
    const origin = await this.client.originFor(stored ? sessionOriginHint(stored) : undefined);
    const out = await this.client.post<{ revokedCount?: unknown }>("sessions/revoke-all", undefined, origin, {
      area: "auth",
      bearer: input.accessToken,
    });
    if (typeof out?.revokedCount !== "number") throw GateError.decoding(new Error("revokedCount is not a number"));
    if (stored) forgetSessionOrigin(stored);
    await this.tokenStore.delete();
    return out.revokedCount;
  }
}
