/**
 * Ported from supabase/functions/analyze-selected-revisions/index.ts.
 *
 * The OpenAI call, JSON schemas, and validators are provider-agnostic and
 * copied verbatim. Only the data access (document/law/section fetch, cumulative
 * API-call count, audit log) is swapped from Supabase Postgres to Firestore.
 */

import {
  COMPARISON_REPORT_INSTRUCTIONS,
  LEFT_REPORT_INSTRUCTIONS,
  RIGHT_REPORT_INSTRUCTIONS,
} from "../../../shared/analysisPrompts";
import { Firestore, type FirestoreDoc } from "../firestore";
import type { VerifiedUser } from "../firebaseAuth";
import { writeAudit } from "./_common";

interface GroupReportDocument {
  document_id: string;
  document_title: string;
  key_points: string[];
  source_paths: string[];
}
interface GroupReportRequirement {
  topic: string;
  detail: string;
  source_titles: string[];
  source_paths: string[];
  notes: string;
}
interface GroupReportResponse {
  summary: string;
  key_findings: string[];
  documents: GroupReportDocument[];
  merged_requirements: GroupReportRequirement[];
}
interface ComparisonGapItem {
  topic: string;
  gap_type: string;
  priority: string;
  right_requirement: string;
  left_current_state: string;
  risk: string;
  target_document_id: string;
  target_document_title: string;
  target_section_path: string;
  target_section_reason: string;
  recommended_revision: string;
  revision_instruction: string;
  revision_example: string;
  policy_evidence_paths: string[];
  comparison_source_title: string;
  comparison_evidence_paths: string[];
  confidence: number;
}
interface ComparisonCoveredItem {
  topic: string;
  reason: string;
  policy_evidence_paths: string[];
  comparison_evidence_paths: string[];
}
interface ComparisonDocumentAction {
  document_id: string;
  document_title: string;
  actions: Array<{
    priority: string;
    target_section_path: string;
    current_issue: string;
    action: string;
    required_change: string;
    instruction: string;
    draft_revision_text: string;
    rationale: string;
  }>;
}
interface ComparisonReportResponse {
  summary: string;
  revision_needed: boolean;
  overall_comment: string;
  gaps: ComparisonGapItem[];
  well_covered_items: ComparisonCoveredItem[];
  document_actions: ComparisonDocumentAction[];
  low_confidence_notes: string[];
  remaining_watchpoints: string[];
}
interface OpenAIResponsesApiResponse {
  output_parsed?: unknown;
  output_text?: string;
  output?: unknown[];
}

export interface AnalyzeSelectedRevisionsRequest {
  stage?: "left" | "right" | "final";
  targetDocumentIds: string[];
  referenceDocumentIds: string[];
  lawVersionIds: string[];
  leftGroupReport?: GroupReportResponse;
  rightGroupReport?: GroupReportResponse;
  openAiApiKey?: string;
  openAiModel?: string;
  promptOverrides?: { left?: string | string[]; right?: string | string[]; final?: string | string[] };
}

const MAX_SECTIONS_PER_DOCUMENT = 24;
const MAX_SECTION_TEXT_LENGTH = 180;
const OPENAI_TIMEOUT_MS = 180000;

export async function analyzeSelectedRevisions(
  body: AnalyzeSelectedRevisionsRequest,
  user: VerifiedUser,
  db: Firestore,
  env: { OPENAI_API_KEY?: string; OPENAI_REVISION_MODEL?: string },
): Promise<Record<string, unknown>> {
  const openAiApiKey = body.openAiApiKey?.trim() || env.OPENAI_API_KEY;
  const openAiModel = body.openAiModel?.trim() || env.OPENAI_REVISION_MODEL || "gpt-5.2";
  if (!openAiApiKey) {
    const err = new Error("OPENAI_API_KEY is not configured.");
    (err as { status?: number }).status = 500;
    throw err;
  }

  const stage = body.stage ?? "final";
  const promptOverrides = body.promptOverrides ?? {};
  const targetDocumentIds = [...new Set(body.targetDocumentIds ?? [])].filter(Boolean);
  const referenceDocumentIds = [...new Set(body.referenceDocumentIds ?? [])].filter(Boolean);
  const lawVersionIds = [...new Set(body.lawVersionIds ?? [])].filter(Boolean);

  if (
    targetDocumentIds.length === 0 ||
    (referenceDocumentIds.length === 0 && lawVersionIds.length === 0)
  ) {
    const err = new Error(
      "targetDocumentIds and at least one of referenceDocumentIds or lawVersionIds are required.",
    );
    (err as { status?: number }).status = 400;
    throw err;
  }

  const [targetDocuments, referenceDocuments, laws] = await Promise.all([
    fetchSelectedDocuments(db, targetDocumentIds, user.uid),
    fetchSelectedDocuments(db, referenceDocumentIds, user.uid),
    fetchSelectedLaws(db, lawVersionIds, user.uid),
  ]);

  let leftGroupReport: GroupReportResponse | null = null;
  let rightGroupReport: GroupReportResponse | null = null;
  let comparisonReport: ComparisonReportResponse | null = null;

  if (stage === "left") {
    leftGroupReport = await analyzeLeftGroup({
      apiKey: openAiApiKey,
      model: openAiModel,
      targetDocuments,
      instructions: resolveInstructions(LEFT_REPORT_INSTRUCTIONS, promptOverrides.left),
    });
  } else if (stage === "right") {
    rightGroupReport = await analyzeRightGroup({
      apiKey: openAiApiKey,
      model: openAiModel,
      referenceDocuments,
      laws,
      instructions: resolveInstructions(RIGHT_REPORT_INSTRUCTIONS, promptOverrides.right),
    });
  } else {
    leftGroupReport = validateGroupReportResponse(body.leftGroupReport);
    rightGroupReport = validateGroupReportResponse(body.rightGroupReport);
    comparisonReport = await analyzeComparison({
      apiKey: openAiApiKey,
      model: openAiModel,
      leftGroupReport,
      rightGroupReport,
      instructions: resolveInstructions(COMPARISON_REPORT_INSTRUCTIONS, promptOverrides.final),
    });
  }

  const callCount = 1;
  const cumulativeApiCallCount = await getCumulativeOpenAiApiCallCount(db, user.uid, callCount);

  await writeAudit(db, {
    actorUserId: user.uid,
    action: "SELECTED_REVISIONS_ANALYZED",
    targetDocumentId: null,
    result: "SUCCESS",
    metadata: {
      targetDocumentIds,
      referenceDocumentIds,
      lawVersionIds,
      stage,
      modelName: openAiModel,
      apiCallCount: callCount,
      cumulativeApiCallCount,
    },
  });

  return {
    status: "success",
    data: {
      stage,
      left_group_report: leftGroupReport,
      right_group_report: rightGroupReport,
      comparison_report: comparisonReport,
      model: openAiModel,
      api_call_count: cumulativeApiCallCount,
    },
    warnings: [],
    confidence: 1,
    traceability: { targetDocumentIds, referenceDocumentIds, lawVersionIds, aiUsed: true, model: openAiModel },
  };
}

// ---- Firestore data access (replaces Supabase queries) --------------------

async function fetchSelectedDocuments(db: Firestore, documentIds: string[], userId: string) {
  const documents: Array<Record<string, unknown>> = [];
  for (const documentId of documentIds) {
    const doc = await db.get(`documents/${documentId}`);
    if (!doc || doc.fields.ownerUserId !== userId) continue;
    const latest = doc.fields.latest as { versionId?: string; versionNumber?: number } | undefined;
    if (!latest?.versionId) continue;

    const sections = await db.query({
      parent: `documents/${documentId}/versions/${latest.versionId}`,
      collectionId: "sections",
      orderBy: { field: "hierarchyOrder", direction: "ASCENDING" },
      limit: 160,
    });
    documents.push({
      id: documentId,
      title: doc.fields.title,
      document_type: doc.fields.documentType,
      version_number: latest.versionNumber ?? 1,
      section_count: sections.length,
      sections: summarizeSections(sections),
    });
  }
  return documents;
}

async function fetchSelectedLaws(db: Firestore, lawVersionIds: string[], userId: string) {
  if (lawVersionIds.length === 0) return [];
  const laws: Array<Record<string, unknown>> = [];
  for (const lawVersionId of lawVersionIds) {
    const [version] = await db.queryGroup({
      collectionId: "versions",
      where: [{ field: "id", op: "EQUAL", value: lawVersionId }],
      limit: 1,
    });
    if (!version || version.fields.lawSourceId == null) continue;
    const lawSourceId = lawSourceIdFromName(version);
    const lawSource = await db.get(`lawSources/${lawSourceId}`);
    if (!lawSource || lawSource.fields.ownerUserId !== userId) continue;

    const sections = await db.query({
      parent: `lawSources/${lawSourceId}/versions/${lawVersionId}`,
      collectionId: "sections",
      orderBy: { field: "hierarchyOrder", direction: "ASCENDING" },
      limit: 160,
    });
    laws.push({
      id: lawVersionId,
      title: lawSource.fields.sourceTitle ?? "법령 문서",
      version_label: version.fields.versionLabel,
      effective_date: version.fields.effectiveDate,
      section_count: sections.length,
      sections: summarizeSections(sections),
    });
  }
  return laws;
}

function lawSourceIdFromName(version: FirestoreDoc): string {
  const parts = version.name.split("/");
  const idx = parts.lastIndexOf("lawSources");
  return idx >= 0 ? parts[idx + 1] : (version.fields.lawSourceId as string);
}

async function getCumulativeOpenAiApiCallCount(
  db: Firestore,
  userId: string,
  nextCallCount = 0,
): Promise<number> {
  const logs = await db.query({
    collectionId: "auditLogs",
    where: [{ field: "actorUserId", op: "EQUAL", value: userId }],
  });
  const cumulative = logs.reduce((total, row) => {
    const metadata = row.fields.metadata;
    if (!metadata || typeof metadata !== "object") return total;
    const count = (metadata as Record<string, unknown>).apiCallCount;
    return total + (typeof count === "number" ? count : 0);
  }, 0);
  return cumulative + nextCallCount;
}

function summarizeSections(sections: FirestoreDoc[]) {
  return sections
    .filter((section) => section.fields.hierarchyType !== "document")
    .slice(0, MAX_SECTIONS_PER_DOCUMENT)
    .map((section) => ({
      path: (section.fields.pathDisplay as string) ?? "",
      text: clipText((section.fields.originalText as string) ?? "", MAX_SECTION_TEXT_LENGTH),
    }));
}

// ---- OpenAI analysis (provider-agnostic; copied verbatim) -----------------

async function analyzeLeftGroup(input: {
  apiKey: string;
  model: string;
  targetDocuments: unknown[];
  instructions: string;
}) {
  return analyzeWithOpenAi<GroupReportResponse>({
    apiKey: input.apiKey,
    model: input.model,
    instructions: input.instructions,
    promptInput: {
      group_name: "left",
      task: "비교 대상 정책·지침 정리",
      target_documents: input.targetDocuments,
    },
    schemaName: "left_group_report",
    schema: GROUP_REPORT_SCHEMA,
    validator: validateGroupReportResponse,
  });
}

async function analyzeRightGroup(input: {
  apiKey: string;
  model: string;
  referenceDocuments: unknown[];
  laws: unknown[];
  instructions: string;
}) {
  return analyzeWithOpenAi<GroupReportResponse>({
    apiKey: input.apiKey,
    model: input.model,
    instructions: input.instructions,
    promptInput: {
      group_name: "right",
      task: "기준 문서 및 법령 정리",
      reference_documents: input.referenceDocuments,
      reference_laws: input.laws,
    },
    schemaName: "right_group_report",
    schema: GROUP_REPORT_SCHEMA,
    validator: validateGroupReportResponse,
  });
}

async function analyzeComparison(input: {
  apiKey: string;
  model: string;
  leftGroupReport: GroupReportResponse;
  rightGroupReport: GroupReportResponse;
  instructions: string;
}) {
  return analyzeWithOpenAi<ComparisonReportResponse>({
    apiKey: input.apiKey,
    model: input.model,
    instructions: input.instructions,
    promptInput: {
      task: "비교 대상과 기준 상세 비교",
      left_group_report: input.leftGroupReport,
      right_group_report: input.rightGroupReport,
    },
    schemaName: "comparison_report",
    schema: COMPARISON_REPORT_SCHEMA,
    validator: validateComparisonReportResponse,
  });
}

async function analyzeWithOpenAi<T>(input: {
  apiKey: string;
  model: string;
  instructions: string;
  promptInput: unknown;
  schemaName: string;
  schema: Record<string, unknown>;
  validator: (value: unknown) => T;
}): Promise<T> {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${input.apiKey}` },
    signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
    body: JSON.stringify({
      model: input.model,
      instructions: input.instructions,
      input: JSON.stringify(input.promptInput),
      text: { format: { type: "json_schema", name: input.schemaName, strict: true, schema: input.schema } },
    }),
  }).catch((error) => {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error("AI analysis timed out while calling OpenAI.");
    }
    throw error;
  });

  if (!response.ok) {
    throw new Error(`OpenAI API request failed: ${response.status} ${clipText(await response.text(), 1200)}`);
  }
  const payload = (await response.json()) as OpenAIResponsesApiResponse;
  const structuredPayload = extractStructuredPayload(payload);
  if (structuredPayload) return input.validator(structuredPayload);
  throw new Error(buildMissingStructuredPayloadError(payload));
}

const GROUP_REPORT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    key_findings: { type: "array", items: { type: "string" } },
    documents: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          document_id: { type: "string" },
          document_title: { type: "string" },
          key_points: { type: "array", items: { type: "string" } },
          source_paths: { type: "array", items: { type: "string" } },
        },
        required: ["document_id", "document_title", "key_points", "source_paths"],
      },
    },
    merged_requirements: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          topic: { type: "string" },
          detail: { type: "string" },
          source_titles: { type: "array", items: { type: "string" } },
          source_paths: { type: "array", items: { type: "string" } },
          notes: { type: "string" },
        },
        required: ["topic", "detail", "source_titles", "source_paths", "notes"],
      },
    },
  },
  required: ["summary", "key_findings", "documents", "merged_requirements"],
};

const COMPARISON_REPORT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    revision_needed: { type: "boolean" },
    overall_comment: { type: "string" },
    gaps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          topic: { type: "string" },
          gap_type: { type: "string" },
          priority: { type: "string" },
          right_requirement: { type: "string" },
          left_current_state: { type: "string" },
          risk: { type: "string" },
          target_document_id: { type: "string" },
          target_document_title: { type: "string" },
          target_section_path: { type: "string" },
          target_section_reason: { type: "string" },
          recommended_revision: { type: "string" },
          revision_instruction: { type: "string" },
          revision_example: { type: "string" },
          policy_evidence_paths: { type: "array", items: { type: "string" } },
          comparison_source_title: { type: "string" },
          comparison_evidence_paths: { type: "array", items: { type: "string" } },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
        required: [
          "topic", "gap_type", "priority", "right_requirement", "left_current_state",
          "risk", "target_document_id", "target_document_title", "target_section_path",
          "target_section_reason", "recommended_revision", "revision_instruction",
          "revision_example", "policy_evidence_paths", "comparison_source_title",
          "comparison_evidence_paths", "confidence",
        ],
      },
    },
    well_covered_items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          topic: { type: "string" },
          reason: { type: "string" },
          policy_evidence_paths: { type: "array", items: { type: "string" } },
          comparison_evidence_paths: { type: "array", items: { type: "string" } },
        },
        required: ["topic", "reason", "policy_evidence_paths", "comparison_evidence_paths"],
      },
    },
    document_actions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          document_id: { type: "string" },
          document_title: { type: "string" },
          actions: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                priority: { type: "string" },
                target_section_path: { type: "string" },
                current_issue: { type: "string" },
                action: { type: "string" },
                required_change: { type: "string" },
                instruction: { type: "string" },
                draft_revision_text: { type: "string" },
                rationale: { type: "string" },
              },
              required: [
                "priority", "target_section_path", "current_issue", "action",
                "required_change", "instruction", "draft_revision_text", "rationale",
              ],
            },
          },
        },
        required: ["document_id", "document_title", "actions"],
      },
    },
    low_confidence_notes: { type: "array", items: { type: "string" } },
    remaining_watchpoints: { type: "array", items: { type: "string" } },
  },
  required: [
    "summary", "revision_needed", "overall_comment", "gaps", "well_covered_items",
    "document_actions", "low_confidence_notes", "remaining_watchpoints",
  ],
};

function validateGroupReportResponse(value: unknown): GroupReportResponse {
  if (!value || typeof value !== "object") throw new Error("Group report response was not a JSON object.");
  const candidate = value as Record<string, unknown>;
  const requireString = (field: string) => {
    const fieldValue = candidate[field];
    if (typeof fieldValue !== "string" || fieldValue.trim().length === 0) {
      throw new Error(`Group report field '${field}' was empty.`);
    }
    return fieldValue.trim();
  };
  const requireStringArray = (field: string, minimumLength = 0, source = candidate) => {
    const fieldValue = source[field];
    if (!Array.isArray(fieldValue)) throw new Error(`Group report field '${field}' was invalid.`);
    const normalized = fieldValue.filter((e): e is string => typeof e === "string" && e.trim().length > 0);
    if (normalized.length < minimumLength) {
      throw new Error(`Group report field '${field}' did not contain enough detail.`);
    }
    return normalized;
  };
  const documentsRaw = candidate.documents;
  const mergedRaw = candidate.merged_requirements;
  if (!Array.isArray(documentsRaw) || !Array.isArray(mergedRaw)) {
    throw new Error("Group report arrays were invalid.");
  }
  return {
    summary: requireString("summary"),
    key_findings: requireStringArray("key_findings", 1),
    documents: documentsRaw.map((entry) => {
      if (!entry || typeof entry !== "object") throw new Error("Group report document item was invalid.");
      const item = entry as Record<string, unknown>;
      return {
        document_id: typeof item.document_id === "string" ? item.document_id : "",
        document_title: typeof item.document_title === "string" ? item.document_title : "",
        key_points: requireStringArray("key_points", 1, item),
        source_paths: requireStringArray("source_paths", 0, item),
      };
    }),
    merged_requirements: mergedRaw.map((entry) => {
      if (!entry || typeof entry !== "object") throw new Error("Group report merged requirement item was invalid.");
      const item = entry as Record<string, unknown>;
      return {
        topic: typeof item.topic === "string" ? item.topic.trim() : "",
        detail: typeof item.detail === "string" ? item.detail.trim() : "",
        source_titles: requireStringArray("source_titles", 0, item),
        source_paths: requireStringArray("source_paths", 0, item),
        notes: typeof item.notes === "string" ? item.notes.trim() : "",
      };
    }),
  };
}

function validateComparisonReportResponse(value: unknown): ComparisonReportResponse {
  if (!value || typeof value !== "object") throw new Error("Comparison report response was not a JSON object.");
  const candidate = value as Record<string, unknown>;
  const requireString = (field: string, source: Record<string, unknown> = candidate) => {
    const fieldValue = source[field];
    if (typeof fieldValue !== "string" || fieldValue.trim().length === 0) {
      throw new Error(`Comparison report field '${field}' was empty.`);
    }
    return fieldValue.trim();
  };
  const requireStringArray = (field: string, minimumLength = 0, source: Record<string, unknown> = candidate) => {
    const fieldValue = source[field];
    if (!Array.isArray(fieldValue)) throw new Error(`Comparison report field '${field}' was invalid.`);
    const normalized = fieldValue.filter((e): e is string => typeof e === "string" && e.trim().length > 0);
    if (normalized.length < minimumLength) {
      throw new Error(`Comparison report field '${field}' did not contain enough detail.`);
    }
    return normalized;
  };
  if (typeof candidate.revision_needed !== "boolean") {
    throw new Error("Comparison report field 'revision_needed' was invalid.");
  }
  const gapsRaw = candidate.gaps;
  const coveredRaw = candidate.well_covered_items;
  const actionsRaw = candidate.document_actions;
  if (!Array.isArray(gapsRaw) || !Array.isArray(coveredRaw) || !Array.isArray(actionsRaw)) {
    throw new Error("Comparison report arrays were invalid.");
  }
  return {
    summary: requireString("summary"),
    revision_needed: candidate.revision_needed,
    overall_comment: requireString("overall_comment"),
    gaps: gapsRaw.map((entry) => {
      if (!entry || typeof entry !== "object") throw new Error("Comparison gap item was invalid.");
      const item = entry as Record<string, unknown>;
      return {
        topic: requireString("topic", item),
        gap_type: requireString("gap_type", item),
        priority: requireString("priority", item),
        right_requirement: requireString("right_requirement", item),
        left_current_state: requireString("left_current_state", item),
        risk: requireString("risk", item),
        target_document_id: typeof item.target_document_id === "string" ? item.target_document_id : "",
        target_document_title: requireString("target_document_title", item),
        target_section_path: requireString("target_section_path", item),
        target_section_reason: requireString("target_section_reason", item),
        recommended_revision: requireString("recommended_revision", item),
        revision_instruction: requireString("revision_instruction", item),
        revision_example: requireString("revision_example", item),
        policy_evidence_paths: requireStringArray("policy_evidence_paths", 0, item),
        comparison_source_title: requireString("comparison_source_title", item),
        comparison_evidence_paths: requireStringArray("comparison_evidence_paths", 0, item),
        confidence: typeof item.confidence === "number" ? item.confidence : 0,
      };
    }),
    well_covered_items: coveredRaw.map((entry) => {
      if (!entry || typeof entry !== "object") throw new Error("Comparison covered item was invalid.");
      const item = entry as Record<string, unknown>;
      return {
        topic: requireString("topic", item),
        reason: requireString("reason", item),
        policy_evidence_paths: requireStringArray("policy_evidence_paths", 0, item),
        comparison_evidence_paths: requireStringArray("comparison_evidence_paths", 0, item),
      };
    }),
    document_actions: actionsRaw.map((entry) => {
      if (!entry || typeof entry !== "object") throw new Error("Comparison document action item was invalid.");
      const item = entry as Record<string, unknown>;
      const nestedActions = item.actions;
      if (!Array.isArray(nestedActions)) throw new Error("Comparison document action list was invalid.");
      return {
        document_id: typeof item.document_id === "string" ? item.document_id : "",
        document_title: requireString("document_title", item),
        actions: nestedActions.map((nested) => {
          if (!nested || typeof nested !== "object") throw new Error("Comparison action detail was invalid.");
          const nestedItem = nested as Record<string, unknown>;
          return {
            priority: requireString("priority", nestedItem),
            target_section_path: requireString("target_section_path", nestedItem),
            current_issue: requireString("current_issue", nestedItem),
            action: requireString("action", nestedItem),
            required_change: requireString("required_change", nestedItem),
            instruction: requireString("instruction", nestedItem),
            draft_revision_text: requireString("draft_revision_text", nestedItem),
            rationale: requireString("rationale", nestedItem),
          };
        }),
      };
    }),
    low_confidence_notes: requireStringArray("low_confidence_notes", 0),
    remaining_watchpoints: requireStringArray("remaining_watchpoints", 0),
  };
}

function resolveInstructions(defaultInstructions: string, override?: string | string[]) {
  if (Array.isArray(override)) {
    const combined = override
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean)
      .join("\n\n");
    return combined || defaultInstructions;
  }
  if (typeof override === "string" && override.trim().length > 0) return override.trim();
  return defaultInstructions;
}

function extractStructuredPayload(payload: OpenAIResponsesApiResponse) {
  if (payload.output_parsed && typeof payload.output_parsed === "object") return payload.output_parsed;
  const parsedTopLevelText = tryParseJsonText(payload.output_text);
  if (parsedTopLevelText) return parsedTopLevelText;
  if (!Array.isArray(payload.output)) return null;
  for (const item of payload.output) {
    if (!item || typeof item !== "object") continue;
    const message = item as Record<string, unknown>;
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!part || typeof part !== "object") continue;
      const contentPart = part as Record<string, unknown>;
      if (contentPart.parsed && typeof contentPart.parsed === "object") return contentPart.parsed;
      const parsedContentText = tryParseJsonText(
        typeof contentPart.text === "string" ? contentPart.text : null,
      );
      if (parsedContentText) return parsedContentText;
    }
  }
  return null;
}

function tryParseJsonText(value: string | undefined | null) {
  if (!value?.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function buildMissingStructuredPayloadError(payload: OpenAIResponsesApiResponse) {
  const outputSummary = Array.isArray(payload.output)
    ? payload.output
        .map((item) => {
          if (!item || typeof item !== "object") return "unknown";
          const record = item as Record<string, unknown>;
          const type = typeof record.type === "string" ? record.type : "unknown";
          const status = typeof record.status === "string" ? record.status : "unknown";
          return `${type}:${status}`;
        })
        .join(", ")
    : "none";
  const outputTextPreview = clipText(payload.output_text ?? "", 400);
  return `OpenAI API returned no structured analysis payload. output=${outputSummary} output_text=${outputTextPreview || "empty"}`;
}

function clipText(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}...`;
}
