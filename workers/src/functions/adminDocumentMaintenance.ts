/**
 * Ported from supabase/functions/admin-document-maintenance/index.ts.
 *
 * NOTE: the original ran with the service role and NO user auth. Under the
 * Worker, every /functions route is authenticated; this endpoint additionally
 * scopes work to `ownerUserId` (defaulting to the caller) so it can't touch
 * other users' data without explicit intent.
 */

import { parsePolicyText } from "../../../shared/policyParser";
import { Firestore } from "../firestore";
import type { VerifiedUser } from "../firebaseAuth";
import { buildSectionDocs } from "./_common";

export type AdminMaintenanceRequest =
  | { action: "reparse_by_text"; ownerUserId?: string; rawTextNeedle: string }
  | { action: "delete_by_document_id"; documentId: string };

export async function adminDocumentMaintenance(
  body: AdminMaintenanceRequest,
  user: VerifiedUser,
  db: Firestore,
  bucket: R2Bucket,
): Promise<Record<string, unknown>> {
  if (body.action === "reparse_by_text") {
    if (!body.rawTextNeedle?.trim()) {
      throw new Error("rawTextNeedle is required.");
    }
    const ownerUserId = body.ownerUserId || user.uid;
    const documents = await db.query({
      collectionId: "documents",
      where: [{ field: "ownerUserId", op: "EQUAL", value: ownerUserId }],
    });

    const results: Array<Record<string, unknown>> = [];
    for (const doc of documents) {
      const latest = doc.fields.latest as { versionId?: string } | undefined;
      if (!latest?.versionId) continue;
      const versionPath = `documents/${doc.id}/versions/${latest.versionId}`;
      const version = await db.get(versionPath);
      const rawText = (version?.fields.rawText as string) ?? "";
      if (!rawText.includes(body.rawTextNeedle)) continue;

      const parseResult = parsePolicyText(rawText);
      const sectionDocs = await buildSectionDocs(
        parseResult.sections,
        latest.versionId,
        "documentVersionId",
        ownerUserId,
      );
      await db.deleteCollection(versionPath, "sections");
      const writes = sectionDocs.map((s) => ({
        type: "set" as const,
        path: `${versionPath}/sections/${s.id}`,
        data: s.data,
      }));
      for (let i = 0; i < writes.length; i += 400) {
        await db.commit(writes.slice(i, i + 400));
      }
      await db.update(versionPath, { parseWarnings: parseResult.warnings });

      results.push({
        documentId: doc.id,
        title: doc.fields.title ?? "",
        versionId: latest.versionId,
        sectionCount: sectionDocs.length,
        warningCount: parseResult.warnings.length,
      });
    }
    return { status: "success", matchedCount: results.length, results };
  }

  if (body.action === "delete_by_document_id") {
    if (!body.documentId?.trim()) {
      throw new Error("documentId is required.");
    }
    const docPath = `documents/${body.documentId}`;
    const doc = await db.get(docPath);
    if (doc && doc.fields.ownerUserId !== user.uid) {
      const err = new Error("Forbidden.");
      (err as { status?: number }).status = 403;
      throw err;
    }
    if (doc) {
      const storagePath = doc.fields.sourceStoragePath as string | undefined;
      if (storagePath) await bucket.delete(storagePath);
      const versions = await db.query({ parent: docPath, collectionId: "versions" });
      for (const version of versions) {
        await db.deleteCollection(`${docPath}/versions/${version.id}`, "sections");
      }
      await db.deleteCollection(docPath, "versions");
      await db.delete(docPath);
    }
    return { status: "success", deletedDocumentId: body.documentId };
  }

  throw new Error("Unsupported action.");
}
