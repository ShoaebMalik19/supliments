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
}

export interface SessionSource {
  auth(): AuthProvider;
  preferredOrgId(): Promise<string | null>;
  requestMeta(): Promise<{ ip: string | null; userAgent: string | null }>;
}

/** Server-side user administration (seed, ops). Creates confirmed accounts that can sign in. */
export interface AuthAdmin {
  ensureUser(email: string, password: string): Promise<{ id: string; created: boolean }>;
}
