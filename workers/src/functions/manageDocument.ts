/**
 * Ported from supabase/functions/manage-document/index.ts.
 *
 * Supabase Postgres + Storage  →  Firestore + R2.
 *   - policy_documents          → documents/{docId}
 *   - policy_document_versions  → documents/{docId}/versions/{verId}
 *   - policy_document_sections  → documents/{docId}/versions/{verId}/sections/{secId}
 *   - policy_audit_logs         → auditLogs/{logId}
 *   - storage source-documents  → R2 SOURCE_DOCUMENTS
 */

import { parsePolicyText } from "../../../shared/policyParser";
import { Firestore } from "../firestore";
import type { VerifiedUser } from "../firebaseAuth";
import { buildSectionDocs, writeAudit } from "./_common";

export interface ManageDocumentRequest {
  action: "delete" | "reparse";
  documentId: string;
}

export async function manageDocument(
  body: ManageDocumentRequest,
  user: VerifiedUser,
  db: Firestore,
  bucket: R2Bucket,
): Promise<{ status: "success"; data: Record<string, unknown> }> {
  if (!body.documentId?.trim()) {
    throw new Error("documentId is required.");
  }

  const docPath = `documents/${body.documentId}`;
  const document = await db.get(docPath);
  if (!document) {
    throw new Error("Document not found.");
  }
  if (document.fields.ownerUserId !== user.uid) {
    const err = new Error("Forbidden.");
    (err as { status?: number }).status = 403;
    throw err;
  }

  if (body.action === "reparse") {
    const [latest] = await db.query({
      parent: docPath,
      collectionId: "versions",
      orderBy: { field: "versionNumber", direction: "DESCENDING" },
      limit: 1,
    });
    if (!latest) {
      throw new Error("Latest document version not found.");
    }

    const rawText = (latest.fields.rawText as string) ?? "";
    const parseResult = parsePolicyText(rawText);
    const sectionDocs = await buildSectionDocs(
      parseResult.sections,
      latest.id,
      "documentVersionId",
      user.uid,
    );
    const sectionPrefix = `${docPath}/versions/${latest.id}/sections`;
    const sectionWrites = sectionDocs.map((s) => ({
      type: "set" as const,
      path: `${sectionPrefix}/${s.id}`,
      data: s.data,
    }));

    // Replace the version's sections.
    await db.deleteCollection(`${docPath}/versions/${latest.id}`, "sections");
    for (let i = 0; i < sectionWrites.length; i += 400) {
      await db.commit(sectionWrites.slice(i, i + 400));
    }
    await db.update(`${docPath}/versions/${latest.id}`, {
      parseWarnings: parseResult.warnings,
    });

    await writeAudit(db, {
      actorUserId: user.uid,
      action: "DOCUMENT_REPARSED",
      targetDocumentId: body.documentId,
      result: "SUCCESS",
      metadata: {
        documentId: body.documentId,
        versionId: latest.id,
        sectionCount: sectionWrites.length,
      },
    });

    return {
      status: "success",
      data: {
        documentId: body.documentId,
        versionId: latest.id,
        sectionCount: sectionWrites.length,
        warnings: parseResult.warnings,
      },
    };
  }

  // delete
  const storagePath = document.fields.sourceStoragePath as string | undefined;
  if (storagePath) {
    await bucket.delete(storagePath);
  }

  // Recursively remove subcollections (Firestore doc delete is not cascading).
  const versions = await db.query({ parent: docPath, collectionId: "versions" });
  for (const version of versions) {
    await db.deleteCollection(`${docPath}/versions/${version.id}`, "sections");
  }
  await db.deleteCollection(docPath, "versions");
  await db.delete(docPath);

  await writeAudit(db, {
    actorUserId: user.uid,
    action: "DOCUMENT_DELETED",
    targetDocumentId: body.documentId,
    result: "SUCCESS",
    metadata: { documentId: body.documentId },
  });

  return { status: "success", data: { documentId: body.documentId } };
}
