/**
 * Firestore data model for the policy-revision-mgmt-system.
 *
 * Translated from the Supabase Postgres schema (supabase/migrations/*). Postgres
 * tables → Firestore collections/subcollections; foreign keys → subcollection
 * paths + reference fields; SQL views → denormalized summary fields.
 *
 * Conventions:
 *  - Document IDs reuse the original Postgres UUIDs during migration (no remap).
 *  - snake_case columns → camelCase fields.
 *  - timestamptz → Firestore Timestamp (stored as Timestamp; typed here as
 *    `FsTimestamp`). `createdAt` is server-set on write.
 *  - jsonb arrays/objects → native arrays/maps.
 *  - Postgres enums → string union types.
 */

import type { Timestamp } from "firebase/firestore";

export type FsTimestamp = Timestamp;

// ---- enums (from public.* Postgres enums) ----
export type DocumentType = "POLICY" | "GUIDELINE";
export type HierarchyType =
  | "document"
  | "chapter"
  | "article"
  | "paragraph"
  | "item"
  | "sub_item";
export type AuditResult = "SUCCESS" | "FAILURE";
export type MatchType = string; // public.match_type — refine from comparison engine
export type DiffType = string; // public.diff_type
export type RevisionStatus = string; // public.revision_status
export type WorkspaceRole = "owner" | "member";

// ---- collection: workspaces/{wsId} ----
export interface WorkspaceDoc {
  name: string;
  ownerUserId: string;
  /** Denormalized member uids for efficient membership checks in rules/queries. */
  memberIds: string[];
  createdAt: FsTimestamp;
}

// workspaces/{wsId}/members/{uid}
export interface WorkspaceMemberDoc {
  role: WorkspaceRole;
  createdAt: FsTimestamp;
}

// ---- collection: documents/{docId} (top-level; workspaceId nullable) ----
export interface DocumentDoc {
  workspaceId: string | null;
  ownerUserId: string;
  title: string;
  description: string | null;
  documentType: DocumentType;
  /** R2 object key: `${ownerUserId}/${docId}/${fileName}`. */
  sourceStoragePath: string;
  sourceFileName: string;
  createdAt: FsTimestamp;
  /** Denormalized latest-version summary (replaces policy_document_latest_versions view). */
  latest?: {
    versionId: string;
    versionNumber: number;
    sectionCount: number;
    effectiveDate: FsTimestamp | null;
    createdAt: FsTimestamp;
  };
}

// documents/{docId}/versions/{verId}
export interface DocumentVersionDoc {
  documentId: string;
  versionNumber: number;
  rawText: string;
  parseWarnings: string[];
  /** add_document_version_effective_date */
  effectiveDate: FsTimestamp | null;
  createdAt: FsTimestamp;
}

// documents/{docId}/versions/{verId}/sections/{secId}
export interface SectionDoc {
  documentVersionId: string;
  parentSectionId: string | null;
  hierarchyType: HierarchyType;
  hierarchyLabel: string;
  hierarchyOrder: number;
  normalizedText: string;
  originalText: string;
  textHash: string;
  pathDisplay: string;
  createdAt: FsTimestamp;
}

// ---- collection: lawSources/{lawId} ----
export interface LawSourceDoc {
  workspaceId: string | null;
  ownerUserId: string;
  sourceLink: string;
  sourceTitle: string | null;
  retrievalTimestamp: FsTimestamp;
  createdAt: FsTimestamp;
}

// lawSources/{lawId}/versions/{verId}
export interface LawVersionDoc {
  lawSourceId: string;
  versionLabel: string | null;
  rawText: string;
  parseWarnings: string[];
  createdAt: FsTimestamp;
}

// lawSources/{lawId}/versions/{verId}/sections/{secId}
export interface LawSectionDoc {
  lawVersionId: string;
  parentSectionId: string | null;
  hierarchyLabel: string;
  hierarchyOrder: number;
  normalizedText: string;
  originalText: string;
  textHash: string;
  pathDisplay: string;
  createdAt: FsTimestamp;
}

// ---- collection: comparisonRuns/{runId} ----
export interface ComparisonRunDoc {
  actorUserId: string;
  sourceDocumentVersionId: string;
  /** Denormalized parent path components so deep subcollection refs are resolvable. */
  sourceDocumentId: string;
  targetLawVersionId: string;
  targetLawSourceId: string;
  warningMessages: string[];
  createdAt: FsTimestamp;
}

// comparisonRuns/{runId}/results/{resultId}
export interface ComparisonResultDoc {
  comparisonRunId: string;
  sourceSectionId: string | null;
  targetSectionId: string | null;
  affectedPath: string;
  hierarchyType: HierarchyType;
  matchType: MatchType;
  diffType: DiffType;
  confidence: number; // 0..1
  beforeText: string;
  afterText: string;
  explanation: string;
  reasoningTrace: unknown[];
  aiUsed: boolean;
  createdAt: FsTimestamp;
}

// comparisonRuns/{runId}/decisions/{decId}
export interface RevisionDecisionDoc {
  comparisonRunId: string;
  status: RevisionStatus;
  rationale: string;
  confidence: number; // 0..1
  aiUsed: boolean;
  humanReviewRequired: boolean;
  modelName: string | null;
  requestPurpose: string | null;
  outputUsedInRecommendation: boolean;
  createdAt: FsTimestamp;
}

// ---- per-user data: users/{uid}/... ----
// users/{uid}/settings/openai  (policy_user_settings)
export interface UserOpenAiSettingsDoc {
  model: string;
  apiCallCount?: number;
  updatedAt: FsTimestamp;
}
// users/{uid}/settings/security (policy_security_settings)
export interface UserSecuritySettingsDoc {
  sessionIdleTimeoutMinutes: number;
  updatedAt: FsTimestamp;
}
// users/{uid}/favorites/{favId} (policy_workspace_favorites)
export interface WorkspaceFavoriteDoc {
  documentId?: string;
  label?: string;
  order: number;
  createdAt: FsTimestamp;
}
// users/{uid}/reviewHistory/{histId} (policy_review_execution_history; keep-latest logic on write)
export interface ReviewExecutionHistoryDoc {
  comparisonRunId: string | null;
  aiReportId: string | null;
  resultStatus: string | null;
  createdAt: FsTimestamp;
}
// users/{uid}/aiReportHistory/{reportId} (policy_ai_report_history)
export interface AiReportHistoryDoc {
  title?: string;
  payload: unknown;
  createdAt: FsTimestamp;
}

// ---- collection: auditLogs/{logId} (append-only) ----
export interface AuditLogDoc {
  actorUserId: string;
  action: string;
  targetDocumentId: string | null;
  result: AuditResult;
  metadata: Record<string, unknown>;
  createdAt: FsTimestamp;
}

/**
 * Collection / document path helpers — single source of truth for paths so
 * documentService and the Workers stay consistent.
 */
export const paths = {
  workspaces: () => "workspaces",
  workspace: (wsId: string) => `workspaces/${wsId}`,
  members: (wsId: string) => `workspaces/${wsId}/members`,
  member: (wsId: string, uid: string) => `workspaces/${wsId}/members/${uid}`,

  documents: () => "documents",
  document: (docId: string) => `documents/${docId}`,
  versions: (docId: string) => `documents/${docId}/versions`,
  version: (docId: string, verId: string) => `documents/${docId}/versions/${verId}`,
  sections: (docId: string, verId: string) =>
    `documents/${docId}/versions/${verId}/sections`,
  section: (docId: string, verId: string, secId: string) =>
    `documents/${docId}/versions/${verId}/sections/${secId}`,

  lawSources: () => "lawSources",
  lawSource: (lawId: string) => `lawSources/${lawId}`,
  lawVersions: (lawId: string) => `lawSources/${lawId}/versions`,
  lawVersion: (lawId: string, verId: string) => `lawSources/${lawId}/versions/${verId}`,
  lawSections: (lawId: string, verId: string) =>
    `lawSources/${lawId}/versions/${verId}/sections`,

  comparisonRuns: () => "comparisonRuns",
  comparisonRun: (runId: string) => `comparisonRuns/${runId}`,
  comparisonResults: (runId: string) => `comparisonRuns/${runId}/results`,
  comparisonDecisions: (runId: string) => `comparisonRuns/${runId}/decisions`,

  user: (uid: string) => `users/${uid}`,
  userOpenAiSettings: (uid: string) => `users/${uid}/settings/openai`,
  userSecuritySettings: (uid: string) => `users/${uid}/settings/security`,
  userFavorites: (uid: string) => `users/${uid}/favorites`,
  userReviewHistory: (uid: string) => `users/${uid}/reviewHistory`,
  userAiReportHistory: (uid: string) => `users/${uid}/aiReportHistory`,

  auditLogs: () => "auditLogs",
} as const;

/** R2 object key scheme, mirroring the Supabase storage path convention. */
export function r2ObjectKey(ownerUserId: string, documentId: string, fileName: string): string {
  return `${ownerUserId}/${documentId}/${fileName}`;
}
