/**
 * Ported from supabase/functions/manage-law-source/index.ts.
 *
 * Locates the law version via a collection-group lookup by its self `id` field
 * (Firestore can't query a deeply nested doc by id alone), derives the parent
 * lawSource from the resource path, and enforces ownership on the parent.
 */

import { parsePolicyText } from "../../../shared/policyParser";
import { Firestore, type FirestoreDoc } from "../firestore";
import type { VerifiedUser } from "../firebaseAuth";
import { buildSectionDocs, writeAudit } from "./_common";

export type ManageLawSourceRequest =
  | {
      action: "update";
      lawVersionId: string;
      sourceLink?: string;
      sourceTitle?: string;
      versionLabel?: string;
      effectiveDate?: string | null;
    }
  | { action: "reparse"; lawVersionId: string }
  | { action: "delete"; lawVersionId: string };

const ALLOWED_HOSTS = new Set(["law.go.kr", "www.law.go.kr", "elaw.klri.re.kr"]);

function lawSourceIdFromName(version: FirestoreDoc): string {
  // .../lawSources/{lawSourceId}/versions/{lawVersionId}
  const parts = version.name.split("/");
  const idx = parts.lastIndexOf("lawSources");
  return idx >= 0 ? parts[idx + 1] : (version.fields.lawSourceId as string);
}

export async function manageLawSource(
  body: ManageLawSourceRequest,
  user: VerifiedUser,
  db: Firestore,
): Promise<Record<string, unknown>> {
  const [version] = await db.queryGroup({
    collectionId: "versions",
    where: [{ field: "id", op: "EQUAL", value: body.lawVersionId }],
    limit: 1,
  });
  if (!version || version.fields.lawSourceId == null) {
    throw new Error("Law version not found.");
  }
  const lawSourceId = lawSourceIdFromName(version);
  const lawSource = await db.get(`lawSources/${lawSourceId}`);
  if (!lawSource || lawSource.fields.ownerUserId !== user.uid) {
    const err = new Error("Forbidden.");
    (err as { status?: number }).status = 403;
    throw err;
  }

  const versionPath = `lawSources/${lawSourceId}/versions/${body.lawVersionId}`;

  if (body.action === "update") {
    const nextSourceLink = body.sourceLink?.startsWith("storage://")
      || body.sourceLink?.startsWith("r2://")
      ? body.sourceLink
      : body.sourceLink?.trim()
        ? validateAllowedSourceUrl(body.sourceLink).toString()
        : (lawSource.fields.sourceLink as string);

    await db.update(`lawSources/${lawSourceId}`, {
      sourceLink: nextSourceLink,
      sourceTitle: body.sourceTitle?.trim() || null,
    });
    await db.update(versionPath, {
      versionLabel: body.versionLabel?.trim() || null,
      effectiveDate: body.effectiveDate || null,
    });
    await writeAudit(db, {
      actorUserId: user.uid,
      action: "LAW_SOURCE_UPDATED",
      targetDocumentId: null,
      result: "SUCCESS",
      metadata: { lawVersionId: body.lawVersionId, lawSourceId },
    });
    return { status: "success", data: { lawVersionId: body.lawVersionId } };
  }

  if (body.action === "reparse") {
    const parseResult = parsePolicyText((version.fields.rawText as string) ?? "");
    const sectionDocs = await buildSectionDocs(
      parseResult.sections,
      body.lawVersionId,
      "lawVersionId",
      user.uid,
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
    await writeAudit(db, {
      actorUserId: user.uid,
      action: "LAW_SOURCE_REPARSED",
      targetDocumentId: null,
      result: "SUCCESS",
      metadata: { lawVersionId: body.lawVersionId, lawSourceId, sectionCount: sectionDocs.length },
    });
    return {
      status: "success",
      data: {
        lawVersionId: body.lawVersionId,
        sectionCount: sectionDocs.length,
        warnings: parseResult.warnings,
      },
    };
  }

  // delete
  await db.deleteCollection(versionPath, "sections");
  await db.delete(versionPath);

  const remaining = await db.query({
    parent: `lawSources/${lawSourceId}`,
    collectionId: "versions",
    limit: 1,
  });
  if (remaining.length === 0) {
    await db.delete(`lawSources/${lawSourceId}`);
  }

  await writeAudit(db, {
    actorUserId: user.uid,
    action: "LAW_SOURCE_DELETED",
    targetDocumentId: null,
    result: "SUCCESS",
    metadata: { lawVersionId: body.lawVersionId, lawSourceId },
  });
  return { status: "success", data: { lawVersionId: body.lawVersionId } };
}

function validateAllowedSourceUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("법령 URL은 HTTPS만 허용합니다.");
  if (!ALLOWED_HOSTS.has(url.hostname)) throw new Error("허용되지 않은 법령 도메인입니다.");
  return url;
}
