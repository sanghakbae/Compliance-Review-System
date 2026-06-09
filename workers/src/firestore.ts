/**
 * Minimal Firestore Admin client for Cloudflare Workers (REST v1).
 *
 * Replaces the Supabase service-role client used inside the Edge Functions.
 * Authenticates with a Google service account (JWT bearer → OAuth2 access
 * token) and speaks the Firestore REST API. WebCrypto only — no firebase-admin.
 *
 * Provide the service account JSON via the FIREBASE_SERVICE_ACCOUNT secret:
 *   wrangler secret put FIREBASE_SERVICE_ACCOUNT   (paste the full JSON)
 */

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id: string;
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/datastore";

let cachedToken: { token: string; expiresAt: number } | null = null;

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function base64Url(input: ArrayBuffer | string): string {
  let binary = "";
  if (typeof input === "string") {
    binary = input;
  } else {
    const bytes = new Uint8Array(input);
    for (let i = 0; i < bytes.length; i += 1) {
      binary += String.fromCharCode(bytes[i]);
    }
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function getAccessToken(sa: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt > now + 60) {
    return cachedToken.token;
  }

  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(
    JSON.stringify({
      iss: sa.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }),
  );
  const signingInput = `${header}.${claims}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );
  const jwt = `${signingInput}.${base64Url(signature)}`;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    throw new Error(`OAuth token exchange failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: data.access_token, expiresAt: now + data.expires_in };
  return data.access_token;
}

// ---- Firestore typed-value codec ----
type FsValue = Record<string, unknown>;

export function encodeValue(value: unknown): FsValue {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { integerValue: String(value) }
      : { doubleValue: value };
  }
  if (typeof value === "string") return { stringValue: value };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(encodeValue) } };
  }
  if (typeof value === "object") {
    return { mapValue: { fields: encodeFields(value as Record<string, unknown>) } };
  }
  throw new Error(`Cannot encode value: ${String(value)}`);
}

export function encodeFields(obj: Record<string, unknown>): Record<string, FsValue> {
  const fields: Record<string, FsValue> = {};
  for (const [k, v] of Object.entries(obj)) {
    fields[k] = encodeValue(v);
  }
  return fields;
}

export function decodeValue(value: FsValue): unknown {
  if ("nullValue" in value) return null;
  if ("booleanValue" in value) return value.booleanValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("stringValue" in value) return value.stringValue;
  if ("timestampValue" in value) return value.timestampValue;
  if ("arrayValue" in value) {
    const v = value.arrayValue as { values?: FsValue[] };
    return (v.values ?? []).map(decodeValue);
  }
  if ("mapValue" in value) {
    const v = value.mapValue as { fields?: Record<string, FsValue> };
    return decodeFields(v.fields ?? {});
  }
  return null;
}

export function decodeFields(fields: Record<string, FsValue>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = decodeValue(v);
  }
  return out;
}

export interface FirestoreDoc {
  /** Document ID (last path segment). */
  id: string;
  /** Full resource name. */
  name: string;
  fields: Record<string, unknown>;
}

export class Firestore {
  private base: string;
  constructor(private sa: ServiceAccount, projectId = sa.project_id) {
    this.base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
  }

  static fromEnv(serviceAccountJson: string, projectId?: string): Firestore {
    const sa = JSON.parse(serviceAccountJson) as ServiceAccount;
    return new Firestore(sa, projectId ?? sa.project_id);
  }

  private async authHeaders(): Promise<Record<string, string>> {
    const token = await getAccessToken(this.sa);
    return { authorization: `Bearer ${token}`, "content-type": "application/json" };
  }

  private docName(path: string): string {
    return `${this.base}/${path}`;
  }

  /** Get a single document by path (e.g. "documents/abc"). Returns null if missing. */
  async get(path: string): Promise<FirestoreDoc | null> {
    const res = await fetch(this.docName(path), { headers: await this.authHeaders() });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Firestore get failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { name: string; fields?: Record<string, FsValue> };
    return {
      id: data.name.split("/").pop() ?? "",
      name: data.name,
      fields: decodeFields(data.fields ?? {}),
    };
  }

  /**
   * runQuery against a collection under an optional parent path.
   * Supports equality filters and a single orderBy + limit (enough for the
   * ported functions). Returns decoded documents.
   */
  async query(opts: {
    parent?: string; // e.g. "documents/abc/versions" parent is "documents/abc"
    collectionId: string;
    where?: Array<{ field: string; op: string; value: unknown }>;
    orderBy?: { field: string; direction: "ASCENDING" | "DESCENDING" };
    limit?: number;
  }): Promise<FirestoreDoc[]> {
    const parentName = opts.parent ? `${this.base}/${opts.parent}` : this.base;
    const filters = (opts.where ?? []).map((w) => ({
      fieldFilter: {
        field: { fieldPath: w.field },
        op: w.op,
        value: encodeValue(w.value),
      },
    }));
    const structuredQuery: Record<string, unknown> = {
      from: [{ collectionId: opts.collectionId }],
    };
    if (filters.length === 1) {
      structuredQuery.where = filters[0];
    } else if (filters.length > 1) {
      structuredQuery.where = { compositeFilter: { op: "AND", filters } };
    }
    if (opts.orderBy) {
      structuredQuery.orderBy = [
        { field: { fieldPath: opts.orderBy.field }, direction: opts.orderBy.direction },
      ];
    }
    if (opts.limit) structuredQuery.limit = opts.limit;

    const res = await fetch(`${parentName}:runQuery`, {
      method: "POST",
      headers: await this.authHeaders(),
      body: JSON.stringify({ structuredQuery }),
    });
    if (!res.ok) throw new Error(`Firestore query failed: ${res.status} ${await res.text()}`);
    const rows = (await res.json()) as Array<{
      document?: { name: string; fields?: Record<string, FsValue> };
    }>;
    return rows
      .filter((r) => r.document)
      .map((r) => ({
        id: r.document!.name.split("/").pop() ?? "",
        name: r.document!.name,
        fields: decodeFields(r.document!.fields ?? {}),
      }));
  }

  /**
   * Collection-group query (all subcollections sharing collectionId, anywhere
   * in the tree). Mirrors Postgres queries that filtered a flat table by a
   * version FK. Requires a COLLECTION_GROUP composite index for the filters.
   */
  async queryGroup(opts: {
    collectionId: string;
    where?: Array<{ field: string; op: string; value: unknown }>;
    orderBy?: { field: string; direction: "ASCENDING" | "DESCENDING" };
    limit?: number;
  }): Promise<FirestoreDoc[]> {
    const filters = (opts.where ?? []).map((w) => ({
      fieldFilter: {
        field: { fieldPath: w.field },
        op: w.op,
        value: encodeValue(w.value),
      },
    }));
    const structuredQuery: Record<string, unknown> = {
      from: [{ collectionId: opts.collectionId, allDescendants: true }],
    };
    if (filters.length === 1) {
      structuredQuery.where = filters[0];
    } else if (filters.length > 1) {
      structuredQuery.where = { compositeFilter: { op: "AND", filters } };
    }
    if (opts.orderBy) {
      structuredQuery.orderBy = [
        { field: { fieldPath: opts.orderBy.field }, direction: opts.orderBy.direction },
      ];
    }
    if (opts.limit) structuredQuery.limit = opts.limit;

    const res = await fetch(`${this.base}:runQuery`, {
      method: "POST",
      headers: await this.authHeaders(),
      body: JSON.stringify({ structuredQuery }),
    });
    if (!res.ok) {
      throw new Error(`Firestore group query failed: ${res.status} ${await res.text()}`);
    }
    const rows = (await res.json()) as Array<{
      document?: { name: string; fields?: Record<string, FsValue> };
    }>;
    return rows
      .filter((r) => r.document)
      .map((r) => ({
        id: r.document!.name.split("/").pop() ?? "",
        name: r.document!.name,
        fields: decodeFields(r.document!.fields ?? {}),
      }));
  }

  /** Create or overwrite a document at path. */
  async set(path: string, data: Record<string, unknown>): Promise<void> {
    const res = await fetch(this.docName(path), {
      method: "PATCH",
      headers: await this.authHeaders(),
      body: JSON.stringify({ fields: encodeFields(data) }),
    });
    if (!res.ok) throw new Error(`Firestore set failed: ${res.status} ${await res.text()}`);
  }

  /** Patch specific fields (updateMask). */
  async update(path: string, data: Record<string, unknown>): Promise<void> {
    const mask = Object.keys(data)
      .map((f) => `updateMask.fieldPaths=${encodeURIComponent(f)}`)
      .join("&");
    const res = await fetch(`${this.docName(path)}?${mask}`, {
      method: "PATCH",
      headers: await this.authHeaders(),
      body: JSON.stringify({ fields: encodeFields(data) }),
    });
    if (!res.ok) throw new Error(`Firestore update failed: ${res.status} ${await res.text()}`);
  }

  async delete(path: string): Promise<void> {
    const res = await fetch(this.docName(path), {
      method: "DELETE",
      headers: await this.authHeaders(),
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`Firestore delete failed: ${res.status} ${await res.text()}`);
    }
  }

  /**
   * Atomic batch write via :commit. Operations: set/update/delete.
   * Firestore commit caps at 500 writes; callers chunk large batches.
   */
  async commit(
    writes: Array<
      | { type: "set"; path: string; data: Record<string, unknown> }
      | { type: "delete"; path: string }
    >,
  ): Promise<void> {
    const body = {
      writes: writes.map((w) =>
        w.type === "delete"
          ? { delete: this.docName(w.path) }
          : { update: { name: this.docName(w.path), fields: encodeFields(w.data) } },
      ),
    };
    const res = await fetch(`${this.base}:commit`, {
      method: "POST",
      headers: await this.authHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Firestore commit failed: ${res.status} ${await res.text()}`);
  }

  /** Delete every document in a (sub)collection. Used for reparse cleanup. */
  async deleteCollection(parent: string | undefined, collectionId: string): Promise<number> {
    const docs = await this.query({ parent, collectionId });
    if (docs.length === 0) return 0;
    const prefix = parent ? `${parent}/${collectionId}` : collectionId;
    // Chunk to stay under the 500-write commit cap.
    for (let i = 0; i < docs.length; i += 400) {
      const chunk = docs.slice(i, i + 400);
      await this.commit(chunk.map((d) => ({ type: "delete", path: `${prefix}/${d.id}` })));
    }
    return docs.length;
  }
}
