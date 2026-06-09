/**
 * Ported from supabase/functions/run-comparison/index.ts.
 *
 * Sections live deep in Firestore (documents/.../sections, lawSources/.../sections).
 * We locate them by version FK via collection-group queries, filtered by the
 * denormalized ownerUserId for access control (replaces the Postgres inner join
 * on owner_user_id).
 */

import {
  compareStructuredSections,
  type ComparableSection,
} from "../../../shared/comparisonEngine";
import { Firestore, type FirestoreDoc } from "../firestore";
import type { VerifiedUser } from "../firebaseAuth";
import { writeAudit } from "./_common";

export interface RunComparisonRequest {
  documentVersionId: string;
  lawVersionId: string;
}

function validateInput(body: RunComparisonRequest): void {
  if (!body.documentVersionId?.trim()) throw new Error("documentVersionId is required.");
  if (!body.lawVersionId?.trim()) throw new Error("lawVersionId is required.");
}

export function toComparable(doc: FirestoreDoc): ComparableSection {
  const f = doc.fields;
  return {
    id: doc.id,
    parentSectionId: (f.parentSectionId as string | null) ?? null,
    hierarchyType: f.hierarchyType as ComparableSection["hierarchyType"],
    hierarchyLabel: (f.hierarchyLabel as string) ?? "",
    hierarchyOrder: (f.hierarchyOrder as number) ?? 0,
    normalizedText: (f.normalizedText as string) ?? "",
    originalText: (f.originalText as string) ?? "",
    pathDisplay: (f.pathDisplay as string) ?? "",
  };
}

export async function fetchSectionsByVersion(
  db: Firestore,
  field: "documentVersionId" | "lawVersionId",
  versionId: string,
  uid: string,
): Promise<ComparableSection[]> {
  const docs = await db.queryGroup({
    collectionId: "sections",
    where: [
      { field, op: "EQUAL", value: versionId },
      { field: "ownerUserId", op: "EQUAL", value: uid },
    ],
    orderBy: { field: "hierarchyOrder", direction: "ASCENDING" },
  });
  return docs.map(toComparable);
}

export async function runComparison(
  body: RunComparisonRequest,
  user: VerifiedUser,
  db: Firestore,
): Promise<Record<string, unknown>> {
  validateInput(body);

  const [sourceSections, targetSections] = await Promise.all([
    fetchSectionsByVersion(db, "documentVersionId", body.documentVersionId, user.uid),
    fetchSectionsByVersion(db, "lawVersionId", body.lawVersionId, user.uid),
  ]);

  if (sourceSections.length === 0) {
    throw new Error("Document version not found or access denied.");
  }
  if (targetSections.length === 0) {
    throw new Error("Law version not found or access denied.");
  }

  const comparison = compareStructuredSections({ sourceSections, targetSections });

  const comparisonRunId = crypto.randomUUID();
  const now = new Date();
  await db.set(`comparisonRuns/${comparisonRunId}`, {
    actorUserId: user.uid,
    sourceDocumentVersionId: body.documentVersionId,
    targetLawVersionId: body.lawVersionId,
    warningMessages: comparison.warnings,
    createdAt: now,
  });

  if (comparison.results.length > 0) {
    const writes = comparison.results.map((result) => {
      const id = crypto.randomUUID();
      return {
        type: "set" as const,
        path: `comparisonRuns/${comparisonRunId}/results/${id}`,
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
      };
    });
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
      documentVersionId: body.documentVersionId,
      lawVersionId: body.lawVersionId,
      resultCount: comparison.results.length,
    },
  });

  return {
    status: "success",
    data: {
      comparisonRunId,
      resultCount: comparison.results.length,
      results: comparison.results,
    },
    warnings: comparison.warnings,
    confidence: 1,
    traceability: {
      sourceDocumentVersionId: body.documentVersionId,
      targetLawVersionId: body.lawVersionId,
      mode: "deterministic_structural_diff",
    },
  };
}
