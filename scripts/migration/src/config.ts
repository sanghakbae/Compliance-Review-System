/**
 * Shared clients + config for the migration scripts.
 *
 * Required env (see README.md):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   FIREBASE_SERVICE_ACCOUNT       (path to service account JSON, or inline JSON)
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
 * Optional:
 *   DRY_RUN=1                      (read + transform, skip all writes)
 *   SUPABASE_STORAGE_BUCKET        (default: source-documents)
 */

import { readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { cert, initializeApp, type App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { S3Client } from "@aws-sdk/client-s3";

export const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
export const SUPABASE_STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET ?? "source-documents";
export const R2_BUCKET = required("R2_BUCKET");

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export function supabase(): SupabaseClient {
  return createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

let firestoreApp: App | null = null;
export function firestore(): Firestore {
  if (!firestoreApp) {
    const raw = required("FIREBASE_SERVICE_ACCOUNT");
    const json = raw.trim().startsWith("{") ? raw : readFileSync(raw, "utf8");
    firestoreApp = initializeApp({ credential: cert(JSON.parse(json)) });
  }
  return getFirestore(firestoreApp);
}

export function r2(): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: `https://${required("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: required("R2_ACCESS_KEY_ID"),
      secretAccessKey: required("R2_SECRET_ACCESS_KEY"),
    },
  });
}

export function log(...args: unknown[]): void {
  console.log(DRY_RUN ? "[dry-run]" : "[migrate]", ...args);
}
