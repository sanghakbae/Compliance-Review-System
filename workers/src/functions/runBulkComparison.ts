/**
 * Ported from supabase/functions/run-bulk-comparison/index.ts.
 *
 * Compares every owned document's latest version against one law version.
 * Uses the denormalized `documents.latest.versionId` instead of the Postgres
 * "max(version_number) per document" subquery.
 */

import { compareStructuredSections } from "../../../shared/comparisonEngine";
import { Firestore } from "../firestore";
import type { VerifiedUser } from "../firebaseAuth";
import { writeAudit } from "./_common";
import { fetchSectionsByVersion } from "./runComparison";

export interface RunBulkComparisonRequest {
  lawVersionId: string;
}

export async function runBulkComparison(
  body: RunBulkComparisonRequest,
  user: VerifiedUser,
  db: Firestore,
): Promise<Record<string, unknown>> {
  if (!body.lawVersionId?.trim()) {
    throw new Error("lawVersionId is required.");
  }

  const targetSections = await fetchSectionsByVersion(
    db,
    "lawVersionId",
    body.lawVersionId,
    user.uid,
  );
  if (targetSections.length === 0) {
    throw new Error("Law version not found or access denied.");
  }

  // Latest version per owned document (denormalized on the document).
  const documents = await db.query({
    collectionId: "documents",
    where: [{ field: "ownerUserId", op: "EQUAL", value: user.uid }],
  });
  const sourceVersions = documents
    .map((doc) => {
      const latest = doc.fields.latest as { versionId?: string } | undefined;
      return latest?.versionId
        ? { versionId: latest.versionId, documentTitle: (doc.fields.title as string) ?? "" }
        : null;
    })
    .filter((v): v is { versionId: string; documentTitle: string } => Boolean(v));

  if (sourceVersions.length === 0) {
    throw new Error("비교할 정책 또는 지침 문서가 없습니다.");
  }

  const now = new Date();
  const createdRuns: Array<{
    comparisonRunId: string;
    documentVersionId: string;
    documentTitle: string;
    resultCount: number;
  }> = [];

  for (const sourceVersion of sourceVersions) {
    const sourceSections = await fetchSectionsByVersion(
      db,
      "documentVersionId",
      sourceVersion.versionId,
      user.uid,
    );
    const comparison = compareStructuredSections({ sourceSections, targetSections });

    const comparisonRunId = crypto.randomUUID();
    await db.set(`comparisonRuns/${comparisonRunId}`, {
      actorUserId: user.uid,
      sourceDocumentVersionId: sourceVersion.versionId,
      targetLawVersionId: body.lawVersionId,
      warningMessages: comparison.warnings,
      createdAt: now,
    });

    if (comparison.results.length > 0) {
      const writes = comparison.results.map((result) => ({
        type: "set" as const,
        path: `comparisonRuns/${comparisonRunId}/results/${crypto.randomUUID()}`,
        data: {
          comparisonRunId,
          sourceSectionId: result.sourceSectionId,
          targetSectionId: result.targetSectionId,
          affectedPath: result.affectedPath,
          hierarchyType: result.affectedHierarchyType,
          matchType: result.matchType,
          diffType: result.diffType,
          confidence: result.confidence,
          beforeText: result.beforeText,
          afterText: result.afterText,
          explanation: result.explanation,
          reasoningTrace: result.reasoningTrace,
          aiUsed: false,
          createdAt: now,
        },
      }));
      for (let i = 0; i < writes.length; i += 400) {
        await db.commit(writes.slice(i, i + 400));
      }
    }

    await writeAudit(db, {
      actorUserId: user.uid,
      action: "COMPARISON_RUN_CREATED",
      targetDocumentId: null,
      result: "SUCCESS",
      metadata: {
        comparisonRunId,
        documentVersionId: sourceVersion.versionId,
        lawVersionId: body.lawVersionId,
        resultCount: comparison.results.length,
        mode: "bulk_latest_documents",
      },
    });

    createdRuns.push({
      comparisonRunId,
      documentVersionId: sourceVersion.versionId,
      documentTitle: sourceVersion.documentTitle,
      resultCount: comparison.results.length,
    });
  }

  return {
    status: "success",
    data: { comparisonRunCount: createdRuns.length, comparisonRuns: createdRuns },
    warnings: [],
    confidence: 1,
    traceability: {
      targetLawVersionId: body.lawVersionId,
      comparedDocumentVersionIds: createdRuns.map((item) => item.documentVersionId),
      mode: "bulk_latest_document_structural_diff",
    },
  };
}
