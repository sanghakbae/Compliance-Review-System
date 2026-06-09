/**
 * Ported from supabase/functions/register-document/index.ts.
 *
 * Uploads the source file to R2, parses the policy text, and writes the
 * document + version 1 + sections + audit log to Firestore.
 */

import { parsePolicyText } from "../../../shared/policyParser";
import { Firestore } from "../firestore";
import type { VerifiedUser } from "../firebaseAuth";
import {
  buildSectionDocs,
  buildStoragePath,
  decodeBase64,
  inferDocumentType,
  writeAudit,
} from "./_common";

export interface RegisterDocumentRequest {
  title: string;
  description?: string;
  documentType?: "POLICY" | "GUIDELINE";
  originalFileName: string;
  fileContentBase64: string;
  contentType?: string;
  rawText: string;
}

function validateInput(body: RegisterDocumentRequest): void {
  if (!body.title?.trim()) throw new Error("Title is required.");
  if (!/\.(txt|md|docx)$/iu.test(body.originalFileName)) {
    throw new Error("Only .txt, .md, and .docx uploads are allowed.");
  }
  if (!body.fileContentBase64?.trim()) throw new Error("File content is required.");
  if (!body.rawText?.trim()) throw new Error("Raw text is required.");
}

export async function registerDocument(
  body: RegisterDocumentRequest,
  user: VerifiedUser,
  db: Firestore,
  bucket: R2Bucket,
): Promise<Record<string, unknown>> {
  validateInput(body);

  const storagePath = buildStoragePath(user.uid, body.originalFileName);
  const fileBytes = decodeBase64(body.fileContentBase64);
  await bucket.put(storagePath, fileBytes, {
    httpMetadata: { contentType: body.contentType || "application/octet-stream" },
  });

  const parseResult = parsePolicyText(body.rawText);
  const documentType = inferDocumentType({
    inputTitle: body.title,
    parsedTitle: parseResult.metadata.title,
    rawText: body.rawText,
  });

  const documentId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const now = new Date();

  const sectionDocs = await buildSectionDocs(
    parseResult.sections,
    versionId,
    "documentVersionId",
    user.uid,
  );

  await db.set(`documents/${documentId}`, {
    workspaceId: null,
    ownerUserId: user.uid,
    title: body.title,
    description: body.description ?? null,
    documentType,
    sourceStoragePath: storagePath,
    sourceFileName: body.originalFileName,
    createdAt: now,
    latest: {
      versionId,
      versionNumber: 1,
      sectionCount: sectionDocs.length,
      effectiveDate: null,
      createdAt: now,
    },
  });

  await db.set(`documents/${documentId}/versions/${versionId}`, {
    id: versionId,
    documentId,
    ownerUserId: user.uid,
    versionNumber: 1,
    rawText: body.rawText,
    parseWarnings: parseResult.warnings,
    effectiveDate: null,
    createdAt: now,
  });

  const sectionPrefix = `documents/${documentId}/versions/${versionId}/sections`;
  const writes = sectionDocs.map((s) => ({
    type: "set" as const,
    path: `${sectionPrefix}/${s.id}`,
    data: s.data,
  }));
  for (let i = 0; i < writes.length; i += 400) {
    await db.commit(writes.slice(i, i + 400));
  }

  await writeAudit(db, {
    actorUserId: user.uid,
    action: "DOCUMENT_REGISTERED",
    targetDocumentId: documentId,
    result: "SUCCESS",
    metadata: {
      versionId,
      sectionCount: sectionDocs.length,
      warningCount: parseResult.warnings.length,
    },
  });

  return {
    status: "success",
    data: {
      documentId,
      versionId,
      sectionCount: sectionDocs.length,
      warnings: parseResult.warnings,
    },
    warnings: parseResult.warnings,
    confidence: 1,
    traceability: { storagePath, originalFileName: body.originalFileName },
  };
}
