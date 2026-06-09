/**
 * Client-side Firestore access (firebase/firestore web SDK).
 *
 * Replaces direct Supabase Postgres reads. Reads are governed by
 * firestore.rules; writes that need privileged/server logic go through the
 * Cloudflare Worker API (see workerApi.ts), not here.
 */

import { getFirestore, type Firestore } from "firebase/firestore";
import { getFirebaseApp } from "./firebaseClient";

let db: Firestore | null = null;

export function getDb(): Firestore {
  if (!db) {
    db = getFirestore(getFirebaseApp());
  }
  return db;
}
