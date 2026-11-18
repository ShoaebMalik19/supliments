export type AuthUser = { id: string; email: string };

export type AuthResult = { ok: true; user: AuthUser | null } | { ok: false; error: string };

export interface AuthProvider {
  currentUser(): Promise<AuthUser | null>;
  signUp(email: string, password: string, emailRedirectTo: string): Promise<AuthResult>;
  signIn(email: string, password: string): Promise<AuthResult>;
  signOut(): Promise<void>;
  sendPasswordReset(email: string, redirectTo: string): Promise<void>;
  updatePassword(password: string): Promise<AuthResult>;
  exchangeCode(code: string): Promise<AuthResult>;
  /** URL that starts a social sign-in; the provider returns to `redirectTo` with a code. */
  oauthUrl(
    provider: OAuthProvider,
    redirectTo: string,
  ): Promise<{ ok: true; url: string } | { ok: false; error: string }>;
}

export const OAUTH_PROVIDERS = ["google"] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

export interface SessionSource {
  auth(): AuthProvider;
  preferredOrgId(): Promise<string | null>;
  requestMeta(): Promise<{ ip: string | null; userAgent: string | null }>;
}

/** Server-side user administration (seed, ops). Creates confirmed accounts that can sign in. */
export interface AuthAdmin {
  ensureUser(email: string, password: string): Promise<{ id: string; created: boolean }>;
  /** Whether the auth service answers with the public key, and whether email signup is on. */
  health(): Promise<{
    reachable: boolean;
    emailSignup: boolean | null;
    detail: string;
    /** Social providers enabled in the auth service (absent when unknown). */
    oauth?: Partial<Record<OAuthProvider, boolean>>;
  }>;
}
