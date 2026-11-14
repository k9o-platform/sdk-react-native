/**
 * Core model types for @k9o/gate-react-native.
 * Mirror the @k9o/gate TypeScript types.
 */

/** Project-level end-user identity. IDs carry the `eu_` prefix. */
export interface EndUser {
  id: string;
  email: string;
  status: "active" | "pending" | "disabled";
  createdAt: string;
  updatedAt: string | null;
  lastSigninAt: string | null;
  roles: readonly string[];
  groups: readonly string[];
}

/** Session tokens returned by sign-in. */
export interface Session {
  accessToken: string;
  refreshToken: string;
  /** ISO 8601 instant the access token expires. */
  expiresAt: string;
}

/** Returned by signIn. */
export interface AuthResult {
  user: EndUser;
  session: Session;
}

/** Returned by refreshToken: a new access token and the next refresh token. The refresh token you sent no longer works. */
export interface RefreshResult {
  accessToken: string;
  /** The next refresh token. The client has already stored it; keep it if you keep your own copy. */
  refreshToken: string;
  /** ISO 8601 instant the new access token expires. */
  expiresAt: string;
}

/** The gateway's response envelope. */
interface Envelope<T> {
  data: T;
  meta?: Record<string, unknown>;
}

export function parseEnvelope<T>(body: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    throw new Error(`JSON.parse failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const env = parsed as Envelope<T>;
  if (!env || typeof env !== "object" || !("data" in env)) {
    throw new Error("Response missing 'data' envelope key");
  }
  return env.data;
}

// MARK: - Lightweight JWT access-token decoder

/**
 * Lightweight access-token decoder. Decodes the JWT payload without signature verification.
 */
export class AccessToken {
  readonly subject: string | undefined;
  readonly expiresAt: number | undefined;
  readonly issuedAt: number | undefined;
  readonly issuer: string | undefined;
  readonly allClaims: Record<string, unknown>;

  private constructor(claims: Record<string, unknown>) {
    this.allClaims = claims;
    this.subject = typeof claims["sub"] === "string" ? claims["sub"] : undefined;
    this.expiresAt = typeof claims["exp"] === "number" ? claims["exp"] : undefined;
    this.issuedAt = typeof claims["iat"] === "number" ? claims["iat"] : undefined;
    this.issuer = typeof claims["iss"] === "string" ? claims["iss"] : undefined;
  }

  /**
   * Custom claims, grouped by namespace. The token carries each one as a FLAT key `ext.<namespace>.<name>`, so
   * `ext.partners.partner_role = "extension_org_admin"` reads as
   * `customClaims["partners"]?.["partner_role"]` and gives `"extension_org_admin"`.
   */
  get customClaims(): Record<string, Record<string, unknown>> {
    const result: Record<string, Record<string, unknown>> = {};
    for (const [key, val] of Object.entries(this.allClaims)) {
      if (!key.startsWith("ext.")) continue;
      const rest = key.slice("ext.".length);
      const dot = rest.indexOf(".");
      if (dot <= 0 || dot === rest.length - 1) continue;
      const ns = rest.slice(0, dot);
      (result[ns] ??= {})[rest.slice(dot + 1)] = val;
    }
    return result;
  }

  /** Decode a raw JWT string. Returns null if not a valid 3-part JWT. */
  static decode(jwt: string): AccessToken | null {
    const parts = jwt.split(".");
    if (parts.length !== 3) return null;
    try {
      const payload = parts[1]!
        .replace(/-/g, "+")
        .replace(/_/g, "/");
      // Use Buffer in Node.js test env; atob in RN runtime env.
      const decoded =
        typeof Buffer !== "undefined"
          ? Buffer.from(payload, "base64").toString("utf8")
          : atob(payload);
      const json = JSON.parse(decoded) as Record<string, unknown>;
      return new AccessToken(json);
    } catch {
      return null;
    }
  }
}

// MARK: - End-user flows (passkeys, authenticator app, password reset, invitations, session check)

/** The bearer token a call needs. React Native has no partner token, so the calls that need one take it per call. */
export interface BearerOptions {
  /** The bearer token to send: an end user's access token, or the token your backend authenticates with. */
  bearerToken: string;
}

/** A sign-in that needs a second step: a confirmed authenticator code, redeemed with the challenge id. */
export interface MfaChallenge {
  required: true;
  challengeId: string;
  expiresAt: string;
  methodsAvailable: ["totp"];
  resident: { region: string; origin: string };
}

/**
 * WebAuthn registration options as the gateway returns them (the JSON form of `PublicKeyCredentialCreationOptions`,
 * with `challenge` and the ids base64url-encoded). Pass it to the platform's passkey API.
 */
export type PasskeyRegistrationOptions = { challenge: string } & Record<string, unknown>;

/** WebAuthn authentication options as the gateway returns them (the JSON form of `PublicKeyCredentialRequestOptions`). */
export type PasskeyAuthenticationOptions = { challenge: string } & Record<string, unknown>;

/** The JSON form of the credential the authenticator made at registration (`RegistrationResponseJSON`). */
export type PasskeyRegistrationResponse = { id: string; response: Record<string, unknown> } & Record<string, unknown>;

/** The JSON form of the assertion the authenticator made at sign-in (`AuthenticationResponseJSON`). */
export type PasskeyAuthenticationResponse = { id: string; response: Record<string, unknown> } & Record<string, unknown>;

/** `gate.passkeys.register.finish` input. */
export interface FinishPasskeyRegistrationInput {
  /** What the authenticator made, in its JSON form. */
  response: PasskeyRegistrationResponse;
  /** A name for the passkey, 1 to 256 characters. */
  label?: string;
}

/** `gate.passkeys.register.finish` answer. */
export interface FinishPasskeyRegistrationResult {
  passkey: { id: string; credentialId: string };
}

/** `gate.passkeys.signIn.begin` input. */
export interface BeginPasskeySignInInput {
  /** The account's email, 3 to 254 characters. Omit it to let the authenticator offer its own passkeys. */
  email?: string;
}

/** `gate.passkeys.signIn.finish` input. */
export interface FinishPasskeySignInInput {
  /** What the authenticator made, in its JSON form. */
  response: PasskeyAuthenticationResponse;
}

/** `gate.passkeys.signIn.finish` answer. */
export interface FinishPasskeySignInResult {
  session: Session;
}

/** `gate.mfa.totp.enroll` input. */
export interface EnrollTotpInput {
  /** A name for the authenticator, 1 to 256 characters. Defaults to `TOTP`. */
  label?: string;
}

/** `gate.mfa.totp.enroll` answer. The secret and the `otpauth://` uri are shown once; the factor is not usable until confirmed. */
export interface EnrollTotpResult {
  factor: { id: string; secret: string; uri: string };
}

/** `gate.mfa.totp.confirm` input. */
export interface ConfirmTotpInput {
  /** The `factor.id` that `enroll` returned. */
  factorId: string;
  /** The current code from the authenticator app, 4 to 10 characters. */
  code: string;
  /** A current code from an authenticator the person has already confirmed. Required to add a second one. */
  currentCode?: string;
}

/**
 * `gate.mfa.totp.confirm` answer. When this is the person's first confirmed authenticator, their other sessions are
 * ended and the answer carries a new `session` for this one.
 */
export interface ConfirmTotpResult {
  factor: { id: string; verifiedAt: string };
  session?: Session;
}

/** One second factor of the signed-in end user, as `gate.mfa.methods.list` returns it. */
export interface MfaMethod {
  id: string;
  /** `totp` or `webauthn`. */
  type: string;
  label: string | null;
  /** When the factor was confirmed, or `null` while it is still being set up. */
  verifiedAt: string | null;
  createdAt: string;
}

/** `gate.mfa.methods.list` answer. */
export interface ListMfaMethodsResult {
  methods: MfaMethod[];
}

/** `gate.mfa.methods.delete` options: the bearer token, and the current code when removing a confirmed authenticator app. */
export interface DeleteMfaMethodOptions extends BearerOptions {
  /** A current code from the authenticator being removed, 4 to 10 characters. Required for a confirmed authenticator app. */
  code?: string;
}

/** `gate.mfa.methods.delete` answer. `deleted` is `false` when the id matched no method of this end user. */
export interface DeleteMfaMethodResult {
  deleted: boolean;
}

/** `gate.passwordReset.request` input. */
export interface RequestPasswordResetInput {
  email: string;
}

/** `gate.passwordReset.request` answer. The answer is the same whether or not the email has an account. */
export interface RequestPasswordResetResult {
  reset: { requested: true; expiresAt?: string };
  /** Only present on a deployment configured to return the token in the response (development). */
  debugToken?: string;
}

/** `gate.passwordReset.redeem` input. */
export interface RedeemPasswordResetInput {
  /** The token from the reset email. */
  token: string;
  newPassword: string;
}

/** `gate.passwordReset.redeem` answer: a `session`, or an `mfa` challenge when the account has a confirmed authenticator. */
export type RedeemPasswordResetResult = { redeemed: true; endUserId: string } & (
  | { session: Session; mfa?: undefined }
  | { mfa: MfaChallenge; session?: undefined }
);

/** `gate.invitations.redeem` input. */
export interface RedeemInvitationInput {
  /** The token from the invitation. */
  token: string;
  password: string;
  /** Optional display name, 1 to 256 characters. */
  displayName?: string;
}

/** `gate.invitations.redeem` answer. */
export interface RedeemInvitationResult {
  redeemed: true;
  user: { id: string; email: string };
  session: Session;
}

/** `gate.verifySession` input. */
export interface VerifySessionInput {
  /** The end user's access token to check. */
  token: string;
}

/** `gate.verifySession` answer: the token's claims, or the reason it was refused. */
export type VerifySessionResult =
  | { valid: true; claims: { subjectId: string; projectId: string; expiresAt: string } }
  | { valid: false; reason: string };
