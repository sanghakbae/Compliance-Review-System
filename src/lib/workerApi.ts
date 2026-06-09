/**
 * Client for the Cloudflare Workers backend (replaces Supabase Edge Function
 * invocations and Supabase Storage access).
 *
 * Base URL from VITE_WORKER_API_URL (e.g. https://policy-revision-mgmt-system.<acct>.workers.dev).
 * Every request carries the Firebase ID token as a Bearer credential, which the
 * Worker verifies (workers/src/firebaseAuth.ts).
 */

import { getFreshIdToken } from "./firebaseAuth";

function baseUrl(): string {
  const url = import.meta.env.VITE_WORKER_API_URL;
  if (!url) {
    throw new Error("Missing VITE_WORKER_API_URL. Configure the Worker endpoint.");
  }
  return url.replace(/\/+$/, "");
}

async function authHeader(): Promise<Record<string, string>> {
  const token = await getFreshIdToken();
  if (!token) {
    throw new Error("Not authenticated.");
  }
  return { Authorization: `Bearer ${token}` };
}

/** Invoke a migrated backend function: POST /functions/<name>. */
export async function invokeFunction<T = unknown>(
  name: string,
  body: unknown,
): Promise<T> {
  const res = await fetch(`${baseUrl()}/functions/${name}`, {
    method: "POST",
    headers: { ...(await authHeader()), "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(
      typeof payload.error === "string" ? payload.error : `Function '${name}' failed (${res.status}).`,
    );
  }
  return payload as T;
}

/** Upload a file to R2 via the Worker: PUT /files/<key>. */
export async function uploadFile(
  key: string,
  bytes: ArrayBuffer | Uint8Array,
  contentType: string,
): Promise<void> {
  const res = await fetch(`${baseUrl()}/files/${encodeURI(key)}`, {
    method: "PUT",
    headers: { ...(await authHeader()), "content-type": contentType },
    body: bytes,
  });
  if (!res.ok) {
    throw new Error(`File upload failed (${res.status}).`);
  }
}

/** Download a file from R2 via the Worker: GET /files/<key>. */
export async function downloadFile(key: string): Promise<Blob> {
  const res = await fetch(`${baseUrl()}/files/${encodeURI(key)}`, {
    headers: await authHeader(),
  });
  if (!res.ok) {
    throw new Error(`File download failed (${res.status}).`);
  }
  return res.blob();
}

/** Delete a file from R2 via the Worker: DELETE /files/<key>. */
export async function deleteFile(key: string): Promise<void> {
  const res = await fetch(`${baseUrl()}/files/${encodeURI(key)}`, {
    method: "DELETE",
    headers: await authHeader(),
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`File delete failed (${res.status}).`);
  }
}
