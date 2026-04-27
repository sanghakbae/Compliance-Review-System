import mammoth from "mammoth";
import {
  clearSupabaseAuthStorage,
  getSupabaseClient,
  normalizeSupabaseAuthError,
} from "./supabaseClient";
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
    const session = await ensureAuthenticatedSession();
    const currentUser = await ensureAuthenticatedUser(session.access_token);
    const fileContentBase64 = await encodeFileAsBase64(input.file);
    const fileText = await extractDocumentText(input.file);
    const supabase = getSupabaseClient();
    const storagePath = buildClientStoragePath(currentUser.id, input.file.name);
    const fileBytes = decodeBase64ToBytes(fileContentBase64);
    const { error: uploadError } = await supabase.storage
      .from("source-documents")
      .upload(storagePath, fileBytes, {
        upsert: false,
        contentType: input.file.type || guessContentType(input.file.name),
      });

    if (uploadError) {
      throw new Error(buildAuthDebugMessage(`document upload failed: ${uploadError.message}`, session));
    }

    const parseResult = parsePolicyText(fileText);
    const inferredDocumentType = inferClientDocumentType({
      inputTitle: input.title,
      parsedTitle: parseResult.metadata.title,
      rawText: fileText,
    });

    const { data: document, error: documentError } = await supabase
      .from("policy_documents")
      .insert({
        owner_user_id: currentUser.id,
        title: input.title,
        description: input.description || null,
        document_type: inferredDocumentType,
        source_storage_path: storagePath,
        source_file_name: input.file.name,
      })
      .select("id")
      .single();

    if (documentError || !document) {
      throw new Error(buildAuthDebugMessage(`document insert failed: ${documentError?.message ?? "unknown"}`, session));
    }

    const { data: version, error: versionError } = await supabase
      .from("policy_document_versions")
      .insert({
        document_id: document.id,
        version_number: 1,
        raw_text: fileText,
        parse_warnings: parseResult.warnings,
        effective_date: deriveDocumentMetadata(fileText).revisionDate,
      })
      .select("id")
      .single();

    if (versionError || !version) {
      throw new Error(buildAuthDebugMessage(`document version insert failed: ${versionError?.message ?? "unknown"}`, session));
    }

    const sections = dedupeParsedSections(parseResult.sections);
    const hierarchyColumnsById = buildSectionHierarchyColumns(sections);
    const rows = await Promise.all(sections.map(async (section) => ({
      id: section.tempId,
      document_version_id: version.id,
      parent_section_id: section.parentTempId,
      hierarchy_type: section.hierarchyType,
      hierarchy_label: section.hierarchyLabel,
      hierarchy_order: section.hierarchyOrder,
      normalized_text: section.normalizedText,
      original_text: section.originalText,
      text_hash: await sha256Hex(section.normalizedText),
      path_display: section.path.join(" > "),
      ...hierarchyColumnsById.get(section.tempId),
    })));
    if (rows.length === 0 && fileText.trim()) {
      rows.push(await buildFallbackDocumentSectionRow(version.id, fileText));
    }

    if (rows.length > 0) {
      const { error: sectionError } = await supabase
        .from("policy_document_sections")
        .insert(rows);

      if (sectionError) {
        throw new Error(buildAuthDebugMessage(`document section insert failed: ${sectionError.message}`, session));
      }
    }

    const supersededDocumentCount = await deleteSupersededDocumentsByTitle({
      currentDocumentId: document.id,
      ownerUserId: currentUser.id,
      title: input.title,
      session,
    });

    await supabase.from("policy_audit_logs").insert({
      actor_user_id: currentUser.id,
      action: "DOCUMENT_REGISTERED",
      target_document_id: document.id,
      result: "SUCCESS",
      metadata: {
        versionId: version.id,
        sectionCount: rows.length,
        warningCount: parseResult.warnings.length,
        supersededDocumentCount,
      },
    });

    return {
      status: "success",
      data: {
        documentId: document.id,
        versionId: version.id,
        sectionCount: rows.length,
        warnings: parseResult.warnings,
        supersededDocumentCount,
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
  const session = await ensureAuthenticatedSession();
  const currentUser = await ensureAuthenticatedUser(session.access_token);
  const supabase = getSupabaseClient();
  const storagePath = buildClientStoragePath(currentUser.id, input.sourceFileName);
  const fileBytes = new TextEncoder().encode(input.rawText);
  const { error: uploadError } = await supabase.storage
    .from("source-documents")
    .upload(storagePath, fileBytes, {
      upsert: false,
      contentType: "text/plain",
    });

  if (uploadError) {
    throw new Error(buildAuthDebugMessage(`document import storage failed: ${uploadError.message}`, session));
  }

  const parseResult = parsePolicyText(input.rawText);
  const inferredDocumentType = inferClientDocumentType({
    inputTitle: input.title,
    parsedTitle: parseResult.metadata.title,
    rawText: input.rawText,
  });

  const { data: document, error: documentError } = await supabase
    .from("policy_documents")
    .insert({
      owner_user_id: currentUser.id,
      title: input.title,
      description: input.description || null,
      document_type: inferredDocumentType,
      source_storage_path: storagePath,
      source_file_name: input.sourceFileName,
    })
    .select("id")
    .single();

  if (documentError || !document) {
    throw new Error(buildAuthDebugMessage(`document import insert failed: ${documentError?.message ?? "unknown"}`, session));
  }

  const { data: version, error: versionError } = await supabase
    .from("policy_document_versions")
    .insert({
      document_id: document.id,
      version_number: 1,
      raw_text: input.rawText,
      parse_warnings: parseResult.warnings,
      effective_date: deriveDocumentMetadata(input.rawText).revisionDate,
    })
    .select("id, raw_text")
    .single();

  if (versionError || !version) {
    throw new Error(buildAuthDebugMessage(`document import version insert failed: ${versionError?.message ?? "unknown"}`, session));
  }

  if ((version.raw_text ?? "") !== input.rawText) {
    throw new Error(buildAuthDebugMessage("document import verification failed: imported raw text changed during save.", session));
  }

  const sections = dedupeParsedSections(parseResult.sections);
  const hierarchyColumnsById = buildSectionHierarchyColumns(sections);
  const rows = await Promise.all(sections.map(async (section) => ({
    id: section.tempId,
    document_version_id: version.id,
    parent_section_id: section.parentTempId,
    hierarchy_type: section.hierarchyType,
    hierarchy_label: section.hierarchyLabel,
    hierarchy_order: section.hierarchyOrder,
    normalized_text: section.normalizedText,
    original_text: section.originalText,
    text_hash: await sha256Hex(section.normalizedText),
    path_display: section.path.join(" > "),
    ...hierarchyColumnsById.get(section.tempId),
  })));
  if (rows.length === 0 && input.rawText.trim()) {
    rows.push(await buildFallbackDocumentSectionRow(version.id, input.rawText));
  }

  if (rows.length > 0) {
    const { error: sectionError } = await supabase
      .from("policy_document_sections")
      .insert(rows);

    if (sectionError) {
      throw new Error(buildAuthDebugMessage(`document import section insert failed: ${sectionError.message}`, session));
    }
  }

  const supersededDocumentCount = await deleteSupersededDocumentsByTitle({
    currentDocumentId: document.id,
    ownerUserId: currentUser.id,
    title: input.title,
    session,
  });

  await supabase.from("policy_audit_logs").insert({
    actor_user_id: currentUser.id,
    action: "DOCUMENT_REGISTERED",
    target_document_id: document.id,
    result: "SUCCESS",
    metadata: {
      versionId: version.id,
      sectionCount: rows.length,
      warningCount: parseResult.warnings.length,
      supersededDocumentCount,
      source: "xlsx-import",
    },
  });

  return {
    status: "success",
    data: {
      documentId: document.id,
      versionId: version.id,
      sectionCount: rows.length,
      warnings: parseResult.warnings,
      supersededDocumentCount,
    },
  };
}

export async function uploadStructuredRowsDocument(input: {
  rows: ImportedStructuredDocumentRow[];
  title: string;
  description: string;
  sourceFileName: string;
}) {
  const session = await ensureAuthenticatedSession();
  const currentUser = await ensureAuthenticatedUser(session.access_token);
  const supabase = getSupabaseClient();
  const rawText = input.rows.map((row) => row.content).join("\n");
  const storagePath = buildClientStoragePath(currentUser.id, input.sourceFileName);
  const fileBytes = new TextEncoder().encode(rawText);
  const { error: uploadError } = await supabase.storage
    .from("source-documents")
    .upload(storagePath, fileBytes, {
      upsert: false,
      contentType: "text/plain",
    });

  if (uploadError) {
    throw new Error(buildAuthDebugMessage(`structured import storage failed: ${uploadError.message}`, session));
  }

  const inferredDocumentType = inferClientDocumentType({
    inputTitle: input.title,
    parsedTitle: null,
    rawText,
  });

  const { data: document, error: documentError } = await supabase
    .from("policy_documents")
    .insert({
      owner_user_id: currentUser.id,
      title: input.title,
      description: input.description || null,
      document_type: inferredDocumentType,
      source_storage_path: storagePath,
      source_file_name: input.sourceFileName,
    })
    .select("id")
    .single();

  if (documentError || !document) {
    throw new Error(buildAuthDebugMessage(`structured import document insert failed: ${documentError?.message ?? "unknown"}`, session));
  }

  const { data: version, error: versionError } = await supabase
    .from("policy_document_versions")
    .insert({
      document_id: document.id,
      version_number: 1,
      raw_text: rawText,
      parse_warnings: [STRUCTURED_XLSX_IMPORT_WARNING],
      effective_date: deriveDocumentMetadata(rawText).revisionDate,
    })
    .select("id, raw_text")
    .single();

  if (versionError || !version) {
    throw new Error(buildAuthDebugMessage(`structured import version insert failed: ${versionError?.message ?? "unknown"}`, session));
  }

  if ((version.raw_text ?? "") !== rawText) {
    throw new Error(buildAuthDebugMessage("structured import verification failed: imported text changed during save.", session));
  }

  const sectionRows = await buildImportedDocumentSectionRows(version.id, input.rows);
  if (sectionRows.length === 0 && rawText.trim()) {
    sectionRows.push(await buildFallbackDocumentSectionRow(version.id, rawText));
  }

  if (sectionRows.length > 0) {
    const { error: sectionError } = await supabase
      .from("policy_document_sections")
      .insert(sectionRows);

    if (sectionError) {
      throw new Error(buildAuthDebugMessage(`structured import section insert failed: ${sectionError.message}`, session));
    }
  }

  const supersededDocumentCount = await deleteSupersededDocumentsByTitle({
    currentDocumentId: document.id,
    ownerUserId: currentUser.id,
    title: input.title,
    session,
  });

  await supabase.from("policy_audit_logs").insert({
    actor_user_id: currentUser.id,
    action: "DOCUMENT_REGISTERED",
    target_document_id: document.id,
    result: "SUCCESS",
    metadata: {
      versionId: version.id,
      sectionCount: sectionRows.length,
      warningCount: 0,
      supersededDocumentCount,
      source: "xlsx-structured-import",
    },
  });

  return {
    status: "success",
    data: {
      documentId: document.id,
      versionId: version.id,
      sectionCount: sectionRows.length,
      warnings: [],
      supersededDocumentCount,
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

async function deleteSupersededDocumentsByTitle(input: {
  currentDocumentId: string;
  ownerUserId: string;
  title: string;
  session: Awaited<ReturnType<typeof ensureAuthenticatedSession>>;
}) {
  const normalizedTitle = input.title.trim();
  if (!normalizedTitle) {
    return 0;
  }

  const supabase = getSupabaseClient();
  const { data: supersededDocuments, error: loadError } = await supabase
    .from("policy_documents")
    .select("id, source_storage_path")
    .eq("owner_user_id", input.ownerUserId)
    .eq("title", normalizedTitle)
    .neq("id", input.currentDocumentId);

  if (loadError) {
    throw new Error(buildAuthDebugMessage(`superseded document lookup failed: ${loadError.message}`, input.session));
  }

  const supersededIds = (supersededDocuments ?? []).map((document) => document.id);
  if (supersededIds.length === 0) {
    return 0;
  }

  const storagePaths = (supersededDocuments ?? [])
    .map((document) => document.source_storage_path)
    .filter((path): path is string => typeof path === "string" && path.trim().length > 0);

  if (storagePaths.length > 0) {
    const { error: storageError } = await supabase.storage
      .from("source-documents")
      .remove(storagePaths);

    if (storageError) {
      throw new Error(buildAuthDebugMessage(`superseded document storage delete failed: ${storageError.message}`, input.session));
    }
  }

  const { error: deleteError } = await supabase
    .from("policy_documents")
    .delete()
    .in("id", supersededIds);

  if (deleteError) {
    throw new Error(buildAuthDebugMessage(`superseded document delete failed: ${deleteError.message}`, input.session));
  }

  return supersededIds.length;
}

export async function deleteDocument(input: { documentId: string }) {
  const session = await ensureAuthenticatedSession();
  const currentUser = await ensureAuthenticatedUser(session.access_token);
  const supabase = getSupabaseClient();
  const { data: deletedDocument, error } = await supabase
    .from("policy_documents")
    .delete()
    .eq("id", input.documentId)
    .select("id")
    .maybeSingle();

  if (error) {
    throw new Error(buildAuthDebugMessage(`delete-document direct delete failed: ${error.message}`, session));
  }

  if (!deletedDocument) {
    throw new Error(
      buildAuthDebugMessage(
        "delete-document direct delete failed: 삭제된 문서가 없습니다. 이 문서의 소유자가 아니거나 삭제 권한이 없을 수 있습니다.",
        session,
      ),
    );
  }

  return {
    status: "success",
    data: {
      documentId: input.documentId,
      deletedBy: currentUser.id,
    },
  };
}

export async function reparseDocument(input: { documentId: string }) {
  const session = await ensureAuthenticatedSession();
  const currentUser = await ensureAuthenticatedUser(session.access_token);
  const supabase = getSupabaseClient();
  const { data: version, error: versionError } = await supabase
    .from("policy_document_versions")
    .select("id, raw_text, version_number, created_at, parse_warnings")
    .eq("document_id", input.documentId)
    .order("version_number", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (versionError || !version) {
    throw new Error(buildAuthDebugMessage(`reparse-document load failed: ${versionError?.message ?? "Latest version not found."}`, session));
  }

  if (Array.isArray(version.parse_warnings) && version.parse_warnings.includes(STRUCTURED_XLSX_IMPORT_WARNING)) {
    return {
      status: "success",
      data: {
        documentId: input.documentId,
        versionId: version.id,
        sectionCount: 0,
        warningCount: version.parse_warnings.length,
        reparsedBy: currentUser.id,
      },
    };
  }

  const parseResult = parsePolicyText(version.raw_text ?? "");
  const sections = dedupeParsedSections(parseResult.sections);
  const hierarchyColumnsById = buildSectionHierarchyColumns(sections);
  const rows = await Promise.all(sections.map(async (section) => ({
    id: section.tempId,
    document_version_id: version.id,
    parent_section_id: section.parentTempId,
    hierarchy_type: section.hierarchyType,
    hierarchy_label: section.hierarchyLabel,
    hierarchy_order: section.hierarchyOrder,
    normalized_text: section.normalizedText,
    original_text: section.originalText,
    text_hash: await sha256Hex(section.normalizedText),
    path_display: section.path.join(" > "),
    ...hierarchyColumnsById.get(section.tempId),
  })));
  if (rows.length === 0 && (version.raw_text ?? "").trim()) {
    rows.push(await buildFallbackDocumentSectionRow(version.id, version.raw_text ?? ""));
  }

  const { error: deleteSectionsError } = await supabase
    .from("policy_document_sections")
    .delete()
    .eq("document_version_id", version.id);

  if (deleteSectionsError) {
    throw new Error(buildAuthDebugMessage(`reparse-document delete failed: ${deleteSectionsError.message}`, session));
  }

  if (rows.length > 0) {
    const { error: insertError } = await supabase
      .from("policy_document_sections")
      .insert(rows);

    if (insertError) {
      throw new Error(buildAuthDebugMessage(`reparse-document insert failed: ${insertError.message}`, session));
    }
  }

  const { error: updateError } = await supabase
    .from("policy_document_versions")
    .update({
      parse_warnings: parseResult.warnings,
    })
    .eq("id", version.id);

  if (updateError) {
    throw new Error(buildAuthDebugMessage(`reparse-document update failed: ${updateError.message}`, session));
  }

  return {
    status: "success",
    data: {
      documentId: input.documentId,
      versionId: version.id,
      sectionCount: rows.length,
      warningCount: parseResult.warnings.length,
      reparsedBy: currentUser.id,
    },
  };
}

export async function listDocuments(): Promise<DocumentSummary[]> {
  await ensureAuthenticatedSession();
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("policy_document_summary_view")
    .select(
      "id, title, document_type, version_number, version_id, created_at, effective_date, section_count",
    )
    .order("created_at", { ascending: false });

  if (error) {
    throwAuthAwareError(error.message);
  }

  return ((data ?? []) as DocumentSummary[]).sort(compareDocumentSummaryForList);
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
  await ensureAuthenticatedSession();
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("policy_workspace_favorites")
    .select(
      "id, name, updated_at, selected_document_id, target_document_ids, reference_document_ids, law_version_ids",
    )
    .order("updated_at", { ascending: false });

  if (error) {
    throwAuthAwareError(error.message);
  }

  return ((data ?? []) as WorkspaceFavoriteRow[]).map((row) => ({
    id: row.id,
    name: row.name,
    updatedAt: row.updated_at,
    selection: normalizeWorkspaceSelectionSnapshot({
      selectedDocumentId: row.selected_document_id,
      targetDocumentIds: row.target_document_ids ?? [],
      referenceDocumentIds: row.reference_document_ids ?? [],
      lawVersionIds: row.law_version_ids ?? [],
    }),
  }));
}

export async function listReviewExecutionHistory(): Promise<ReviewExecutionHistoryEntry[]> {
  await ensureAuthenticatedSession();
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("policy_review_execution_history")
    .select("id, reviewer_email, target_titles, reference_titles, comparison_run_ids, ai_report_history_id, result_status, created_at")
    .order("created_at", { ascending: false });

  if (error) {
    throwAuthAwareError(error.message);
  }

  return ((data ?? []) as ReviewExecutionHistoryRow[]).map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    reviewerEmail: row.reviewer_email,
    targetTitles: row.target_titles ?? [],
    referenceTitles: row.reference_titles ?? [],
    comparisonRunIds: row.comparison_run_ids ?? [],
    aiReportHistoryId: row.ai_report_history_id ?? null,
    resultStatus: row.result_status ?? ((row.comparison_run_ids?.length ?? 0) > 0 ? "comparison_completed" : "pending"),
  }));
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
  const currentUser = await ensureAuthenticatedUser(session.access_token);
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("policy_review_execution_history")
    .insert({
      owner_user_id: currentUser.id,
      reviewer_email: input.reviewerEmail,
      target_titles: input.targetTitles,
      reference_titles: input.referenceTitles,
      comparison_run_ids: input.comparisonRunIds,
      ai_report_history_id: input.aiReportHistoryId ?? null,
      result_status:
        input.resultStatus ?? (input.comparisonRunIds.length > 0 ? "comparison_completed" : "pending"),
    })
    .select("id, reviewer_email, target_titles, reference_titles, comparison_run_ids, ai_report_history_id, result_status, created_at")
    .single();

  if (error || !data) {
    throwAuthAwareError(error?.message ?? "review execution history save failed");
  }

  const row = data as ReviewExecutionHistoryRow;
  return {
    id: row.id,
    createdAt: row.created_at,
    reviewerEmail: row.reviewer_email,
    targetTitles: row.target_titles ?? [],
    referenceTitles: row.reference_titles ?? [],
    comparisonRunIds: row.comparison_run_ids ?? [],
    aiReportHistoryId: row.ai_report_history_id ?? null,
    resultStatus: row.result_status ?? ((row.comparison_run_ids?.length ?? 0) > 0 ? "comparison_completed" : "pending"),
  } satisfies ReviewExecutionHistoryEntry;
}

export async function updateReviewExecutionHistoryStatus(input: {
  entryId: string;
  resultStatus: ReviewExecutionHistoryEntry["resultStatus"];
  aiReportHistoryId?: string | null;
}) {
  await ensureAuthenticatedSession();
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("policy_review_execution_history")
    .update({
      result_status: input.resultStatus,
      ...(input.aiReportHistoryId !== undefined ? { ai_report_history_id: input.aiReportHistoryId } : {}),
    })
    .eq("id", input.entryId)
    .select("id, reviewer_email, target_titles, reference_titles, comparison_run_ids, ai_report_history_id, result_status, created_at")
    .single();

  if (error || !data) {
    throwAuthAwareError(error?.message ?? "review execution history update failed");
  }

  const row = data as ReviewExecutionHistoryRow;
  return {
    id: row.id,
    createdAt: row.created_at,
    reviewerEmail: row.reviewer_email,
    targetTitles: row.target_titles ?? [],
    referenceTitles: row.reference_titles ?? [],
    comparisonRunIds: row.comparison_run_ids ?? [],
    aiReportHistoryId: row.ai_report_history_id ?? null,
    resultStatus: row.result_status ?? ((row.comparison_run_ids?.length ?? 0) > 0 ? "comparison_completed" : "pending"),
  } satisfies ReviewExecutionHistoryEntry;
}

export async function listAiReportHistory(): Promise<AiReportHistorySummary[]> {
  await ensureAuthenticatedSession();
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("policy_ai_report_history")
    .select("id, title, selection_summary, selection_counts, created_at")
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    throwAuthAwareError(error.message);
  }

  return ((data ?? []) as AiReportHistoryRow[]).flatMap((row) => {
    const entry = normalizeAiReportHistorySummaryRow(row);
    return entry ? [entry] : [];
  });
}

export async function getAiReportHistoryEntry(entryId: string): Promise<AiReportHistoryEntry | null> {
  await ensureAuthenticatedSession();
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("policy_ai_report_history")
    .select("id, title, selection_summary, selection_counts, guidance, created_at")
    .eq("id", entryId)
    .maybeSingle();

  if (error) {
    throwAuthAwareError(error.message);
  }

  return data ? normalizeAiReportHistoryRow(data as AiReportHistoryRow) : null;
}

export async function saveAiReportHistoryEntry(input: {
  title: string;
  selectionSummary: string;
  selectionCounts: AiReportHistoryEntry["selectionCounts"];
  guidance: AiReportHistoryEntry["guidance"];
}) {
  const session = await ensureAuthenticatedSession();
  const currentUser = await ensureAuthenticatedUser(session.access_token);
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("policy_ai_report_history")
    .insert({
      owner_user_id: currentUser.id,
      title: input.title,
      selection_summary: input.selectionSummary,
      selection_counts: input.selectionCounts,
      guidance: input.guidance,
    })
    .select("id, title, selection_summary, selection_counts, guidance, created_at")
    .single();

  if (error || !data) {
    throw new Error(buildAuthDebugMessage(`ai report history save failed: ${error?.message ?? "unknown"}`, session));
  }

  const normalized = normalizeAiReportHistoryRow(data as AiReportHistoryRow);
  if (!normalized) {
    throw new Error(buildAuthDebugMessage("ai report history save failed: invalid saved payload.", session));
  }
  return normalized;
}

export async function deleteAiReportHistoryEntry(entryId: string) {
  await ensureAuthenticatedSession();
  const supabase = getSupabaseClient();
  const { error } = await supabase
    .from("policy_ai_report_history")
    .delete()
    .eq("id", entryId);

  if (error) {
    throwAuthAwareError(error.message);
  }
}

export async function saveWorkspaceFavorite(input: {
  favoriteId?: string;
  name: string;
  selection: WorkspaceSelectionSnapshot;
}) {
  const session = await ensureAuthenticatedSession();
  const currentUser = await ensureAuthenticatedUser(session.access_token);
  const supabase = getSupabaseClient();
  const normalizedSelection = normalizeWorkspaceSelectionSnapshot(input.selection);
  const payload = {
    owner_user_id: currentUser.id,
    name: input.name,
    selected_document_id: normalizedSelection.selectedDocumentId,
    target_document_ids: normalizedSelection.targetDocumentIds,
    reference_document_ids: normalizedSelection.referenceDocumentIds,
    law_version_ids: normalizedSelection.lawVersionIds,
    updated_at: new Date().toISOString(),
  };

  const builder = input.favoriteId
    ? supabase
        .from("policy_workspace_favorites")
        .update(payload)
        .eq("id", input.favoriteId)
        .select(
          "id, name, updated_at, selected_document_id, target_document_ids, reference_document_ids, law_version_ids",
        )
        .single()
    : supabase
        .from("policy_workspace_favorites")
        .upsert(payload, { onConflict: "owner_user_id,name" })
        .select(
          "id, name, updated_at, selected_document_id, target_document_ids, reference_document_ids, law_version_ids",
        )
        .single();

  const { data, error } = await builder;

  if (error || !data) {
    throwAuthAwareError(error?.message ?? "workspace favorite save failed");
  }

  const row = data as WorkspaceFavoriteRow;
  return {
    id: row.id,
    name: row.name,
    updatedAt: row.updated_at,
    selection: normalizeWorkspaceSelectionSnapshot({
      selectedDocumentId: row.selected_document_id,
      targetDocumentIds: row.target_document_ids ?? [],
      referenceDocumentIds: row.reference_document_ids ?? [],
      lawVersionIds: row.law_version_ids ?? [],
    }),
  } satisfies WorkspaceFavorite;
}

export async function deleteWorkspaceFavorite(favoriteId: string) {
  await ensureAuthenticatedSession();
  const supabase = getSupabaseClient();
  const { error } = await supabase.from("policy_workspace_favorites").delete().eq("id", favoriteId);

  if (error) {
    throwAuthAwareError(error.message);
  }
}

export async function getPolicyUserOpenAiSettings(defaultModel: string): Promise<OpenAiSettings> {
  const session = await ensureAuthenticatedSession();
  const currentUser = await ensureAuthenticatedUser(session.access_token);
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("policy_user_settings")
    .select("openai_api_key, openai_model")
    .eq("owner_user_id", currentUser.id)
    .maybeSingle();

  if (error) {
    throw new Error(buildAuthDebugMessage(`openai settings load failed: ${error.message}`, session));
  }

  const row = (data ?? null) as PolicyUserSettingsRow | null;
  return {
    apiKey: row?.openai_api_key ?? "",
    model: row?.openai_model?.trim() || defaultModel,
  };
}

export async function savePolicyUserOpenAiSettings(settings: OpenAiSettings, defaultModel: string) {
  const session = await ensureAuthenticatedSession();
  const currentUser = await ensureAuthenticatedUser(session.access_token);
  const supabase = getSupabaseClient();
  const { error } = await supabase
    .from("policy_user_settings")
    .upsert({
      owner_user_id: currentUser.id,
      openai_api_key: settings.apiKey,
      openai_model: settings.model.trim() || defaultModel,
      updated_at: new Date().toISOString(),
    }, { onConflict: "owner_user_id" });

  if (error) {
    throw new Error(buildAuthDebugMessage(`openai settings save failed: ${error.message}`, session));
  }
}

export async function getPolicySecuritySettings(defaultSettings: SecuritySettings): Promise<SecuritySettings> {
  const session = await ensureAuthenticatedSession();
  const currentUser = await ensureAuthenticatedUser(session.access_token);
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("policy_security_settings")
    .select("allowed_email_domain, session_idle_timeout_minutes")
    .eq("owner_user_id", currentUser.id)
    .maybeSingle();

  if (error) {
    throw new Error(buildAuthDebugMessage(`security settings load failed: ${error.message}`, session));
  }

  const row = (data ?? null) as PolicySecuritySettingsRow | null;
  return normalizeSecuritySettings(
    {
      allowedEmailDomain: row?.allowed_email_domain ?? defaultSettings.allowedEmailDomain,
      sessionIdleTimeoutMinutes:
        row?.session_idle_timeout_minutes ?? defaultSettings.sessionIdleTimeoutMinutes,
    },
    defaultSettings,
  );
}

export async function savePolicySecuritySettings(settings: SecuritySettings, defaultSettings: SecuritySettings) {
  const session = await ensureAuthenticatedSession();
  const currentUser = await ensureAuthenticatedUser(session.access_token);
  const normalizedSettings = normalizeSecuritySettings(settings, defaultSettings);
  const supabase = getSupabaseClient();
  const { error } = await supabase
    .from("policy_security_settings")
    .upsert({
      owner_user_id: currentUser.id,
      allowed_email_domain: normalizedSettings.allowedEmailDomain,
      session_idle_timeout_minutes: normalizedSettings.sessionIdleTimeoutMinutes,
      updated_at: new Date().toISOString(),
    }, { onConflict: "owner_user_id" });

  if (error) {
    throw new Error(buildAuthDebugMessage(`security settings save failed: ${error.message}`, session));
  }

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
  const supabase = getSupabaseClient();
  const [documentResponse, versionResponse] = await Promise.all([
    supabase
      .from("policy_documents")
      .select("id, title, description, document_type")
      .eq("id", documentId)
      .single(),
    supabase
      .from("policy_document_versions")
      .select("id, version_number, raw_text, parse_warnings")
      .eq("document_id", documentId)
      .order("version_number", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(1)
      .single(),
  ]);

  if (documentResponse.error) {
    throwAuthAwareError(documentResponse.error.message);
  }

  if (versionResponse.error || !versionResponse.data) {
    throwAuthAwareError(versionResponse.error.message);
  }

  let sections = await fetchAllDocumentSections(versionResponse.data.id);
  const parseWarnings = Array.isArray(versionResponse.data.parse_warnings)
    ? versionResponse.data.parse_warnings.filter((value: unknown): value is string => typeof value === "string")
    : [];
  const isStructuredImportLocked = parseWarnings.includes(STRUCTURED_XLSX_IMPORT_WARNING);
  if (sections.length === 0 && (versionResponse.data.raw_text ?? "").trim() && !isStructuredImportLocked) {
    sections = await rebuildMissingDocumentSections(
      versionResponse.data.id,
      versionResponse.data.raw_text,
    );
  }
  const metadata = deriveDocumentMetadata(versionResponse.data.raw_text);

  return {
    id: documentResponse.data.id,
    version_id: versionResponse.data.id,
    title: documentResponse.data.title,
    description: documentResponse.data.description,
    document_type: documentResponse.data.document_type,
    version_number: versionResponse.data.version_number,
    raw_text: versionResponse.data.raw_text,
    sections: dedupeDocumentSectionRecords(
      sections,
    ),
    parse_warnings: filterDocumentParseWarnings(
      parseWarnings,
      metadata.title,
    ),
    metadata,
  };
}

async function fetchAllDocumentSections(versionId: string): Promise<DocumentDetail["sections"]> {
  const supabase = getSupabaseClient();
  const pageSize = 1000;
  const sections: DocumentDetail["sections"] = [];

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("policy_document_sections")
      .select(
        "id, hierarchy_type, hierarchy_label, hierarchy_order, original_text, path_display, chapter_label, chapter_text, article_label, article_text, paragraph_label, paragraph_text, item_label, item_text, sub_item_label, sub_item_text",
      )
      .eq("document_version_id", versionId)
      .order("hierarchy_order", { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) {
      throwAuthAwareError(error.message);
    }

    sections.push(...((data ?? []) as DocumentDetail["sections"]));
    if ((data ?? []).length < pageSize) {
      break;
    }
  }

  return sections;
}

async function rebuildMissingDocumentSections(
  versionId: string,
  rawText: string,
): Promise<DocumentDetail["sections"]> {
  const supabase = getSupabaseClient();
  const parseResult = parsePolicyText(rawText);
  const sections = dedupeParsedSections(parseResult.sections);
  const hierarchyColumnsById = buildSectionHierarchyColumns(sections);
  const rows = await Promise.all(sections.map(async (section) => ({
    id: section.tempId,
    document_version_id: versionId,
    parent_section_id: section.parentTempId,
    hierarchy_type: section.hierarchyType,
    hierarchy_label: section.hierarchyLabel,
    hierarchy_order: section.hierarchyOrder,
    normalized_text: section.normalizedText,
    original_text: section.originalText,
    text_hash: await sha256Hex(section.normalizedText),
    path_display: section.path.join(" > "),
    ...hierarchyColumnsById.get(section.tempId),
  })));

  if (rows.length === 0 && rawText.trim()) {
    rows.push(await buildFallbackDocumentSectionRow(versionId, rawText));
  }

  if (rows.length === 0) {
    return [];
  }

  const { error } = await supabase
    .from("policy_document_sections")
    .insert(rows);

  if (error) {
    throwAuthAwareError(error.message);
  }

  return fetchAllDocumentSections(versionId);
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
  const currentUser = await ensureAuthenticatedUser(session.access_token);
  const supabase = getSupabaseClient();
  const rebuiltRawText = buildStructuredDocumentRawText({
    rows: input.rows,
    metadata: input.metadata,
  });

  const parseResult = parsePolicyText(rebuiltRawText);
  const sections = dedupeParsedSections(parseResult.sections);
  const hierarchyColumnsById = buildSectionHierarchyColumns(sections);
  const sectionRows = await Promise.all(sections.map(async (section) => ({
    id: section.tempId,
    document_version_id: input.versionId,
    parent_section_id: section.parentTempId,
    hierarchy_type: section.hierarchyType,
    hierarchy_label: section.hierarchyLabel,
    hierarchy_order: section.hierarchyOrder,
    normalized_text: section.normalizedText,
    original_text: section.originalText,
    text_hash: await sha256Hex(section.normalizedText),
    path_display: section.path.join(" > "),
    ...hierarchyColumnsById.get(section.tempId),
  })));
  if (sectionRows.length === 0 && rebuiltRawText.trim()) {
    sectionRows.push(await buildFallbackDocumentSectionRow(input.versionId, rebuiltRawText));
  }

  const { error: deleteSectionsError } = await supabase
    .from("policy_document_sections")
    .delete()
    .eq("document_version_id", input.versionId);

  if (deleteSectionsError) {
    throw new Error(buildAuthDebugMessage(`structured save delete failed: ${deleteSectionsError.message}`, session));
  }

  if (sectionRows.length > 0) {
    const { error: insertSectionsError } = await supabase
      .from("policy_document_sections")
      .insert(sectionRows);

    if (insertSectionsError) {
      throw new Error(buildAuthDebugMessage(`structured save insert failed: ${insertSectionsError.message}`, session));
    }
  }

  const { data: updatedVersion, error: versionUpdateError } = await supabase
    .from("policy_document_versions")
    .update({
      raw_text: rebuiltRawText,
      parse_warnings: parseResult.warnings,
      effective_date: deriveDocumentMetadata(rebuiltRawText).revisionDate,
    })
    .eq("id", input.versionId)
    .select("id, raw_text")
    .single();

  if (versionUpdateError || !updatedVersion) {
    throw new Error(buildAuthDebugMessage(`structured save version update failed: ${versionUpdateError?.message ?? "No version row was updated."}`, session));
  }

  if ((updatedVersion.raw_text ?? "") !== rebuiltRawText) {
    throw new Error(buildAuthDebugMessage("structured save verification failed: saved document text did not match the submitted edit.", session));
  }

  await supabase.from("policy_audit_logs").insert({
    actor_user_id: currentUser.id,
    action: "DOCUMENT_RESTRUCTURED",
    target_document_id: input.documentId,
    result: "SUCCESS",
    metadata: {
      versionId: input.versionId,
      sectionCount: sectionRows.length,
      warningCount: parseResult.warnings.length,
    },
  });

  return {
    status: "success",
    data: {
      documentId: input.documentId,
      versionId: input.versionId,
      sectionCount: sectionRows.length,
      warningCount: parseResult.warnings.length,
      rawText: updatedVersion.raw_text,
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
  await ensureAuthenticatedSession();
  const supabase = getSupabaseClient();
  const [overviewResponse, runResponse] = await Promise.all([
    supabase
    .from("policy_comparison_review_overview")
    .select("*")
      .order("created_at", { ascending: false }),
    supabase
      .from("policy_comparison_runs")
      .select(
        "id, source_document_version_id, target_law_version_id, policy_document_versions!inner(document_id)",
      ),
  ]);

  if (overviewResponse.error) {
    throwAuthAwareError(overviewResponse.error.message);
  }

  if (runResponse.error) {
    throwAuthAwareError(runResponse.error.message);
  }

  const runMetaById = new Map(
    ((runResponse.data ?? []) as ComparisonRunMetaRow[]).map((row) => [
      row.id,
      {
        document_id: Array.isArray(row.policy_document_versions)
          ? row.policy_document_versions[0]?.document_id
          : row.policy_document_versions?.document_id,
        document_version_id: row.source_document_version_id,
        law_version_id: row.target_law_version_id,
      },
    ]),
  );

  return (overviewResponse.data ?? []).map((row) => ({
    ...row,
    ...runMetaById.get(row.id),
  }));
}

export async function listLawVersions(): Promise<LawVersionSummary[]> {
  await ensureAuthenticatedSession();
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("policy_law_version_summary_view")
    .select(
      "id, law_source_id, source_title, source_link, version_label, effective_date, created_at, section_count",
    )
    .order("created_at", { ascending: false });

  if (error) {
    throwAuthAwareError(error.message);
  }

  return (data ?? []) as LawVersionSummary[];
}

export async function getLawDetail(
  lawVersionId: string,
): Promise<LawDetail> {
  await ensureAuthenticatedSession();
  const supabase = getSupabaseClient();

  const [versionResponse, sectionResponse] = await Promise.all([
    supabase
      .from("policy_law_versions")
      .select(
        "id, version_label, effective_date, raw_text, parse_warnings, policy_law_sources!inner(source_title, source_link)",
      )
      .eq("id", lawVersionId)
      .single(),
    supabase
      .from("policy_law_sections")
      .select(
        "id, hierarchy_type, hierarchy_label, hierarchy_order, original_text, path_display",
      )
      .eq("law_version_id", lawVersionId)
      .order("hierarchy_order", { ascending: true }),
  ]);

  if (versionResponse.error) {
    throwAuthAwareError(versionResponse.error.message);
  }

  if (sectionResponse.error) {
    throwAuthAwareError(sectionResponse.error.message);
  }

  const lawSource = Array.isArray(versionResponse.data.policy_law_sources)
    ? versionResponse.data.policy_law_sources[0]
    : versionResponse.data.policy_law_sources;

  return {
    id: versionResponse.data.id,
    source_title: lawSource?.source_title ?? null,
    source_link: lawSource?.source_link ?? "",
    version_label: versionResponse.data.version_label,
    effective_date: versionResponse.data.effective_date,
    raw_text: versionResponse.data.raw_text,
    parse_warnings: filterLawParseWarnings(
      Array.isArray(versionResponse.data.parse_warnings)
        ? versionResponse.data.parse_warnings.filter((value): value is string => typeof value === "string")
        : [],
      lawSource?.source_title ?? null,
    ),
    sections: (sectionResponse.data ?? []) as LawDetail["sections"],
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

export async function getComparisonReview(
  comparisonRunId: string,
): Promise<ComparisonReviewDetail> {
  await ensureAuthenticatedSession();
  const supabase = getSupabaseClient();

  const [detailResponse, resultResponse] = await Promise.all([
    supabase
      .from("policy_comparison_review_detail")
      .select("*")
      .eq("id", comparisonRunId)
      .single(),
    supabase
      .from("policy_comparison_results")
      .select(
        "id, affected_path, hierarchy_type, match_type, diff_type, confidence, before_text, after_text, explanation, reasoning_trace, ai_used",
      )
      .eq("comparison_run_id", comparisonRunId)
      .order("affected_path", { ascending: true }),
  ]);

  if (detailResponse.error) {
    throwAuthAwareError(detailResponse.error.message);
  }

  if (resultResponse.error) {
    throwAuthAwareError(resultResponse.error.message);
  }

  const detail = detailResponse.data as Omit<ComparisonReviewDetail, "results"> & {
    warning_messages: unknown;
  };
  const rawResults = (resultResponse.data ?? []) as Array<
    Omit<ComparisonResultRecord, "reasoning_trace"> & {
      reasoning_trace: unknown;
    }
  >;
  const results: ComparisonResultRecord[] = rawResults.map((row) => ({
    ...row,
    reasoning_trace: Array.isArray(row.reasoning_trace)
      ? row.reasoning_trace.filter((value): value is string => typeof value === "string")
      : [],
  }));

  return {
    ...detail,
    warning_messages: Array.isArray(detail.warning_messages)
      ? detail.warning_messages
      : [],
    results,
  };
}

export async function getAggregatedComparisonReview(
  comparisonRunIds: string[],
): Promise<ComparisonReviewAggregate> {
  await ensureAuthenticatedSession();
  const supabase = getSupabaseClient();

  const [detailResponse, resultResponse] = await Promise.all([
    supabase
      .from("policy_comparison_review_detail")
      .select("*")
      .in("id", comparisonRunIds),
    supabase
      .from("policy_comparison_results")
      .select(
        "id, comparison_run_id, affected_path, hierarchy_type, match_type, diff_type, confidence, before_text, after_text, explanation, reasoning_trace, ai_used",
      )
      .in("comparison_run_id", comparisonRunIds)
      .order("affected_path", { ascending: true }),
  ]);

  if (detailResponse.error) {
    throwAuthAwareError(detailResponse.error.message);
  }

  if (resultResponse.error) {
    throwAuthAwareError(resultResponse.error.message);
  }

  const details = (detailResponse.data ?? []) as Array<
    Omit<ComparisonReviewDetail, "results"> & { warning_messages: unknown }
  >;
  const detailById = new Map(details.map((detail) => [detail.id, detail]));

  const rawResults = (resultResponse.data ?? []) as Array<
    Omit<AggregatedComparisonResultRecord, "reasoning_trace" | "policy_title" | "law_title"> & {
      reasoning_trace: unknown;
    }
  >;

  const results: AggregatedComparisonResultRecord[] = rawResults.map((row) => {
    const detail = detailById.get(row.comparison_run_id);

    return {
      ...row,
      policy_title: detail?.policy_title ?? "정책 문서",
      law_title: detail?.law_title ?? "법령 문서",
      reasoning_trace: Array.isArray(row.reasoning_trace)
        ? row.reasoning_trace.filter((value): value is string => typeof value === "string")
        : [],
    };
  });

  return {
    run_ids: comparisonRunIds,
    warning_messages: [...new Set(
      details.flatMap((detail) => Array.isArray(detail.warning_messages) ? detail.warning_messages : []),
    )],
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

async function ensureAuthenticatedSession() {
  const supabase = getSupabaseClient();
  const {
    data: { session },
    error,
  } = await supabase.auth.getSession();

  if (error || !session) {
    throw new Error(
      buildAuthDebugMessage(error?.message, session),
    );
  }

  if (!session.user?.id) {
    throw new Error(buildAuthDebugMessage("사용자 정보가 없습니다.", session));
  }

  if (isSessionExpiredOrNearExpiry(session)) {
    return await forceRefreshAuthenticatedSession();
  }

  return session;
}

async function forceRefreshAuthenticatedSession() {
  const supabase = getSupabaseClient();
  const {
    data: { session },
    error,
  } = await supabase.auth.getSession();

  if (error || !session?.refresh_token) {
    throw new Error(buildAuthDebugMessage(error?.message ?? "세션 갱신 실패", session));
  }

  const {
    data: { session: refreshedSession },
    error: refreshError,
  } = await supabase.auth.refreshSession({
    refresh_token: session.refresh_token,
  });

  if (refreshError || !refreshedSession) {
    throw new Error(
      buildAuthDebugMessage(refreshError?.message ?? "세션 갱신 실패", session),
    );
  }

  return refreshedSession;
}

async function ensureAuthenticatedUser(accessToken: string) {
  const supabase = getSupabaseClient();
  const resolveUser = async (token: string) => {
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);

    if (error || !user) {
      throw new Error(
        buildAuthDebugMessage(error?.message ?? "사용자 검증 실패", null),
      );
    }

    return user;
  };

  try {
    return await resolveUser(accessToken);
  } catch (error) {
    if (!(error instanceof Error) || !isJwtError(error.message)) {
      throw error;
    }

    const refreshedSession = await forceRefreshAuthenticatedSession();
    return await resolveUser(refreshedSession.access_token);
  }
}

async function invokeEdgeFunction<TBody extends Record<string, unknown>>(
  functionName: string,
  body: TBody,
  contextInfo?: {
    stage: string;
    fileName?: string;
    session?: {
      user: {
        id?: string;
      };
      expires_at?: number;
    } | null;
    userId?: string;
  },
) {
  let accessToken = await getValidatedAccessToken();
  let response = await invokeEdgeFunctionHttp(functionName, body, accessToken);

  if (response.error && shouldRetryWithRefreshedSession(response.error)) {
    accessToken = await getValidatedAccessToken(true);
    response = await invokeEdgeFunctionHttp(functionName, body, accessToken);
  }

  if (response.error) {
    if (shouldInvalidateStoredSession(response.error)) {
      clearSupabaseAuthStorage();
    }
    throw new Error(await formatFunctionInvokeError(response.error, contextInfo));
  }

  return response.data;
}

async function getValidatedAccessToken(forceRefresh = false) {
  const supabase = getSupabaseClient();
  const session = forceRefresh
    ? await forceRefreshAuthenticatedSession()
    : await getFreshAuthenticatedSession();

  const validateAccessToken = async (token: string) => {
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);

    if (error || !user) {
      throw new Error(buildAuthDebugMessage(error?.message ?? "사용자 검증 실패", session));
    }

    return token;
  };

  try {
    return await validateAccessToken(session.access_token);
  } catch (error) {
    if (!(error instanceof Error) || !isJwtError(error.message) || forceRefresh) {
      throw error;
    }

    const refreshedSession = await forceRefreshAuthenticatedSession();
    return await validateAccessToken(refreshedSession.access_token);
  }
}

async function invokeEdgeFunctionHttp<TBody extends Record<string, unknown>>(
  functionName: string,
  body: TBody,
  accessToken: string,
) {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !anonKey) {
    return {
      data: null,
      error: new Error(
        "Missing Supabase environment. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.",
      ),
    };
  }

  let response: Response;
  try {
    response = await fetchWithRetry(
      `${supabaseUrl}/functions/v1/${functionName}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: anonKey,
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(body),
      },
      {
        functionName,
      },
    );
  } catch (error) {
    const message =
      error instanceof Error && error.message
        ? error.message
        : "Failed to fetch";
    return {
      data: null,
      error: new Error(
        message === "Failed to fetch"
          ? `Failed to fetch: ${functionName} 호출 중 네트워크 연결 또는 Supabase Function 접근에 실패했습니다.`
          : message,
      ),
    };
  }

  if (!response.ok) {
    const error = new Error(`Function request failed: ${response.status}`) as Error & {
      context?: {
        status?: number;
        statusText?: string;
        json?: () => Promise<unknown>;
        text?: () => Promise<string>;
      };
    };
    error.context = {
      status: response.status,
      statusText: response.statusText,
      json: async () => await response.clone().json(),
      text: async () => await response.clone().text(),
    };

    return {
      data: null,
      error,
    };
  }

  const data = await response.json();
  return {
    data,
    error: null,
  };
}

const DEFAULT_EDGE_FUNCTION_FETCH_TIMEOUT_MS = 90_000;
const LONG_RUNNING_EDGE_FUNCTION_FETCH_TIMEOUT_MS = 185_000;
const EDGE_FUNCTION_RETRY_DELAYS_MS = [800, 2_000, 5_000];

async function fetchWithRetry(
  input: RequestInfo | URL,
  init: RequestInit,
  options: {
    functionName: string;
  },
) {
  let lastError: unknown;
  const maxAttempts = EDGE_FUNCTION_RETRY_DELAYS_MS.length + 1;
  const timeoutMs = getEdgeFunctionFetchTimeoutMs(options.functionName);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      return await fetch(input, {
        ...init,
        signal: controller.signal,
      });
    } catch (error) {
      lastError = error;
      if (isAbortError(error)) {
        throw new Error(
          `${options.functionName} 호출이 ${Math.round(timeoutMs / 1000)}초를 넘겨 중단되었습니다.`,
        );
      }
      if (attempt === maxAttempts - 1 || !isRetriableFetchError(error)) {
        throw error;
      }
      console.warn(
        `[edge-function] ${options.functionName} fetch failed; retrying ${attempt + 1}/${maxAttempts - 1}`,
        error,
      );
      await waitFor(EDGE_FUNCTION_RETRY_DELAYS_MS[attempt] ?? 1_000);
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Failed to fetch");
}

function getEdgeFunctionFetchTimeoutMs(functionName: string) {
  if (functionName === "analyze-selected-revisions") {
    return LONG_RUNNING_EDGE_FUNCTION_FETCH_TIMEOUT_MS;
  }

  return DEFAULT_EDGE_FUNCTION_FETCH_TIMEOUT_MS;
}

function isRetriableFetchError(error: unknown) {
  if (!(error instanceof Error)) {
    return true;
  }

  return (
    error.name === "TypeError" ||
    /Failed to fetch|NetworkError|Load failed|The network connection was lost/i.test(error.message)
  );
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

function waitFor(milliseconds: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
}

async function getFreshAuthenticatedSession() {
  const session = await ensureAuthenticatedSession();

  if (!session.refresh_token || !isSessionExpiredOrNearExpiry(session)) {
    return session;
  }

  try {
    return await forceRefreshAuthenticatedSession();
  } catch (error) {
    if (error instanceof Error && !isJwtError(error.message)) {
      throw error;
    }

    const supabase = getSupabaseClient();
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser(session.access_token);

    if (userError || !user) {
      throw new Error(buildAuthDebugMessage(userError?.message ?? "사용자 검증 실패", session));
    }

    return session;
  }
}

function isSessionExpiredOrNearExpiry(session: { expires_at?: number | null }) {
  if (!session.expires_at) {
    return false;
  }

  const currentEpochSeconds = Math.floor(Date.now() / 1000);
  const refreshLeewaySeconds = 90;
  return session.expires_at <= currentEpochSeconds + refreshLeewaySeconds;
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

function buildDebugPrefix(
  message: string,
  contextInfo?: {
    stage: string;
    fileName?: string;
    session?: {
      user: {
        id?: string;
      };
      expires_at?: number;
    } | null;
    userId?: string;
  },
) {
  const sessionExpiry = contextInfo?.session?.expires_at
    ? new Date(contextInfo.session.expires_at * 1000).toISOString()
    : "없음";
  const userId = contextInfo?.userId ?? contextInfo?.session?.user?.id ?? "없음";

  return [
    "작업 디버그 정보",
    `단계: ${contextInfo?.stage ?? "unknown"}`,
    `파일: ${contextInfo?.fileName ?? "unknown"}`,
    `사용자 ID: ${userId}`,
    `세션 만료 시각: ${sessionExpiry}`,
    `원본 오류: ${message}`,
  ].join("\n");
}

async function formatFunctionInvokeError(
  error: Error & {
    context?: {
      status?: number;
      statusText?: string;
      json?: () => Promise<unknown>;
      text?: () => Promise<string>;
    };
  },
  contextInfo?: {
    stage: string;
    fileName?: string;
    session?: {
      user: {
        id?: string;
      };
      expires_at?: number;
    } | null;
    userId?: string;
  },
) {
  const stageLabel = contextInfo?.stage ?? "unknown";
  const statusMessage = error.context?.status
    ? `HTTP ${error.context.status} ${error.context.statusText ?? ""}`.trim()
    : error.message || "함수 호출 중 오류가 발생했습니다.";

  if (!error.context && /Failed to fetch/i.test(statusMessage)) {
    return `${stageLabel} 호출 실패\n네트워크 연결 또는 Supabase Edge Function 접근에 실패했습니다.`;
  }

  const debugPrefix = buildDebugPrefix(statusMessage, contextInfo);
  const authFailureSuffix = shouldInvalidateStoredSession(error)
    ? `\n안내: ${normalizeSupabaseAuthError("jwt")} 방금 저장된 로컬 세션은 초기화했습니다. 다시 로그인한 뒤 검토를 다시 실행하세요.`
    : "";

  if (!error.context) {
    return `${debugPrefix}${authFailureSuffix}`;
  }

  try {
    const payload = await error.context.json?.();
    if (payload) {
      return `${debugPrefix}\n서버 응답: ${JSON.stringify(payload)}${authFailureSuffix}`;
    }
  } catch {
    // Fall through to plain text extraction.
  }

  try {
    const text = await error.context.text?.();
    if (text) {
      return `${debugPrefix}\n서버 응답: ${text}${authFailureSuffix}`;
    }
  } catch {
    // Ignore and return the prefix only.
  }

  return `${debugPrefix}${authFailureSuffix}`;
}

function isJwtError(message?: string) {
  return Boolean(message?.toLowerCase().includes("jwt"));
}

function shouldRetryWithRefreshedSession(
  error: Error & {
    context?: {
      status?: number;
    };
  },
) {
  return error.context?.status === 401 || isJwtError(error.message);
}

function shouldInvalidateStoredSession(
  error: Error & {
    context?: {
      status?: number;
    };
  },
) {
  return error.context?.status === 401 || isJwtError(error.message);
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
