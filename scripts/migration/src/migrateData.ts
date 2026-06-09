/**
 * Supabase Postgres → Firestore.
 *
 * Reads every policy_* table, rebuilds the Firestore collection model defined in
 * src/lib/firestore/schema.ts (FKs → subcollection paths, views → denormalized
 * fields), and writes via the Admin SDK. Idempotent: re-running overwrites docs
 * with the same ids. Set DRY_RUN=1 to read + transform without writing.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Firestore, WriteBatch } from "firebase-admin/firestore";
import { DRY_RUN, firestore, log, supabase } from "./config.js";
import { rowToFields } from "./transform.js";

type Row = Record<string, any>;

async function fetchAll(sb: SupabaseClient, table: string): Promise<Row[]> {
  const pageSize = 1000;
  const rows: Row[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await sb.from(table).select("*").range(from, from + pageSize - 1);
    if (error) throw new Error(`read ${table}: ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < pageSize) break;
  }
  log(`read ${table}: ${rows.length} rows`);
  return rows;
}

/** Batched writer that auto-flushes under the 500-op Firestore limit. */
class Batcher {
  private batch: WriteBatch | null = null;
  private count = 0;
  private written = 0;
  constructor(private db: Firestore) {}

  async set(path: string, data: Record<string, unknown>): Promise<void> {
    this.written += 1;
    if (DRY_RUN) return;
    if (!this.batch) this.batch = this.db.batch();
    this.batch.set(this.db.doc(path), data, { merge: true });
    this.count += 1;
    if (this.count >= 450) await this.flush();
  }

  async flush(): Promise<void> {
    if (this.batch && this.count > 0) {
      await this.batch.commit();
      this.batch = null;
      this.count = 0;
    }
  }

  total(): number {
    return this.written;
  }
}

async function main(): Promise<void> {
  const sb = supabase();
  const db = firestore();
  const w = new Batcher(db);

  // 1) workspaces + members
  const workspaces = await fetchAll(sb, "policy_workspaces");
  const members = await fetchAll(sb, "policy_workspace_members");
  const memberIdsByWs = new Map<string, string[]>();
  for (const m of members) {
    const list = memberIdsByWs.get(m.workspace_id) ?? [];
    list.push(m.user_id);
    memberIdsByWs.set(m.workspace_id, list);
  }
  for (const ws of workspaces) {
    await w.set(`workspaces/${ws.id}`, {
      ...rowToFields(ws, { omit: ["id"] }),
      memberIds: memberIdsByWs.get(ws.id) ?? [],
    });
  }
  for (const m of members) {
    await w.set(`workspaces/${m.workspace_id}/members/${m.user_id}`, rowToFields(m, {
      omit: ["workspace_id", "user_id"],
    }));
  }

  // 2) documents + versions + sections
  const documents = await fetchAll(sb, "policy_documents");
  const docOwnerById = new Map<string, string>();
  for (const d of documents) docOwnerById.set(d.id, d.owner_user_id);

  const docVersions = await fetchAll(sb, "policy_document_versions");
  const docIdByVersion = new Map<string, string>();
  const latestByDoc = new Map<string, Row>();
  for (const v of docVersions) {
    docIdByVersion.set(v.id, v.document_id);
    const cur = latestByDoc.get(v.document_id);
    if (!cur || v.version_number > cur.version_number) latestByDoc.set(v.document_id, v);
  }

  const docSections = await fetchAll(sb, "policy_document_sections");
  const sectionCountByVersion = new Map<string, number>();
  for (const s of docSections) {
    sectionCountByVersion.set(
      s.document_version_id,
      (sectionCountByVersion.get(s.document_version_id) ?? 0) + 1,
    );
  }

  for (const d of documents) {
    const latest = latestByDoc.get(d.id);
    await w.set(`documents/${d.id}`, {
      ...rowToFields(d, { omit: ["id"] }),
      latest: latest
        ? {
            versionId: latest.id,
            versionNumber: latest.version_number,
            sectionCount: sectionCountByVersion.get(latest.id) ?? 0,
            effectiveDate: latest.effective_date ?? null,
            createdAt: latest.created_at ?? null,
          }
        : null,
    });
  }
  for (const v of docVersions) {
    await w.set(`documents/${v.document_id}/versions/${v.id}`, {
      ...rowToFields(v, { omit: ["id", "document_id"] }),
      id: v.id,
      documentId: v.document_id,
      ownerUserId: docOwnerById.get(v.document_id) ?? null,
    });
  }
  for (const s of docSections) {
    const docId = docIdByVersion.get(s.document_version_id);
    if (!docId) {
      log(`WARN orphan document_section ${s.id} (version ${s.document_version_id})`);
      continue;
    }
    await w.set(`documents/${docId}/versions/${s.document_version_id}/sections/${s.id}`, {
      ...rowToFields(s, { omit: ["id"] }),
      ownerUserId: docOwnerById.get(docId) ?? null,
    });
  }

  // 3) law sources + versions + sections
  const lawSources = await fetchAll(sb, "policy_law_sources");
  const lawOwnerById = new Map<string, string>();
  for (const l of lawSources) lawOwnerById.set(l.id, l.owner_user_id);

  const lawVersions = await fetchAll(sb, "policy_law_versions");
  const lawIdByVersion = new Map<string, string>();
  for (const v of lawVersions) lawIdByVersion.set(v.id, v.law_source_id);

  const lawSections = await fetchAll(sb, "policy_law_sections");

  for (const l of lawSources) {
    await w.set(`lawSources/${l.id}`, rowToFields(l, { omit: ["id"] }));
  }
  for (const v of lawVersions) {
    await w.set(`lawSources/${v.law_source_id}/versions/${v.id}`, {
      ...rowToFields(v, { omit: ["id", "law_source_id"] }),
      id: v.id,
      lawSourceId: v.law_source_id,
      ownerUserId: lawOwnerById.get(v.law_source_id) ?? null,
    });
  }
  for (const s of lawSections) {
    const lawId = lawIdByVersion.get(s.law_version_id);
    if (!lawId) {
      log(`WARN orphan law_section ${s.id} (version ${s.law_version_id})`);
      continue;
    }
    await w.set(`lawSources/${lawId}/versions/${s.law_version_id}/sections/${s.id}`, {
      ...rowToFields(s, { omit: ["id"] }),
      ownerUserId: lawOwnerById.get(lawId) ?? null,
    });
  }

  // 4) comparison runs + results + decisions
  const runs = await fetchAll(sb, "policy_comparison_runs");
  for (const r of runs) {
    await w.set(`comparisonRuns/${r.id}`, rowToFields(r, { omit: ["id"] }));
  }
  for (const r of await fetchAll(sb, "policy_comparison_results")) {
    await w.set(`comparisonRuns/${r.comparison_run_id}/results/${r.id}`, rowToFields(r, {
      omit: ["id"],
    }));
  }
  for (const d of await fetchAll(sb, "policy_revision_decisions")) {
    await w.set(`comparisonRuns/${d.comparison_run_id}/decisions/${d.id}`, rowToFields(d, {
      omit: ["id"],
    }));
  }

  // 5) audit logs
  for (const a of await fetchAll(sb, "policy_audit_logs")) {
    await w.set(`auditLogs/${a.id}`, rowToFields(a, { omit: ["id"] }));
  }

  // 6) per-user data
  for (const s of await fetchAll(sb, "policy_user_settings")) {
    await w.set(`users/${s.owner_user_id}/settings/openai`, rowToFields(s, {
      omit: ["owner_user_id"],
    }));
  }
  for (const s of await fetchAll(sb, "policy_security_settings")) {
    await w.set(`users/${s.owner_user_id}/settings/security`, rowToFields(s, {
      omit: ["owner_user_id"],
    }));
  }
  for (const f of await fetchAll(sb, "policy_workspace_favorites")) {
    await w.set(`users/${f.owner_user_id}/favorites/${f.id}`, rowToFields(f, {
      omit: ["id", "owner_user_id"],
    }));
  }
  for (const h of await fetchAll(sb, "policy_review_execution_history")) {
    await w.set(`users/${h.owner_user_id}/reviewHistory/${h.id}`, rowToFields(h, {
      omit: ["id", "owner_user_id"],
    }));
  }
  for (const r of await fetchAll(sb, "policy_ai_report_history")) {
    await w.set(`users/${r.owner_user_id}/aiReportHistory/${r.id}`, rowToFields(r, {
      omit: ["id", "owner_user_id"],
    }));
  }

  await w.flush();
  log(`done. ${w.total()} documents ${DRY_RUN ? "would be written" : "written"}.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
