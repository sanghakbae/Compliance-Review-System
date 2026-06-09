/**
 * Firebase Auth user import — preserves Supabase user UUIDs as Firebase uids.
 *
 * Resolves the critical "Firebase uid ≠ Supabase user.id" gap (see
 * docs/MIGRATION.md). Reads Supabase auth users (admin API) and imports them
 * into Firebase Auth with uid = Supabase id and the linked Google provider, so
 * that when a user signs in with Google, Firebase resolves to the SAME uid that
 * `ownerUserId` references throughout the migrated data.
 *
 * Run BEFORE the client cutover (Phase 5), after/with migrateData. Idempotent.
 */

import { getAuth, type UserImportRecord } from "firebase-admin/auth";
import { firestore, log, supabase, DRY_RUN } from "./config.js";

async function listSupabaseUsers() {
  const sb = supabase();
  const users: Array<{ id: string; email?: string; identities?: any[] }> = [];
  for (let page = 1; ; page += 1) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`listUsers: ${error.message}`);
    if (!data.users.length) break;
    for (const u of data.users) {
      users.push({ id: u.id, email: u.email ?? undefined, identities: u.identities ?? [] });
    }
    if (data.users.length < 1000) break;
  }
  return users;
}

async function main(): Promise<void> {
  // Ensure the Firebase app is initialized (config also used by Firestore).
  firestore();
  const auth = getAuth();
  const users = await listSupabaseUsers();
  log(`found ${users.length} Supabase auth users`);

  const records: UserImportRecord[] = users.map((u) => {
    const google = (u.identities ?? []).find((i) => i.provider === "google");
    const providerData = google?.id
      ? [{ uid: String(google.id), providerId: "google.com", email: u.email }]
      : [];
    return {
      uid: u.id, // preserve Supabase UUID as the Firebase uid
      email: u.email,
      emailVerified: true,
      providerData,
    };
  });

  if (DRY_RUN) {
    log(`would import ${records.length} users (uid preserved). sample:`, records.slice(0, 3));
    return;
  }

  // importUsers caps at 1000 records per call.
  let success = 0;
  let failure = 0;
  for (let i = 0; i < records.length; i += 1000) {
    const chunk = records.slice(i, i + 1000);
    const result = await auth.importUsers(chunk);
    success += result.successCount;
    failure += result.failureCount;
    for (const err of result.errors) {
      log(`WARN import error idx ${err.index}: ${err.error.message}`);
    }
  }
  log(`done. imported=${success} failed=${failure}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
