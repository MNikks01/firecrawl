export interface Principal {
  teamId: string;
  teamName: string;
  keyId: string;
  /** Scales every rate-limit bucket for this team (Firecrawl's own model). */
  rateMultiplier: number;
}

/**
 * The pluggable part. A provider turns a bearer token into a principal, or null.
 * It must not throw for a bad token; it may throw for an infrastructure failure
 * (the gateway answers 503, not 401, so callers don't drop a valid key).
 */
export interface AuthProvider {
  readonly name: string;
  authenticate(token: string): Promise<Principal | null>;
  /** Drop any cached state for a key (revocation). */
  invalidate?(keyId: string): void;
  close?(): Promise<void>;
}
