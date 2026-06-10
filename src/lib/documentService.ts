import mammoth from "mammoth";
import {
  collection,
  collectionGroup,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  orderBy,
  limit as fbLimit,
  writeBatch,
  setDoc,
  updateDoc,
  deleteDoc,
  type DocumentData,
} from "firebase/firestore";
import { getDb } from "./firebaseDb";
import { getCurrentAppSession, type AppAuthSession } from "./firebaseAuth";
import * as workerApi from "./workerApi";
import type {
  AiRevisionGuidance,
  AiRevisionStageResult,
  AiRevisionPromptOverrides,
  AiReportHistoryEntry,
  AiReportHistorySummary,
  PromptSlotList,
  AggregatedComparisonResultRecord,
  AiRevisionAnalysisStage,
  ComparisonReviewAggregate,
  ComparisonResultRecord,
  ComparisonReviewDetail,
  ComparisonRunSummary,
  DocumentDetail,
  DocumentSummary,
  HierarchyType,
  LawDetail,
  LawVersionSummary,
  OpenAiSettings,
  ReviewExecutionHistoryEntry,
  SecuritySettings,
  WorkspaceFavorite,
  WorkspaceSelectionSnapshot,
} from "../types";
import { parsePolicyText, type ParsedSection } from "../../shared/policyParser";
import { buildSectionHierarchyColumns } from "../../shared/sectionHierarchyColumns";

const STRUCTURED_XLSX_IMPORT_WARNING = "STRUCTURED_XLSX_IMPORT_LOCKED";

interface ComparisonRunMetaRow {
  id: string;
  source_document_version_id: string;
  target_law_version_id: string;
  policy_document_versions:
    | {
        document_id?: string;
      }
    | Array<{
        document_id?: string;
      }>
    | null;
}

interface WorkspaceFavoriteRow {
  id: string;
  name: string;
  updated_at: string;
  selected_document_id: string | null;
  target_document_ids: string[] | null;
  reference_document_ids: string[] | null;
  law_version_ids: string[] | null;
}

interface PolicyUserSettingsRow {
  openai_api_key: string | null;
  openai_model: string | null;
}

interface PolicySecuritySettingsRow {
  allowed_email_domain: string | null;
  session_idle_timeout_minutes: number | null;
}

interface ReviewExecutionHistoryRow {
  id: string;
  reviewer_email: string;
  target_titles: string[] | null;
  reference_titles: string[] | null;
  comparison_run_ids: string[] | null;
  ai_report_history_id?: string | null;
  result_status: ReviewExecutionHistoryEntry["resultStatus"] | null;
  created_at: string;
}

interface AiReportHistoryRow {
  id: string;
  title: string;
  selection_summary: string;
  selection_counts: unknown;
  guidance?: unknown;
  created_at: string;
}

export interface ImportedStructuredDocumentRow {
  chapterLabel: string;
  articleLabel: string;
  paragraphLabel: string;
  itemLabel: string;
  subItemLabel: string;
  content: string;
}

export async function uploadDocument(input: {
  file: File;
  title: string;
  description: string;
}) {
  try {
    await ensureAuthenticatedSession();
    const fileContentBase64 = await encodeFileAsBase64(input.file);
    const fileText = await extractDocumentText(input.file);

    // R2 upload + Firestore writes happen server-side in the Worker.
    const result = (await invokeEdgeFunction("register-document", {
      title: input.title,
      description: input.description || undefined,
      originalFileName: input.file.name,
      fileContentBase64,
      contentType: input.file.type || guessContentType(input.file.name),
      rawText: fileText,
    })) as { data?: Record<string, unknown> };

    const data = result.data ?? {};
    return {
      status: "success",
      data: {
        documentId: data.documentId,
        versionId: data.versionId,
        sectionCount: data.sectionCount ?? 0,
        warnings: asStringArray(data.warnings),
        supersededDocumentCount: 0,
      },
    };
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }

    throw new Error("업로드 중 알 수 없는 오류가 발생했습니다.");
  }
}

export async function uploadRawTextDocument(input: {
  rawText: string;
  title: string;
  description: string;
  sourceFileName: string;
}) {
  await ensureAuthenticatedSession();
  const fileContentBase64 = btoa(
    String.fromCharCode(...new TextEncoder().encode(input.rawText)),
  );
  const result = (await invokeEdgeFunction("register-document", {
    title: input.title,
    description: input.description || undefined,
    originalFileName: input.sourceFileName,
    fileContentBase64,
    contentType: "text/plain",
    rawText: input.rawText,
  })) as { data?: Record<string, unknown> };

  const data = result.data ?? {};
  return {
    status: "success",
    data: {
      documentId: data.documentId,
      versionId: data.versionId,
      sectionCount: data.sectionCount ?? 0,
      warnings: asStringArray(data.warnings),
      supersededDocumentCount: 0,
    },
  };
}

export async function uploadStructuredRowsDocument(input: {
  rows: ImportedStructuredDocumentRow[];
  title: string;
  description: string;
  sourceFileName: string;
}) {
  await ensureAuthenticatedSession();
  const rawText = input.rows.map((row) => row.content).join("\n");
  const fileContentBase64 = btoa(String.fromCharCode(...new TextEncoder().encode(rawText)));
  const result = (await invokeEdgeFunction("register-document", {
    title: input.title,
    description: input.description || undefined,
    originalFileName: input.sourceFileName,
    fileContentBase64,
    contentType: "text/plain",
    rawText,
  })) as { data?: Record<string, unknown> };

  const data = result.data ?? {};
  return {
    status: "success",
    data: {
      documentId: data.documentId,
      versionId: data.versionId,
      sectionCount: data.sectionCount ?? 0,
      warnings: asStringArray(data.warnings),
      supersededDocumentCount: 0,
    },
  };
}

async function buildImportedDocumentSectionRows(
  versionId: string,
  rows: ImportedStructuredDocumentRow[],
) {
  const sectionRows = await Promise.all(rows
    .map((row, index) => ({
      ...row,
      content: row.content,
      order: index + 1,
    }))
    .filter((row) => row.content.length > 0)
    .map(async (row) => {
      const hierarchy = getImportedRowHierarchy(row);
      const pathDisplay = [
        row.chapterLabel,
        row.articleLabel,
        row.paragraphLabel,
        row.itemLabel,
        row.subItemLabel,
      ].map((value) => value.trim()).filter(Boolean).join(" > ");

      return {
        id: crypto.randomUUID(),
        document_version_id: versionId,
        parent_section_id: null,
        hierarchy_type: hierarchy.type,
        hierarchy_label: hierarchy.label,
        hierarchy_order: row.order,
        normalized_text: normalizeSectionText(row.content),
        original_text: row.content,
        text_hash: await sha256Hex(normalizeSectionText(row.content)),
        path_display: pathDisplay,
        chapter_label: nullableTrim(row.chapterLabel),
        chapter_text: hierarchy.type === "chapter" ? row.content : null,
        article_label: nullableTrim(row.articleLabel),
        article_text: hierarchy.type === "article" ? row.content : null,
        paragraph_label: nullableTrim(row.paragraphLabel),
        paragraph_text: hierarchy.type === "paragraph" ? row.content : null,
        item_label: nullableTrim(row.itemLabel),
        item_text: hierarchy.type === "item" ? row.content : null,
        sub_item_label: nullableTrim(row.subItemLabel),
        sub_item_text: hierarchy.type === "sub_item" ? row.content : null,
      };
    }));

  return sectionRows;
}

function getImportedRowHierarchy(row: ImportedStructuredDocumentRow): {
  type: HierarchyType;
  label: string;
} {
  const candidates: Array<{ type: HierarchyType; label: string }> = [
    { type: "sub_item", label: row.subItemLabel },
    { type: "item", label: row.itemLabel },
    { type: "paragraph", label: row.paragraphLabel },
    { type: "article", label: row.articleLabel },
    { type: "chapter", label: row.chapterLabel },
  ];
  const deepest = candidates.find((candidate) => candidate.label.trim());
  return deepest ?? { type: "document", label: "문서" };
}

async function buildFallbackDocumentSectionRow(versionId: string, rawText: string) {
  const normalizedText = normalizeSectionText(rawText);
  return {
    id: crypto.randomUUID(),
    document_version_id: versionId,
    parent_section_id: null,
    hierarchy_type: "document" as const,
    hierarchy_label: "문서",
    hierarchy_order: 1,
    normalized_text: normalizedText,
    original_text: rawText,
    text_hash: await sha256Hex(normalizedText),
    path_display: "문서",
    chapter_label: null,
    chapter_text: null,
    article_label: null,
    article_text: null,
    paragraph_label: null,
    paragraph_text: null,
    item_label: null,
    item_text: null,
    sub_item_label: null,
    sub_item_text: null,
  };
}

function normalizeSectionText(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}

function nullableTrim(value: string) {
  const trimmed = value.trim();
  return trimmed || null;
}

export async function deleteDocument(input: { documentId: string }) {
  const session = await ensureAuthenticatedSession();
  await invokeEdgeFunction("manage-document", {
    action: "delete",
    documentId: input.documentId,
  });
  return {
    status: "success",
    data: {
      documentId: input.documentId,
      deletedBy: session.user.id,
    },
  };
}

export async function reparseDocument(input: { documentId: string }) {
  const session = await ensureAuthenticatedSession();
  const result = (await invokeEdgeFunction("manage-document", {
    action: "reparse",
    documentId: input.documentId,
  })) as { data?: Record<string, unknown> };

  const data = result.data ?? {};
  return {
    status: "success",
    data: {
      documentId: input.documentId,
      versionId: data.versionId,
      sectionCount: data.sectionCount ?? 0,
      warningCount: asStringArray(data.warnings).length,
      reparsedBy: session.user.id,
    },
  };
}

export async function listDocuments(): Promise<DocumentSummary[]> {
  const session = await ensureAuthenticatedSession();
  const db = getDb();
  const snap = await getDocs(
    query(collection(db, "documents"), where("ownerUserId", "==", session.user.id)),
  );
  const summaries = snap.docs.map((entry) => {
    const f = entry.data();
    const latest = (f.latest ?? {}) as DocumentData;
    return {
      id: entry.id,
      title: f.title ?? "",
      document_type: f.documentType,
      version_number: latest.versionNumber ?? 1,
      version_id: latest.versionId ?? "",
      created_at: fsIso(f.createdAt),
      effective_date: fsIsoOrNull(latest.effectiveDate),
      section_count: latest.sectionCount ?? 0,
    } as DocumentSummary;
  });
  return summaries.sort(compareDocumentSummaryForList);
}

function compareDocumentSummaryForList(left: DocumentSummary, right: DocumentSummary) {
  const priorityDiff = getDocumentListPriority(left) - getDocumentListPriority(right);
  if (priorityDiff !== 0) {
    return priorityDiff;
  }

  return new Date(right.created_at).getTime() - new Date(left.created_at).getTime();
}

function getDocumentListPriority(document: Pick<DocumentSummary, "title">) {
  const title = document.title.trim();
  return title.endsWith("정책") || title.endsWith("지침") ? 1 : 0;
}

export async function listWorkspaceFavorites(): Promise<WorkspaceFavorite[]> {
  const session = await ensureAuthenticatedSession();
  const db = getDb();
  const snap = await getDocs(collection(db, `users/${session.user.id}/favorites`));
  return snap.docs
    .map((entry) => {
      const f = entry.data();
      return {
        id: entry.id,
        name: f.name ?? "",
        updatedAt: fsIso(f.updatedAt) || fsIso(f.createdAt),
        selection: normalizeWorkspaceSelectionSnapshot({
          selectedDocumentId: f.selectedDocumentId ?? null,
          targetDocumentIds: asStringArray(f.targetDocumentIds),
          referenceDocumentIds: asStringArray(f.referenceDocumentIds),
          lawVersionIds: asStringArray(f.lawVersionIds),
        }),
      } satisfies WorkspaceFavorite;
    })
    .sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : b.updatedAt < a.updatedAt ? -1 : 0));
}

function mapReviewHistoryDoc(id: string, f: DocumentData): ReviewExecutionHistoryEntry {
  const comparisonRunIds = asStringArray(f.comparisonRunIds);
  return {
    id,
    createdAt: fsIso(f.createdAt),
    reviewerEmail: (f.reviewerEmail ?? "") as string,
    targetTitles: asStringArray(f.targetTitles),
    referenceTitles: asStringArray(f.referenceTitles),
    comparisonRunIds,
    aiReportHistoryId: (f.aiReportHistoryId ?? null) as string | null,
    resultStatus:
      (f.resultStatus as ReviewExecutionHistoryEntry["resultStatus"]) ??
      (comparisonRunIds.length > 0 ? "comparison_completed" : "pending"),
  };
}

export async function listReviewExecutionHistory(): Promise<ReviewExecutionHistoryEntry[]> {
  const session = await ensureAuthenticatedSession();
  const snap = await getDocs(collection(getDb(), `users/${session.user.id}/reviewHistory`));
  return snap.docs
    .map((entry) => mapReviewHistoryDoc(entry.id, entry.data()))
    .sort((a, b) => (b.createdAt > a.createdAt ? 1 : b.createdAt < a.createdAt ? -1 : 0));
}

export async function saveReviewExecutionHistoryEntry(input: {
  reviewerEmail: string;
  targetTitles: string[];
  referenceTitles: string[];
  comparisonRunIds: string[];
  aiReportHistoryId?: string | null;
  resultStatus?: ReviewExecutionHistoryEntry["resultStatus"];
}) {
  const session = await ensureAuthenticatedSession();
  const id = crypto.randomUUID();
  const createdAt = new Date();
  const resultStatus =
    input.resultStatus ?? (input.comparisonRunIds.length > 0 ? "comparison_completed" : "pending");
  await setDoc(doc(getDb(), `users/${session.user.id}/reviewHistory/${id}`), {
    reviewerEmail: input.reviewerEmail,
    targetTitles: input.targetTitles,
    referenceTitles: input.referenceTitles,
    comparisonRunIds: input.comparisonRunIds,
    aiReportHistoryId: input.aiReportHistoryId ?? null,
    resultStatus,
    createdAt,
  });
  return {
    id,
    createdAt: createdAt.toISOString(),
    reviewerEmail: input.reviewerEmail,
    targetTitles: input.targetTitles,
    referenceTitles: input.referenceTitles,
    comparisonRunIds: input.comparisonRunIds,
    aiReportHistoryId: input.aiReportHistoryId ?? null,
    resultStatus,
  } satisfies ReviewExecutionHistoryEntry;
}

export async function updateReviewExecutionHistoryStatus(input: {
  entryId: string;
  resultStatus: ReviewExecutionHistoryEntry["resultStatus"];
  aiReportHistoryId?: string | null;
}) {
  const session = await ensureAuthenticatedSession();
  const ref = doc(getDb(), `users/${session.user.id}/reviewHistory/${input.entryId}`);
  await updateDoc(ref, {
    resultStatus: input.resultStatus,
    ...(input.aiReportHistoryId !== undefined ? { aiReportHistoryId: input.aiReportHistoryId } : {}),
  });
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    throwAuthAwareError("review execution history update failed");
  }
  return mapReviewHistoryDoc(snap.id, snap.data());
}

function toAiReportRow(id: string, f: DocumentData): AiReportHistoryRow {
  return {
    id,
    title: (f.title ?? "") as string,
    selection_summary: (f.selectionSummary ?? f.selection_summary ?? "") as string,
    selection_counts: f.selectionCounts ?? f.selection_counts ?? {},
    guidance: f.guidance,
    created_at: fsIso(f.createdAt),
  };
}

export async function listAiReportHistory(): Promise<AiReportHistorySummary[]> {
  const session = await ensureAuthenticatedSession();
  const snap = await getDocs(collection(getDb(), `users/${session.user.id}/aiReportHistory`));
  return snap.docs
    .map((entry) => toAiReportRow(entry.id, entry.data()))
    .sort((a, b) => (b.created_at > a.created_at ? 1 : b.created_at < a.created_at ? -1 : 0))
    .slice(0, 50)
    .flatMap((row) => {
      const entry = normalizeAiReportHistorySummaryRow(row);
      return entry ? [entry] : [];
    });
}

export async function getAiReportHistoryEntry(entryId: string): Promise<AiReportHistoryEntry | null> {
  const session = await ensureAuthenticatedSession();
  const snap = await getDoc(doc(getDb(), `users/${session.user.id}/aiReportHistory/${entryId}`));
  return snap.exists() ? normalizeAiReportHistoryRow(toAiReportRow(snap.id, snap.data())) : null;
}

export async function saveAiReportHistoryEntry(input: {
  title: string;
  selectionSummary: string;
  selectionCounts: AiReportHistoryEntry["selectionCounts"];
  guidance: AiReportHistoryEntry["guidance"];
}) {
  const session = await ensureAuthenticatedSession();
  const id = crypto.randomUUID();
  const createdAt = new Date();
  await setDoc(doc(getDb(), `users/${session.user.id}/aiReportHistory/${id}`), {
    title: input.title,
    selectionSummary: input.selectionSummary,
    selectionCounts: input.selectionCounts,
    guidance: input.guidance,
    createdAt,
  });
  const normalized = normalizeAiReportHistoryRow({
    id,
    title: input.title,
    selection_summary: input.selectionSummary,
    selection_counts: input.selectionCounts,
    guidance: input.guidance,
    created_at: createdAt.toISOString(),
  });
  if (!normalized) {
    throw new Error(buildAuthDebugMessage("ai report history save failed: invalid saved payload.", null));
  }
  return normalized;
}

export async function deleteAiReportHistoryEntry(entryId: string) {
  const session = await ensureAuthenticatedSession();
  await deleteDoc(doc(getDb(), `users/${session.user.id}/aiReportHistory/${entryId}`));
}

export async function saveWorkspaceFavorite(input: {
  favoriteId?: string;
  name: string;
  selection: WorkspaceSelectionSnapshot;
}) {
  const session = await ensureAuthenticatedSession();
  const db = getDb();
  const favoritesPath = `users/${session.user.id}/favorites`;
  const normalizedSelection = normalizeWorkspaceSelectionSnapshot(input.selection);
  const updatedAt = new Date();

  // Resolve target id: explicit favoriteId, else dedupe by name (onConflict).
  let favoriteId = input.favoriteId ?? null;
  if (!favoriteId) {
    const existing = await getDocs(
      query(collection(db, favoritesPath), where("name", "==", input.name), fbLimit(1)),
    );
    favoriteId = existing.empty ? crypto.randomUUID() : existing.docs[0].id;
  }

  await setDoc(
    doc(db, `${favoritesPath}/${favoriteId}`),
    {
      name: input.name,
      selectedDocumentId: normalizedSelection.selectedDocumentId,
      targetDocumentIds: normalizedSelection.targetDocumentIds,
      referenceDocumentIds: normalizedSelection.referenceDocumentIds,
      lawVersionIds: normalizedSelection.lawVersionIds,
      updatedAt,
    },
    { merge: true },
  );

  return {
    id: favoriteId,
    name: input.name,
    updatedAt: updatedAt.toISOString(),
    selection: normalizedSelection,
  } satisfies WorkspaceFavorite;
}

export async function deleteWorkspaceFavorite(favoriteId: string) {
  const session = await ensureAuthenticatedSession();
  await deleteDoc(doc(getDb(), `users/${session.user.id}/favorites/${favoriteId}`));
}

export async function getPolicyUserOpenAiSettings(defaultModel: string): Promise<OpenAiSettings> {
  const session = await ensureAuthenticatedSession();
  const snap = await getDoc(doc(getDb(), `users/${session.user.id}/settings/openai`));
  const f = snap.exists() ? snap.data() : {};
  const apiKey = (f.openaiApiKey ?? f.openai_api_key ?? f.apiKey ?? "") as string;
  const model = ((f.openaiModel ?? f.openai_model ?? f.model ?? "") as string).trim();
  return { apiKey, model: model || defaultModel };
}

export async function savePolicyUserOpenAiSettings(settings: OpenAiSettings, defaultModel: string) {
  const session = await ensureAuthenticatedSession();
  await setDoc(
    doc(getDb(), `users/${session.user.id}/settings/openai`),
    {
      openaiApiKey: settings.apiKey,
      openaiModel: settings.model.trim() || defaultModel,
      updatedAt: new Date(),
    },
    { merge: true },
  );
}

export async function getPolicySecuritySettings(defaultSettings: SecuritySettings): Promise<SecuritySettings> {
  const session = await ensureAuthenticatedSession();
  const snap = await getDoc(doc(getDb(), `users/${session.user.id}/settings/security`));
  const f = snap.exists() ? snap.data() : {};
  return normalizeSecuritySettings(
    {
      allowedEmailDomain:
        (f.allowedEmailDomain ?? f.allowed_email_domain ?? defaultSettings.allowedEmailDomain) as string,
      sessionIdleTimeoutMinutes:
        (f.sessionIdleTimeoutMinutes ??
          f.session_idle_timeout_minutes ??
          defaultSettings.sessionIdleTimeoutMinutes) as number,
    },
    defaultSettings,
  );
}

export async function savePolicySecuritySettings(settings: SecuritySettings, defaultSettings: SecuritySettings) {
  const session = await ensureAuthenticatedSession();
  const normalizedSettings = normalizeSecuritySettings(settings, defaultSettings);
  await setDoc(
    doc(getDb(), `users/${session.user.id}/settings/security`),
    {
      allowedEmailDomain: normalizedSettings.allowedEmailDomain,
      sessionIdleTimeoutMinutes: normalizedSettings.sessionIdleTimeoutMinutes,
      updatedAt: new Date(),
    },
    { merge: true },
  );
  return normalizedSettings;
}

function normalizeSecuritySettings(settings: SecuritySettings, defaultSettings: SecuritySettings): SecuritySettings {
  const allowedEmailDomain =
    settings.allowedEmailDomain.trim().toLowerCase().replace(/^@/u, "") ||
    defaultSettings.allowedEmailDomain;
  const sessionIdleTimeoutMinutes = Number.isFinite(settings.sessionIdleTimeoutMinutes)
    ? Math.min(1440, Math.max(1, Math.round(settings.sessionIdleTimeoutMinutes)))
    : defaultSettings.sessionIdleTimeoutMinutes;

  return {
    allowedEmailDomain,
    sessionIdleTimeoutMinutes,
  };
}

export async function getDocumentDetail(
  documentId: string,
): Promise<DocumentDetail> {
  await ensureAuthenticatedSession();
  const db = getDb();
  const docSnap = await getDoc(doc(db, `documents/${documentId}`));
  if (!docSnap.exists()) {
    throwAuthAwareError("문서를 찾을 수 없습니다.");
  }
  const df = docSnap.data();

  // Resolve the latest version (denormalized pointer first, else newest by number).
  const latest = (df.latest ?? {}) as DocumentData;
  let versionId = latest.versionId as string | undefined;
  let versionData: DocumentData | null = null;
  if (versionId) {
    const vs = await getDoc(doc(db, `documents/${documentId}/versions/${versionId}`));
    versionData = vs.exists() ? vs.data() : null;
  }
  if (!versionData) {
    const vq = await getDocs(
      query(
        collection(db, `documents/${documentId}/versions`),
        orderBy("versionNumber", "desc"),
        fbLimit(1),
      ),
    );
    if (!vq.empty) {
      versionId = vq.docs[0].id;
      versionData = vq.docs[0].data();
    }
  }
  if (!versionData || !versionId) {
    throwAuthAwareError("문서 버전을 찾을 수 없습니다.");
  }

  const rawText = (versionData.rawText ?? "") as string;
  let sections = await fetchAllDocumentSections(documentId, versionId);
  const parseWarnings = asStringArray(versionData.parseWarnings);
  const isStructuredImportLocked = parseWarnings.includes(STRUCTURED_XLSX_IMPORT_WARNING);
  if (sections.length === 0 && rawText.trim() && !isStructuredImportLocked) {
    sections = rebuildMissingDocumentSections(rawText);
  }
  const metadata = deriveDocumentMetadata(rawText);

  return {
    id: documentId,
    version_id: versionId,
    title: df.title,
    description: df.description ?? null,
    document_type: df.documentType,
    version_number: versionData.versionNumber ?? 1,
    raw_text: rawText,
    sections: dedupeDocumentSectionRecords(sections),
    parse_warnings: filterDocumentParseWarnings(parseWarnings, metadata.title),
    metadata,
  };
}

async function fetchAllDocumentSections(
  documentId: string,
  versionId: string,
): Promise<DocumentDetail["sections"]> {
  const snap = await getDocs(
    query(
      collection(getDb(), `documents/${documentId}/versions/${versionId}/sections`),
      orderBy("hierarchyOrder", "asc"),
    ),
  );
  return snap.docs.map((entry) => mapSectionDoc(entry.id, entry.data()));
}

// In-memory reparse for display when a version has no persisted sections.
// (Persisting a rebuild is handled server-side by the reparse Worker function.)
function rebuildMissingDocumentSections(rawText: string): DocumentDetail["sections"] {
  const parseResult = parsePolicyText(rawText);
  const sections = dedupeParsedSections(parseResult.sections);
  const hierarchyColumnsById = buildSectionHierarchyColumns(sections);
  const records = sections.map((section) =>
    ({
      id: section.tempId,
      hierarchy_type: section.hierarchyType,
      hierarchy_label: section.hierarchyLabel,
      hierarchy_order: section.hierarchyOrder,
      original_text: section.originalText,
      path_display: section.path.join(" > "),
      ...hierarchyColumnsById.get(section.tempId),
    }) as DocumentDetail["sections"][number],
  );
  return records;
}

export async function saveStructuredSections(input: {
  documentId: string;
  versionId: string;
  rows: Array<{ content: string }>;
  metadata?: {
    title?: string | null;
    revisionDate?: string | null;
    documentNotes?: string[];
  };
}) {
  const session = await ensureAuthenticatedSession();
  const db = getDb();
  const rebuiltRawText = buildStructuredDocumentRawText({
    rows: input.rows,
    metadata: input.metadata,
  });

  const parseResult = parsePolicyText(rebuiltRawText);
  const sections = dedupeParsedSections(parseResult.sections);
  const hierarchyColumnsById = buildSectionHierarchyColumns(sections);
  const sectionsPath = `documents/${input.documentId}/versions/${input.versionId}/sections`;

  const sectionDocs = await Promise.all(
    sections.map(async (section) => ({
      id: section.tempId,
      data: {
        documentVersionId: input.versionId,
        ownerUserId: session.user.id,
        parentSectionId: section.parentTempId,
        hierarchyType: section.hierarchyType,
        hierarchyLabel: section.hierarchyLabel,
        hierarchyOrder: section.hierarchyOrder,
        normalizedText: section.normalizedText,
        originalText: section.originalText,
        textHash: await sha256Hex(section.normalizedText),
        pathDisplay: section.path.join(" > "),
        createdAt: new Date(),
        ...hierarchyColumnsById.get(section.tempId),
      },
    })),
  );

  // Replace the version's sections (delete existing, then write new) in batches.
  const existing = await getDocs(collection(db, sectionsPath));
  const deletions = existing.docs.map((entry) => ({ kind: "del" as const, id: entry.id }));
  const writes = sectionDocs.map((entry) => ({ kind: "set" as const, id: entry.id, data: entry.data }));
  const ops = [...deletions, ...writes];
  for (let i = 0; i < ops.length; i += 400) {
    const batch = writeBatch(db);
    for (const op of ops.slice(i, i + 400)) {
      const ref = doc(db, `${sectionsPath}/${op.id}`);
      if (op.kind === "del") batch.delete(ref);
      else batch.set(ref, op.data);
    }
    await batch.commit();
  }

  await updateDoc(doc(db, `documents/${input.documentId}/versions/${input.versionId}`), {
    rawText: rebuiltRawText,
    parseWarnings: parseResult.warnings,
    effectiveDate: deriveDocumentMetadata(rebuiltRawText).revisionDate ?? null,
  });
  await updateDoc(doc(db, `documents/${input.documentId}`), {
    "latest.sectionCount": sectionDocs.length,
  });

  return {
    status: "success",
    data: {
      documentId: input.documentId,
      versionId: input.versionId,
      sectionCount: sectionDocs.length,
      warningCount: parseResult.warnings.length,
      rawText: rebuiltRawText,
    },
  };
}

function buildStructuredDocumentRawText(input: {
  rows: Array<{ content: string }>;
  metadata?: {
    title?: string | null;
    revisionDate?: string | null;
    documentNotes?: string[];
  };
}) {
  const bodyLines = input.rows
    .map((row) => row.content.trim())
    .filter(Boolean);
  const notes = Array.isArray(input.metadata?.documentNotes)
    ? input.metadata?.documentNotes
        .map((note) => note.trim())
        .filter(Boolean)
    : [];
  const title = input.metadata?.title?.trim() || "";
  const revisionDate = normalizeRevisionDateValue(input.metadata?.revisionDate ?? null);
  const filteredNotes = notes.filter((note) => {
    if (!note) {
      return false;
    }

    if (title && note === title) {
      return false;
    }

    if (/^개정\s*[0-9]{4}\.[0-9]{1,2}\.[0-9]{1,2}\.?$/u.test(note)) {
      return false;
    }

    return true;
  });

  const headerLines = [
    title || null,
    revisionDate ? `개정 ${revisionDate}` : null,
    ...filteredNotes,
  ].filter((line): line is string => Boolean(line));

  return [...headerLines, ...bodyLines].join("\n");
}

export async function listComparisonRuns(): Promise<ComparisonRunSummary[]> {
  const session = await ensureAuthenticatedSession();
  const db = getDb();
  const runsSnap = await getDocs(
    query(collection(db, "comparisonRuns"), where("actorUserId", "==", session.user.id)),
  );

  const summaries = await Promise.all(
    runsSnap.docs.map(async (r) => {
      const rf = r.data();
      const [policy, law, resultsSnap, decision] = await Promise.all([
        resolveDocVersionMeta(rf.sourceDocumentVersionId as string),
        resolveLawVersionMeta(rf.targetLawVersionId as string),
        getDocs(collection(db, `comparisonRuns/${r.id}/results`)),
        latestRevisionDecision(r.id),
      ]);
      return {
        id: r.id,
        created_at: fsIso(rf.createdAt),
        document_id: policy.documentId,
        document_version_id: rf.sourceDocumentVersionId as string,
        law_version_id: rf.targetLawVersionId as string,
        policy_title: policy.title,
        policy_version_number: policy.versionNumber,
        law_title: law.title,
        law_version_label: law.versionLabel,
        law_effective_date: law.effectiveDate,
        diff_count: resultsSnap.size,
        revision_status: (decision?.status ?? null) as ComparisonRunSummary["revision_status"],
        revision_confidence: decision ? Number(decision.confidence) : null,
        revision_ai_used: decision ? Boolean(decision.aiUsed) : null,
        human_review_required: decision ? Boolean(decision.humanReviewRequired) : null,
      } satisfies ComparisonRunSummary;
    }),
  );

  return summaries.sort((a, b) => (b.created_at > a.created_at ? 1 : b.created_at < a.created_at ? -1 : 0));
}

export async function listLawVersions(): Promise<LawVersionSummary[]> {
  const session = await ensureAuthenticatedSession();
  const db = getDb();
  const lawSnap = await getDocs(
    query(collection(db, "lawSources"), where("ownerUserId", "==", session.user.id)),
  );
  const out: LawVersionSummary[] = [];
  for (const ls of lawSnap.docs) {
    const lf = ls.data();
    const versions = await getDocs(collection(db, `lawSources/${ls.id}/versions`));
    for (const v of versions.docs) {
      const vf = v.data();
      const sectionsSnap = await getDocs(
        collection(db, `lawSources/${ls.id}/versions/${v.id}/sections`),
      );
      out.push({
        id: v.id,
        law_source_id: ls.id,
        source_title: lf.sourceTitle ?? null,
        source_link: lf.sourceLink ?? "",
        version_label: vf.versionLabel ?? null,
        effective_date: fsIsoOrNull(vf.effectiveDate),
        created_at: fsIso(vf.createdAt),
        section_count: sectionsSnap.size,
      } as LawVersionSummary);
    }
  }
  return out.sort((a, b) => (b.created_at > a.created_at ? 1 : b.created_at < a.created_at ? -1 : 0));
}

export async function getLawDetail(
  lawVersionId: string,
): Promise<LawDetail> {
  const session = await ensureAuthenticatedSession();
  const db = getDb();
  const vq = await getDocs(
    query(collectionGroup(db, "versions"), where("id", "==", lawVersionId), fbLimit(1)),
  );
  if (vq.empty) {
    throwAuthAwareError("법령 버전을 찾을 수 없습니다.");
  }
  const vdoc = vq.docs[0];
  const vf = vdoc.data();
  const lawSourceRef = vdoc.ref.parent.parent;
  if (!lawSourceRef) {
    throwAuthAwareError("법령 출처를 찾을 수 없습니다.");
  }
  const lsSnap = await getDoc(lawSourceRef);
  const lf = lsSnap.exists() ? lsSnap.data() : {};
  if (lf.ownerUserId && lf.ownerUserId !== session.user.id) {
    throwAuthAwareError("법령 버전에 접근할 수 없습니다.");
  }

  const sectionsSnap = await getDocs(
    query(collection(db, `${vdoc.ref.path}/sections`), orderBy("hierarchyOrder", "asc")),
  );
  const sourceTitle = (lf.sourceTitle ?? null) as string | null;

  return {
    id: vdoc.id,
    source_title: sourceTitle,
    source_link: (lf.sourceLink ?? "") as string,
    version_label: vf.versionLabel ?? null,
    effective_date: fsIsoOrNull(vf.effectiveDate),
    raw_text: (vf.rawText ?? "") as string,
    parse_warnings: filterLawParseWarnings(asStringArray(vf.parseWarnings), sourceTitle),
    sections: sectionsSnap.docs.map((entry) => {
      const f = entry.data();
      return {
        id: entry.id,
        hierarchy_type: f.hierarchyType,
        hierarchy_label: f.hierarchyLabel ?? "",
        hierarchy_order: f.hierarchyOrder ?? 0,
        original_text: f.originalText ?? "",
        path_display: f.pathDisplay ?? "",
      };
    }) as LawDetail["sections"],
  };
}

export async function registerLawSource(input: {
  sourceLink: string;
  sourceTitle?: string;
  versionLabel?: string;
  effectiveDate?: string;
}) {
  const session = await ensureAuthenticatedSession();
  const currentUser = await ensureAuthenticatedUser(session.access_token);
  return await invokeEdgeFunction("register-law-source", input, {
    stage: "register-law-source",
    session,
    userId: currentUser.id,
  });
}

export async function uploadLawDocument(input: {
  file: File;
  sourceTitle?: string;
  versionLabel?: string;
  effectiveDate?: string;
}) {
  const session = await ensureAuthenticatedSession();
  const currentUser = await ensureAuthenticatedUser(session.access_token);
  const fileContentBase64 = await encodeFileAsBase64(input.file);
  const rawText = isLegacyWordDocument(input.file.name)
    ? ""
    : await extractDocumentText(input.file);
  return await invokeEdgeFunction(
    "register-law-source",
    {
      sourceType: "file",
      sourceTitle: input.sourceTitle,
      versionLabel: input.versionLabel,
      effectiveDate: input.effectiveDate,
      originalFileName: input.file.name,
      fileContentBase64,
      contentType: input.file.type || guessContentType(input.file.name),
      rawText,
    },
    {
      stage: "upload-law-document",
      fileName: input.file.name,
      session,
      userId: currentUser.id,
    },
  );
}

export async function updateLawSource(input: {
  lawVersionId: string;
  sourceLink: string;
  sourceTitle?: string;
  versionLabel?: string;
  effectiveDate?: string;
}) {
  const session = await ensureAuthenticatedSession();
  const currentUser = await ensureAuthenticatedUser(session.access_token);
  return await invokeEdgeFunction(
    "manage-law-source",
    {
      action: "update",
      ...input,
    },
    {
      stage: "update-law-source",
      session,
      userId: currentUser.id,
    },
  );
}

export async function deleteLawSource(input: { lawVersionId: string }) {
  const session = await ensureAuthenticatedSession();
  const currentUser = await ensureAuthenticatedUser(session.access_token);
  return await invokeEdgeFunction(
    "manage-law-source",
    {
      action: "delete",
      ...input,
    },
    {
      stage: "delete-law-source",
      session,
      userId: currentUser.id,
    },
  );
}

export async function reparseLawSource(input: { lawVersionId: string }) {
  const session = await ensureAuthenticatedSession();
  const currentUser = await ensureAuthenticatedUser(session.access_token);
  return await invokeEdgeFunction(
    "manage-law-source",
    {
      action: "reparse",
      ...input,
    },
    {
      stage: "reparse-law-source",
      session,
      userId: currentUser.id,
    },
  );
}

export async function runComparison(input: {
  documentVersionId: string;
  lawVersionId: string;
}) {
  const session = await ensureAuthenticatedSession();
  const currentUser = await ensureAuthenticatedUser(session.access_token);
  return await invokeEdgeFunction("run-comparison", input, {
    stage: "run-comparison",
    session,
    userId: currentUser.id,
  });
}

export async function runBulkComparison(input: {
  lawVersionId: string;
}) {
  const session = await ensureAuthenticatedSession();
  const currentUser = await ensureAuthenticatedUser(session.access_token);
  return await invokeEdgeFunction("run-bulk-comparison", input, {
    stage: "run-bulk-comparison",
    session,
    userId: currentUser.id,
  });
}

async function buildComparisonReviewDetail(comparisonRunId: string): Promise<ComparisonReviewDetail> {
  const db = getDb();
  const runSnap = await getDoc(doc(db, `comparisonRuns/${comparisonRunId}`));
  if (!runSnap.exists()) {
    throwAuthAwareError("비교 결과를 찾을 수 없습니다.");
  }
  const rf = runSnap.data();
  const [policy, law, resultsSnap, decision] = await Promise.all([
    resolveDocVersionMeta(rf.sourceDocumentVersionId as string),
    resolveLawVersionMeta(rf.targetLawVersionId as string),
    getDocs(
      query(collection(db, `comparisonRuns/${comparisonRunId}/results`), orderBy("affectedPath", "asc")),
    ),
    latestRevisionDecision(comparisonRunId),
  ]);

  return {
    id: comparisonRunId,
    created_at: fsIso(rf.createdAt),
    warning_messages: asStringArray(rf.warningMessages),
    policy_title: policy.title,
    policy_version_number: policy.versionNumber,
    policy_raw_text: policy.rawText,
    law_title: law.title,
    law_version_label: law.versionLabel,
    law_effective_date: law.effectiveDate,
    law_raw_text: law.rawText,
    revision_decision_id: (decision?.id ?? null) as string | null,
    revision_status: (decision?.status ?? null) as ComparisonReviewDetail["revision_status"],
    revision_rationale: (decision?.rationale ?? null) as string | null,
    revision_confidence: decision ? Number(decision.confidence) : null,
    revision_ai_used: decision ? Boolean(decision.aiUsed) : null,
    human_review_required: decision ? Boolean(decision.humanReviewRequired) : null,
    results: resultsSnap.docs.map((entry) => mapComparisonResultDoc(entry.id, entry.data())),
  };
}

export async function getComparisonReview(
  comparisonRunId: string,
): Promise<ComparisonReviewDetail> {
  await ensureAuthenticatedSession();
  return buildComparisonReviewDetail(comparisonRunId);
}

export async function getAggregatedComparisonReview(
  comparisonRunIds: string[],
): Promise<ComparisonReviewAggregate> {
  await ensureAuthenticatedSession();
  const details = await Promise.all(
    comparisonRunIds.map((runId) => buildComparisonReviewDetail(runId)),
  );

  const results: AggregatedComparisonResultRecord[] = details.flatMap((detail) =>
    detail.results.map((row) => ({
      ...row,
      comparison_run_id: detail.id,
      policy_title: detail.policy_title,
      law_title: detail.law_title,
    })),
  );

  return {
    run_ids: comparisonRunIds,
    warning_messages: [...new Set(details.flatMap((detail) => detail.warning_messages))],
    policy_titles: [...new Set(details.map((detail) => detail.policy_title))],
    law_titles: [...new Set(details.map((detail) => detail.law_title))],
    revision_statuses: details
      .map((detail) => detail.revision_status)
      .filter((status): status is NonNullable<typeof status> => Boolean(status)),
    results,
  };
}

export async function classifyRevision(
  comparisonRunId: string,
  openAiSettings?: Partial<OpenAiSettings>,
) {
  const session = await ensureAuthenticatedSession();
  const currentUser = await ensureAuthenticatedUser(session.access_token);
  return await invokeEdgeFunction(
    "classify-revision",
    {
      comparisonRunId,
      openAiApiKey: normalizeOptionalString(openAiSettings?.apiKey),
      openAiModel: normalizeOptionalString(openAiSettings?.model),
    },
    {
      stage: "classify-revision",
      session,
      userId: currentUser.id,
    },
  );
}

export async function analyzeSelectedRevisions(input: {
  targetDocumentIds: string[];
  referenceDocumentIds: string[];
  lawVersionIds: string[];
}): Promise<AiRevisionGuidance> {
  const session = await ensureAuthenticatedSession();
  const currentUser = await ensureAuthenticatedUser(session.access_token);
  const payload = await invokeEdgeFunction("analyze-selected-revisions", input, {
    stage: "analyze-selected-revisions",
    session,
    userId: currentUser.id,
  });
  return normalizeAiRevisionGuidance(payload.data);
}

export async function analyzeSelectedRevisionsStage(input: {
  stage: AiRevisionAnalysisStage;
  targetDocumentIds: string[];
  referenceDocumentIds: string[];
  lawVersionIds: string[];
  leftGroupReport?: unknown;
  rightGroupReport?: unknown;
  promptOverrides?: Partial<Record<keyof AiRevisionPromptOverrides, string | PromptSlotList>>;
  openAiSettings?: Partial<OpenAiSettings>;
}): Promise<AiRevisionStageResult> {
  const session = await ensureAuthenticatedSession();
  const currentUser = await ensureAuthenticatedUser(session.access_token);
  const payload = await invokeEdgeFunction("analyze-selected-revisions", {
    ...input,
    openAiApiKey: normalizeOptionalString(input.openAiSettings?.apiKey),
    openAiModel: normalizeOptionalString(input.openAiSettings?.model),
  }, {
    stage: `analyze-selected-revisions-${input.stage}`,
    session,
    userId: currentUser.id,
  });

  return normalizeAiRevisionStageResult(payload.data);
}

function normalizeAiRevisionGuidance(input: unknown): AiRevisionGuidance {
  const source = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const normalizeStringArray = (value: unknown) =>
    Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string")
      : [];
  const normalizeGroupReport = (value: unknown) => {
    const group = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
    return {
      summary: typeof group.summary === "string" ? group.summary : "리포트 요약이 없습니다.",
      key_findings: normalizeStringArray(group.key_findings),
      documents: Array.isArray(group.documents)
        ? group.documents.map((entry) => {
            const item = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
            return {
              document_id: typeof item.document_id === "string" ? item.document_id : "",
              document_title:
                typeof item.document_title === "string" ? item.document_title : "문서",
              key_points: normalizeStringArray(item.key_points),
              source_paths: normalizeStringArray(item.source_paths),
            };
          })
        : [],
      merged_requirements: Array.isArray(group.merged_requirements)
        ? group.merged_requirements.map((entry) => {
            const item = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
            return {
              topic: typeof item.topic === "string" ? item.topic : "항목",
              detail: typeof item.detail === "string" ? item.detail : "",
              source_titles: normalizeStringArray(item.source_titles),
              source_paths: normalizeStringArray(item.source_paths),
              notes: typeof item.notes === "string" ? item.notes : "",
            };
          })
        : [],
    };
  };
  const normalizeComparisonReport = (value: unknown) => {
    const report = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
    return {
      summary: typeof report.summary === "string" ? report.summary : "비교 결과 요약이 없습니다.",
      revision_needed:
        typeof report.revision_needed === "boolean" ? report.revision_needed : false,
      overall_comment:
        typeof report.overall_comment === "string"
          ? report.overall_comment
          : "종합 의견이 없습니다.",
      gaps: Array.isArray(report.gaps)
        ? report.gaps.map((entry) => {
            const item = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
            return {
              topic: typeof item.topic === "string" ? item.topic : "항목",
              gap_type: typeof item.gap_type === "string" ? item.gap_type : "missing",
              priority: typeof item.priority === "string" ? item.priority : "중",
              right_requirement:
                typeof item.right_requirement === "string" ? item.right_requirement : "",
              left_current_state:
                typeof item.left_current_state === "string" ? item.left_current_state : "",
              risk: typeof item.risk === "string" ? item.risk : "",
              target_document_id:
                typeof item.target_document_id === "string" ? item.target_document_id : "",
              target_document_title:
                typeof item.target_document_title === "string"
                  ? item.target_document_title
                  : "정책/지침",
              target_section_path:
                typeof item.target_section_path === "string" ? item.target_section_path : "미지정",
              target_section_reason:
                typeof item.target_section_reason === "string" ? item.target_section_reason : "",
              recommended_revision:
                typeof item.recommended_revision === "string"
                  ? item.recommended_revision
                  : "",
              revision_instruction:
                typeof item.revision_instruction === "string" ? item.revision_instruction : "",
              revision_example:
                typeof item.revision_example === "string" ? item.revision_example : "",
              policy_evidence_paths: normalizeStringArray(item.policy_evidence_paths),
              comparison_source_title:
                typeof item.comparison_source_title === "string"
                  ? item.comparison_source_title
                  : "기준 문서",
              comparison_evidence_paths: normalizeStringArray(item.comparison_evidence_paths),
              confidence: typeof item.confidence === "number" ? item.confidence : 0,
            };
          })
        : [],
      well_covered_items: Array.isArray(report.well_covered_items)
        ? report.well_covered_items.map((entry) => {
            const item = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
            return {
              topic: typeof item.topic === "string" ? item.topic : "항목",
              reason: typeof item.reason === "string" ? item.reason : "",
              policy_evidence_paths: normalizeStringArray(item.policy_evidence_paths),
              comparison_evidence_paths: normalizeStringArray(item.comparison_evidence_paths),
            };
          })
        : [],
      document_actions: Array.isArray(report.document_actions)
        ? report.document_actions.map((entry) => {
            const item = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
            return {
              document_id: typeof item.document_id === "string" ? item.document_id : "",
              document_title:
                typeof item.document_title === "string" ? item.document_title : "정책/지침",
              actions: Array.isArray(item.actions)
                ? item.actions.map((actionEntry) => {
                    const action =
                      actionEntry && typeof actionEntry === "object"
                        ? (actionEntry as Record<string, unknown>)
                        : {};
                    return {
                      priority: typeof action.priority === "string" ? action.priority : "중",
                      target_section_path:
                        typeof action.target_section_path === "string"
                          ? action.target_section_path
                          : "미지정",
                      current_issue:
                        typeof action.current_issue === "string" ? action.current_issue : "",
                      action: typeof action.action === "string" ? action.action : "수정",
                      required_change:
                        typeof action.required_change === "string" ? action.required_change : "",
                      instruction:
                        typeof action.instruction === "string" ? action.instruction : "",
                      draft_revision_text:
                        typeof action.draft_revision_text === "string"
                          ? action.draft_revision_text
                          : "",
                      rationale: typeof action.rationale === "string" ? action.rationale : "",
                    };
                  })
                : [],
            };
          })
        : [],
      low_confidence_notes: normalizeStringArray(report.low_confidence_notes),
      remaining_watchpoints: normalizeStringArray(report.remaining_watchpoints),
    };
  };

  return {
    left_group_report: normalizeGroupReport(source.left_group_report),
    right_group_report: normalizeGroupReport(source.right_group_report),
    comparison_report: normalizeComparisonReport(source.comparison_report),
    model: typeof source.model === "string" ? source.model : null,
    api_call_count: typeof source.api_call_count === "number" ? source.api_call_count : 0,
  };
}

function normalizeAiRevisionStageResult(input: unknown): AiRevisionStageResult {
  const source = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const normalized = normalizeAiRevisionGuidance(source);
  const stage =
    source.stage === "left" || source.stage === "right" || source.stage === "final"
      ? source.stage
      : "left";

  return {
    stage,
    left_group_report: source.left_group_report ? normalized.left_group_report : null,
    right_group_report: source.right_group_report ? normalized.right_group_report : null,
    comparison_report: source.comparison_report ? normalized.comparison_report : null,
    model: normalized.model,
    api_call_count: normalized.api_call_count,
  };
}

function normalizeAiReportHistoryRow(row: AiReportHistoryRow): AiReportHistoryEntry | null {
  const summary = normalizeAiReportHistorySummaryRow(row);
  if (!summary) {
    return null;
  }

  const guidance = normalizeAiRevisionGuidance(row.guidance);
  if (!guidance) {
    return null;
  }

  return {
    ...summary,
    guidance,
  };
}

function normalizeAiReportHistorySummaryRow(row: AiReportHistoryRow): AiReportHistorySummary | null {
  const selectionCounts = normalizeAnalysisSelectionCounts(row.selection_counts);

  if (!selectionCounts) {
    return null;
  }

  return {
    id: row.id,
    createdAt: row.created_at,
    title: row.title,
    selectionSummary: row.selection_summary,
    selectionCounts,
  };
}

function normalizeAnalysisSelectionCounts(value: unknown): AiReportHistoryEntry["selectionCounts"] | null {
  const source = (value && typeof value === "object" ? value : null) as Record<string, unknown> | null;
  if (!source) {
    return null;
  }

  return {
    leftDocumentCount: typeof source.leftDocumentCount === "number" ? source.leftDocumentCount : 0,
    rightDocumentCount: typeof source.rightDocumentCount === "number" ? source.rightDocumentCount : 0,
    rightLawCount: typeof source.rightLawCount === "number" ? source.rightLawCount : 0,
  };
}

async function ensureAuthenticatedSession(): Promise<AppAuthSession> {
  const session = await getCurrentAppSession();
  if (!session || !session.user.id) {
    throw new Error(buildAuthDebugMessage("로그인이 필요합니다.", null));
  }
  return session;
}

interface DecodedUser {
  id: string;
  email: string | null;
}

// Decode the Firebase ID token payload client-side (no network). The Worker and
// Firestore Security Rules are the real verifiers; we only need uid/email here.
async function ensureAuthenticatedUser(accessToken: string): Promise<DecodedUser> {
  try {
    const payloadSegment = accessToken.split(".")[1];
    const base64 = payloadSegment.replace(/-/g, "+").replace(/_/g, "/");
    const json = decodeURIComponent(
      atob(base64)
        .split("")
        .map((c) => `%${("00" + c.charCodeAt(0).toString(16)).slice(-2)}`)
        .join(""),
    );
    const claims = JSON.parse(json) as { sub?: string; user_id?: string; email?: string };
    const id = String(claims.sub ?? claims.user_id ?? "");
    if (!id) {
      throw new Error("missing subject");
    }
    return { id, email: typeof claims.email === "string" ? claims.email : null };
  } catch {
    throw new Error(buildAuthDebugMessage("사용자 검증 실패", null));
  }
}

async function invokeEdgeFunction<TBody extends Record<string, unknown>>(
  functionName: string,
  body: TBody,
  _contextInfo?: unknown,
) {
  // Routed to the Cloudflare Worker (workers/src/index.ts), which verifies the
  // Firebase ID token and runs the migrated function logic.
  return workerApi.invokeFunction<Record<string, unknown>>(functionName, body);
}

// ---- Firestore read helpers (camelCase docs → snake_case return shapes) ----

/** Firestore Timestamp | ISO string | null → ISO string ("" when absent). */
function fsIso(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (
    typeof value === "object" &&
    value !== null &&
    "toDate" in value &&
    typeof (value as { toDate: () => Date }).toDate === "function"
  ) {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  return String(value);
}

function fsIsoOrNull(value: unknown): string | null {
  const iso = fsIso(value);
  return iso || null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function mapComparisonResultDoc(id: string, f: DocumentData): ComparisonResultRecord {
  return {
    id,
    affected_path: (f.affectedPath ?? "") as string,
    hierarchy_type: f.hierarchyType,
    match_type: (f.matchType ?? "") as string,
    diff_type: f.diffType,
    confidence: Number(f.confidence ?? 0),
    before_text: (f.beforeText ?? "") as string,
    after_text: (f.afterText ?? "") as string,
    explanation: (f.explanation ?? "") as string,
    reasoning_trace: asStringArray(f.reasoningTrace),
    ai_used: Boolean(f.aiUsed),
  };
}

// Resolve a document version's parent document title/number/text (replaces the
// SQL join in the comparison_review views). versionId is the self `id` field.
async function resolveDocVersionMeta(versionId: string) {
  const db = getDb();
  const vq = await getDocs(
    query(collectionGroup(db, "versions"), where("id", "==", versionId), fbLimit(1)),
  );
  if (vq.empty) {
    return { title: "정책 문서", versionNumber: 1, rawText: "", documentId: undefined as string | undefined };
  }
  const vdoc = vq.docs[0];
  const vf = vdoc.data();
  const docRef = vdoc.ref.parent.parent;
  const dSnap = docRef ? await getDoc(docRef) : null;
  const dfx = dSnap && dSnap.exists() ? dSnap.data() : {};
  return {
    title: (dfx.title ?? "정책 문서") as string,
    versionNumber: (vf.versionNumber ?? 1) as number,
    rawText: (vf.rawText ?? "") as string,
    documentId: docRef?.id,
  };
}

async function resolveLawVersionMeta(versionId: string) {
  const db = getDb();
  const vq = await getDocs(
    query(collectionGroup(db, "versions"), where("id", "==", versionId), fbLimit(1)),
  );
  if (vq.empty) {
    return { title: "법령 문서", versionLabel: null as string | null, effectiveDate: null as string | null, rawText: "" };
  }
  const vdoc = vq.docs[0];
  const vf = vdoc.data();
  const lsRef = vdoc.ref.parent.parent;
  const lsSnap = lsRef ? await getDoc(lsRef) : null;
  const lf = lsSnap && lsSnap.exists() ? lsSnap.data() : {};
  return {
    title: (lf.sourceTitle ?? "법령 문서") as string,
    versionLabel: (vf.versionLabel ?? null) as string | null,
    effectiveDate: fsIsoOrNull(vf.effectiveDate),
    rawText: (vf.rawText ?? "") as string,
  };
}

async function latestRevisionDecision(runId: string): Promise<DocumentData | null> {
  const snap = await getDocs(
    query(
      collection(getDb(), `comparisonRuns/${runId}/decisions`),
      orderBy("createdAt", "desc"),
      fbLimit(1),
    ),
  );
  return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
}

/** Map a Firestore section document (camelCase) to the snake_case detail shape. */
function mapSectionDoc(id: string, f: DocumentData): DocumentDetail["sections"][number] {
  return {
    id,
    hierarchy_type: f.hierarchyType,
    hierarchy_label: f.hierarchyLabel ?? "",
    hierarchy_order: f.hierarchyOrder ?? 0,
    original_text: f.originalText ?? "",
    path_display: f.pathDisplay ?? "",
    chapter_label: f.chapter_label ?? f.chapterLabel ?? null,
    chapter_text: f.chapter_text ?? f.chapterText ?? null,
    article_label: f.article_label ?? f.articleLabel ?? null,
    article_text: f.article_text ?? f.articleText ?? null,
    paragraph_label: f.paragraph_label ?? f.paragraphLabel ?? null,
    paragraph_text: f.paragraph_text ?? f.paragraphText ?? null,
    item_label: f.item_label ?? f.itemLabel ?? null,
    item_text: f.item_text ?? f.itemText ?? null,
    sub_item_label: f.sub_item_label ?? f.subItemLabel ?? null,
    sub_item_text: f.sub_item_text ?? f.subItemText ?? null,
  } as DocumentDetail["sections"][number];
}

function normalizeOptionalString(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

async function encodeFileAsBase64(file: File) {
  const buffer = await file.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);

  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }

  return btoa(binary);
}

function decodeBase64ToBytes(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

async function sha256Hex(value: string) {
  const encoded = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest))
    .map((item) => item.toString(16).padStart(2, "0"))
    .join("");
}

function dedupeParsedSections(sections: ParsedSection[]) {
  const keptIdByKey = new Map<string, string>();
  const replacementIdBySkippedId = new Map<string, string>();
  const result: ParsedSection[] = [];

  for (const section of sections) {
    const key = buildSectionDedupeKey({
      hierarchyType: section.hierarchyType,
      hierarchyLabel: section.hierarchyLabel,
      pathDisplay: section.path.join(" > "),
      originalText: section.originalText,
    });

    const keptId = keptIdByKey.get(key);
    if (keptId) {
      replacementIdBySkippedId.set(section.tempId, keptId);
      continue;
    }

    keptIdByKey.set(key, section.tempId);
    result.push(section);
  }

  return result.map((section) => ({
    ...section,
    parentTempId: section.parentTempId
      ? resolveReplacementSectionId(section.parentTempId, replacementIdBySkippedId)
      : null,
  }));
}

function resolveReplacementSectionId(
  sectionId: string,
  replacementIdBySkippedId: Map<string, string>,
) {
  let current = sectionId;
  const visited = new Set<string>();

  while (replacementIdBySkippedId.has(current) && !visited.has(current)) {
    visited.add(current);
    current = replacementIdBySkippedId.get(current) ?? current;
  }

  return current;
}

function dedupeDocumentSectionRecords(
  sections: DocumentDetail["sections"],
) {
  const seen = new Set<string>();
  const result: DocumentDetail["sections"] = [];

  for (const section of sections) {
    const key = buildSectionDedupeKey({
      hierarchyType: section.hierarchy_type,
      hierarchyLabel: section.hierarchy_label,
      pathDisplay: section.path_display,
      originalText: section.original_text,
    });

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(section);
  }

  return result;
}

function buildSectionDedupeKey(input: {
  hierarchyType: string;
  hierarchyLabel: string;
  pathDisplay: string;
  originalText: string;
}) {
  return [
    input.hierarchyType,
    normalizeTextForDedupe(input.hierarchyLabel),
    normalizeTextForDedupe(input.pathDisplay),
    normalizeTextForDedupe(input.originalText),
  ].join("|");
}

function normalizeTextForDedupe(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}

function guessContentType(fileName: string) {
  if (fileName.toLowerCase().endsWith(".doc")) {
    return "application/msword";
  }

  if (fileName.toLowerCase().endsWith(".md")) {
    return "text/markdown";
  }

  if (fileName.toLowerCase().endsWith(".docx")) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }

  return "text/plain";
}

function inferClientDocumentType(input: {
  inputTitle: string;
  parsedTitle: string | null;
  rawText: string;
}) {
  const candidate = [
    input.inputTitle,
    input.parsedTitle ?? "",
    input.rawText.slice(0, 400),
  ]
    .join(" ")
    .toLowerCase();

  if (candidate.includes("지침") || candidate.includes("guideline")) {
    return "GUIDELINE" as const;
  }

  return "POLICY" as const;
}

function buildClientStoragePath(userId: string, originalFileName: string) {
  const extensionMatch = originalFileName.match(/(\.[a-z0-9]+)$/iu);
  const extension = extensionMatch?.[1].toLowerCase() ?? "";
  const baseName = extension
    ? originalFileName.slice(0, -extension.length)
    : originalFileName;
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

function buildAuthDebugMessage(message?: string, session?: { expires_at?: number } | null) {
  const normalizedMessage = message?.toLowerCase().includes("jwt")
    ? "Invalid JWT"
    : message ?? "로그인이 필요합니다.";
  const expiresAt = session?.expires_at
    ? new Date(session.expires_at * 1000).toISOString()
    : "없음";

  return `인증 단계 실패\n원인: ${normalizedMessage}\n세션 만료 시각: ${expiresAt}`;
}

function filterLawParseWarnings(warnings: string[], sourceTitle: string | null) {
  return warnings.filter((warning) => !isIgnorableLawTitleWarning(warning, sourceTitle));
}

function filterDocumentParseWarnings(warnings: string[], documentTitle: string | null) {
  return [...new Set(warnings)].filter(
    (warning) => !isIgnorableDocumentTopLevelWarning(warning, documentTitle),
  );
}

function isIgnorableLawTitleWarning(warning: string, sourceTitle: string | null) {
  const match = warning.match(/^Unmatched top-level text preserved as document-level content: "(.+)"$/u);
  if (!match) {
    return false;
  }

  const preservedText = normalizeWarningText(match[1]);
  const normalizedSourceTitle = normalizeWarningText(sourceTitle ?? "");

  if (normalizedSourceTitle && preservedText === normalizedSourceTitle) {
    return true;
  }

  return /(?:법률|시행령|시행규칙|규정|지침|기준|고시|훈령|예규|조례|규칙)$/u.test(preservedText);
}

function isIgnorableDocumentTopLevelWarning(warning: string, documentTitle: string | null) {
  const match = warning.match(/^Unmatched top-level text preserved as document-level content: "(.+)"$/u);
  if (!match) {
    return false;
  }

  const preservedText = normalizeWarningText(match[1]);
  const normalizedTitle = normalizeWarningText(documentTitle ?? "");
  const compactPreservedText = compactKoreanHeadingText(preservedText);
  const compactTitle = compactKoreanHeadingText(normalizedTitle);

  if (
    (normalizedTitle && preservedText === normalizedTitle) ||
    (compactTitle && compactPreservedText === compactTitle)
  ) {
    return true;
  }

  if (/^(?:개정|제정|시행)\s*[0-9]{4}(?:\.[0-9]{1,2}){1,2}\.?$/u.test(preservedText)) {
    return true;
  }

  if (/^(?:부칙|목적|적용범위|시행일)$/u.test(preservedText)) {
    return true;
  }

  if (/^(?:[0-9]+[.)]?|[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]|[가-힣A-Za-z]\.)$/u.test(preservedText)) {
    return true;
  }

  return /(?:정책|지침|규정|기준|매뉴얼|계획|법률|시행령|시행규칙)$/u.test(preservedText);
}

function normalizeWarningText(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}

function compactKoreanHeadingText(value: string) {
  return value.replace(/\s+/gu, "");
}


function deriveDocumentMetadata(rawText: string) {
  const lines = rawText
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);

  let title: string | null = null;
  let revisionDate: string | null = null;
  const documentNotes: string[] = [];

  for (const line of lines) {
    const normalized = line.replace(/\s+/g, " ").trim();

    if (!title && /정\s*보\s*보\s*안\s*정\s*책/u.test(normalized)) {
      title = "정보보안 정책";
      documentNotes.push(line);
      continue;
    }

    if (!title && normalized.length <= 80) {
      title = normalized;
      documentNotes.push(line);
      continue;
    }

    const revisionMatch = normalized.match(/^(?:개정|시행일?)\s*[:：]?\s*([0-9]{4}\.[0-9]{1,2}\.[0-9]{1,2}\.?)$/u);
    if (!revisionDate && revisionMatch) {
      revisionDate = revisionMatch[1].replace(/\.$/u, "");
      documentNotes.push(line);
    }
  }

  return {
    title,
    revisionDate,
    documentNotes,
  };
}

function normalizeRevisionDateValue(value: string | null) {
  if (!value) {
    return null;
  }

  const trimmed = value.trim().replace(/^개정\s*/u, "").replace(/\.$/u, "");
  return trimmed || null;
}

function throwAuthAwareError(message?: string): never {
  throw new Error(message ?? "요청 처리 중 오류가 발생했습니다.");
}

async function extractDocumentText(file: File) {
  if (/\.(txt|md)$/iu.test(file.name)) {
    return decodePlainTextBuffer(await file.arrayBuffer());
  }

  if (/\.(docx)$/iu.test(file.name)) {
    const arrayBuffer = await file.arrayBuffer();
    const extraction = await mammoth.extractRawText({ arrayBuffer });
    const extractedText = extraction.value.trim();

    if (!extractedText) {
      throw new Error("Word 문서에서 텍스트를 추출하지 못했습니다.");
    }

    return extractedText;
  }

  throw new Error("지원하지 않는 문서 형식입니다.");
}

export function decodePlainTextBuffer(buffer: ArrayBuffer) {
  const candidates = [
    decodeTextCandidate(buffer, "utf-8"),
    decodeTextCandidate(buffer, "euc-kr"),
  ].filter((candidate): candidate is { encoding: string; text: string; score: number } => candidate !== null);

  if (candidates.length === 0) {
    return new TextDecoder().decode(buffer);
  }

  return candidates.sort((left, right) => left.score - right.score)[0].text.trim();
}

function decodeTextCandidate(buffer: ArrayBuffer, encoding: string) {
  try {
    const text = new TextDecoder(encoding).decode(buffer);
    return {
      encoding,
      text,
      score: scoreDecodedText(text),
    };
  } catch {
    return null;
  }
}

function scoreDecodedText(text: string) {
  const replacementCount = countMatches(text, /\uFFFD/gu);
  const hangulCount = countMatches(text, /[가-힣]/gu);

  return replacementCount * 1000 - hangulCount;
}

function countMatches(value: string, pattern: RegExp) {
  return Array.from(value.matchAll(pattern)).length;
}

function isLegacyWordDocument(fileName: string) {
  return /\.(doc)$/iu.test(fileName);
}

function normalizeWorkspaceSelectionSnapshot(selection: WorkspaceSelectionSnapshot): WorkspaceSelectionSnapshot {
  return {
    selectedDocumentId: selection.selectedDocumentId,
    targetDocumentIds: Array.from(new Set(selection.targetDocumentIds)),
    referenceDocumentIds: Array.from(new Set(selection.referenceDocumentIds)),
    lawVersionIds: Array.from(new Set(selection.lawVersionIds)),
  };
}
