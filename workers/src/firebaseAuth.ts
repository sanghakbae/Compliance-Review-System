/**
 * Firebase ID token verification for Cloudflare Workers.
 *
 * Replaces Supabase's `auth.getUser(accessToken)`. We verify the RS256 JWT
 * signature against Google's public JWKs and validate the standard Firebase
 * claims, all with WebCrypto (firebase-admin is Node-only and unavailable here).
 *
 * Reference: https://firebase.google.com/docs/auth/admin/verify-id-tokens
 */

const JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

export interface VerifiedUser {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  claims: Record<string, unknown>;
}

interface CachedJwks {
  keys: Map<string, CryptoKey>;
  expiresAt: number; // epoch ms
}

let jwksCache: CachedJwks | null = null;

function base64UrlToUint8Array(input: string): Uint8Array {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  const base64 = (input + pad).replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function decodeJwtPart<T>(part: string): T {
  const json = new TextDecoder().decode(base64UrlToUint8Array(part));
  return JSON.parse(json) as T;
}

async function getJwks(): Promise<Map<string, CryptoKey>> {
  const now = Date.now();
  if (jwksCache && jwksCache.expiresAt > now) {
    return jwksCache.keys;
  }

  const res = await fetch(JWKS_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch JWKS: ${res.status}`);
  }

  const body = (await res.json()) as { keys: Array<JsonWebKey & { kid: string }> };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys) {
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    keys.set(jwk.kid, key);
  }

  // Respect Cache-Control max-age; default to 1 hour.
  const cacheControl = res.headers.get("cache-control") ?? "";
  const maxAgeMatch = cacheControl.match(/max-age=(\d+)/);
  const maxAgeMs = maxAgeMatch ? Number(maxAgeMatch[1]) * 1000 : 3600_000;
  jwksCache = { keys, expiresAt: now + maxAgeMs };
  return keys;
}

interface FirebaseIdTokenClaims {
  iss: string;
  aud: string;
  sub: string;
  exp: number;
  iat: number;
  auth_time?: number;
  email?: string;
  email_verified?: boolean;
  [key: string]: unknown;
}

/**
 * Verify a Firebase ID token. Returns the verified user, or throws on any
 * signature/claim failure. `allowedDomain` (optional) enforces the email domain.
 */
export async function verifyIdToken(
  token: string,
  projectId: string,
  allowedDomain?: string,
  allowedEmails?: string[],
): Promise<VerifiedUser> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed token.");
  }
  const [headerB64, payloadB64, signatureB64] = parts;

  const header = decodeJwtPart<{ alg: string; kid: string }>(headerB64);
  if (header.alg !== "RS256") {
    throw new Error(`Unexpected token alg: ${header.alg}`);
  }

  const keys = await getJwks();
  const key = keys.get(header.kid);
  if (!key) {
    throw new Error("Token signing key not found in JWKS.");
  }

  const signature = base64UrlToUint8Array(signatureB64);
  const signedData = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    signature,
    signedData,
  );
  if (!valid) {
    throw new Error("Invalid token signature.");
  }

  const claims = decodeJwtPart<FirebaseIdTokenClaims>(payloadB64);
  const now = Math.floor(Date.now() / 1000);

  if (claims.exp <= now) {
    throw new Error("Token expired.");
  }
  if (claims.iat > now + 300) {
    throw new Error("Token issued in the future.");
  }
  if (claims.aud !== projectId) {
    throw new Error("Token audience mismatch.");
  }
  if (claims.iss !== `https://securetoken.google.com/${projectId}`) {
    throw new Error("Token issuer mismatch.");
  }
  if (!claims.sub) {
    throw new Error("Token missing subject.");
  }

  const email = typeof claims.email === "string" ? claims.email : null;
  const normalizedEmail = email?.toLowerCase() ?? "";
  // Exact-email allowlist takes precedence over domain matching.
  if (allowedEmails && allowedEmails.length > 0) {
    if (!normalizedEmail || !allowedEmails.map((e) => e.toLowerCase()).includes(normalizedEmail)) {
      throw new Error("Email not allowed.");
    }
  } else if (allowedDomain) {
    if (!normalizedEmail || !normalizedEmail.endsWith(`@${allowedDomain.toLowerCase()}`)) {
      throw new Error("Email domain not allowed.");
    }
  }

  return {
    uid: claims.sub,
    email,
    emailVerified: claims.email_verified === true,
    claims,
  };
}

export function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) {
    return null;
  }
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}
