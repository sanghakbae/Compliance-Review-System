/** Shared helpers for the ported Edge Functions. */

import { buildSectionHierarchyColumns } from "../../../shared/sectionHierarchyColumns";
import type { ParsedSection } from "../../../shared/policyParser";
import type { Firestore } from "../firestore";

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** R2 object key, mirroring register-document's buildStoragePath (ASCII-safe). */
export function buildStoragePath(userId: string, originalFileName: string): string {
  const extensionMatch = originalFileName.match(/(\.[a-z0-9]+)$/iu);
  const extension = extensionMatch?.[1].toLowerCase() ?? "";
  const baseName = extension ? originalFileName.slice(0, -extension.length) : originalFileName;
  const normalizedBase = baseName
    .normalize("NFKD")
    .split("")
    .filter((character) => character.charCodeAt(0) <= 0x7f)
    .join("")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  const safeBase = normalizedBase || "document";
  return `${userId}/${crypto.randomUUID()}-${safeBase}${extension}`;
}

/** Append-only audit log write (Firestore REST lacks server auto-id). */
export async function writeAudit(
  db: Firestore,
  entry: {
    actorUserId: string;
    action: string;
    targetDocumentId: string | null;
    result: "SUCCESS" | "FAILURE";
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  const id = `${Date.now().toString(36)}-${crypto.randomUUID()}`;
  await db.set(`auditLogs/${id}`, { ...entry, createdAt: new Date() });
}

/**
 * Build a Firestore section document map from a parsed section, including the
 * denormalized hierarchy columns. `parentField` names the version reference
 * field ("documentVersionId" for documents, "lawVersionId" for law sections).
 */
export async function buildSectionDocs(
  sections: ParsedSection[],
  versionId: string,
  parentField: "documentVersionId" | "lawVersionId",
  ownerUserId: string,
): Promise<Array<{ id: string; data: Record<string, unknown> }>> {
  const hierarchyColumnsById = buildSectionHierarchyColumns(sections);
  const now = new Date();
  return Promise.all(
    sections.map(async (section) => ({
      id: section.tempId,
      data: {
        [parentField]: versionId,
        // Denormalized so collection-group queries can enforce ownership without
        // walking up to the parent document (Firestore has no joins).
        ownerUserId,
        parentSectionId: section.parentTempId,
        hierarchyType: section.hierarchyType,
        hierarchyLabel: section.hierarchyLabel,
        hierarchyOrder: section.hierarchyOrder,
        normalizedText: section.normalizedText,
        originalText: section.originalText,
        textHash: await sha256Hex(section.normalizedText),
        pathDisplay: section.path.join(" > "),
        createdAt: now,
        ...hierarchyColumnsById.get(section.tempId),
      },
    })),
  );
}

export function inferDocumentType(input: {
  inputTitle: string;
  parsedTitle: string | null;
  rawText: string;
}): "POLICY" | "GUIDELINE" {
  const candidate = [input.inputTitle, input.parsedTitle ?? "", input.rawText.slice(0, 400)]
    .join(" ")
    .toLowerCase();
  if (candidate.includes("지침") || candidate.includes("guideline")) {
    return "GUIDELINE";
  }
  return "POLICY";
}
