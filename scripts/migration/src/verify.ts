/**
 * Post-migration sanity check: compare Postgres row counts against Firestore
 * document counts for each top-level / collection-group mapping. Read-only.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Firestore } from "firebase-admin/firestore";
import { firestore, supabase } from "./config.js";

async function pgCount(sb: SupabaseClient, table: string): Promise<number> {
  const { count, error } = await sb.from(table).select("*", { count: "exact", head: true });
  if (error) throw new Error(`count ${table}: ${error.message}`);
  return count ?? 0;
}

async function fsCount(db: Firestore, collectionId: string, group: boolean): Promise<number> {
  const ref = group ? db.collectionGroup(collectionId) : db.collection(collectionId);
  const snap = await ref.count().get();
  return snap.data().count;
}

const CHECKS: Array<{ tables: string[]; collectionId: string; group: boolean }> = [
  { tables: ["policy_workspaces"], collectionId: "workspaces", group: false },
  { tables: ["policy_documents"], collectionId: "documents", group: false },
  // `versions` collection group holds both document and law versions.
  { tables: ["policy_document_versions", "policy_law_versions"], collectionId: "versions", group: true },
  // `sections` collection group holds both document and law sections.
  { tables: ["policy_document_sections", "policy_law_sections"], collectionId: "sections", group: true },
  { tables: ["policy_law_sources"], collectionId: "lawSources", group: false },
  { tables: ["policy_comparison_runs"], collectionId: "comparisonRuns", group: false },
  { tables: ["policy_comparison_results"], collectionId: "results", group: true },
  { tables: ["policy_revision_decisions"], collectionId: "decisions", group: true },
  { tables: ["policy_audit_logs"], collectionId: "auditLogs", group: false },
];

async function main(): Promise<void> {
  const sb = supabase();
  const db = firestore();
  let mismatches = 0;
  for (const check of CHECKS) {
    const [pgCounts, fs] = await Promise.all([
      Promise.all(check.tables.map((t) => pgCount(sb, t))),
      fsCount(db, check.collectionId, check.group),
    ]);
    const pg = pgCounts.reduce((a, b) => a + b, 0);
    const label = check.tables.join(" + ");
    const ok = pg === fs;
    if (!ok) mismatches += 1;
    console.log(
      `${ok ? "OK " : "MISMATCH"}  ${label} (${pg}) → ${check.collectionId}${check.group ? " [group]" : ""} (${fs})`,
    );
  }
  console.log(mismatches === 0 ? "\nAll counts match." : `\n${mismatches} mismatch(es).`);
  process.exit(mismatches === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
