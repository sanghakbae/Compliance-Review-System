export type HierarchyType =
  | "document"
  | "chapter"
  | "article"
  | "paragraph"
  | "item"
  | "sub_item";

export interface DocumentSummary {
  id: string;
  title: string;
  document_type: string;
  version_number: number;
  version_id?: string;
  created_at: string;
  effective_date?: string | null;
  section_count: number;
}

export interface LawVersionSummary {
  id: string;
  law_source_id: string;
  source_title: string | null;
  source_link: string;
  version_label: string | null;
  effective_date: string | null;
  created_at: string;
  section_count: number;
}

export interface WorkspaceSelectionSnapshot {
  selectedDocumentId: string | null;
  targetDocumentIds: string[];
  referenceDocumentIds: string[];
  lawVersionIds: string[];
}

export interface WorkspaceFavorite {
  id: string;
  name: string;
  updatedAt: string;
  selection: WorkspaceSelectionSnapshot;
}

export interface OpenAiSettings {
  apiKey: string;
  model: string;
}

export interface SecuritySettings {
  allowedEmailDomain: string;
  sessionIdleTimeoutMinutes: number;
}

export interface ReviewExecutionHistoryEntry {
  id: string;
  createdAt: string;
  reviewerEmail: string;
  targetTitles: string[];
  referenceTitles: string[];
  comparisonRunIds: string[];
  aiReportHistoryId: string | null;
  resultStatus: "pending" | "ai_completed" | "comparison_completed";
}

export interface LawSectionRecord {
  id: string;
  hierarchy_type: HierarchyType;
  hierarchy_label: string;
  hierarchy_order: number;
  original_text: string;
  path_display: string;
  chapter_label?: string | null;
  chapter_text?: string | null;
  article_label?: string | null;
  article_text?: string | null;
  paragraph_label?: string | null;
  paragraph_text?: string | null;
  item_label?: string | null;
  item_text?: string | null;
  sub_item_label?: string | null;
  sub_item_text?: string | null;
}

export interface LawDetail {
  id: string;
  source_title: string | null;
  source_link: string;
  version_label: string | null;
  effective_date: string | null;
  raw_text: string;
  parse_warnings: string[];
  sections: LawSectionRecord[];
}

export interface DocumentSectionRecord {
  id: string;
  hierarchy_type: HierarchyType;
  hierarchy_label: string;
  hierarchy_order: number;
  original_text: string;
  path_display: string;
  chapter_label?: string | null;
  chapter_text?: string | null;
  article_label?: string | null;
  article_text?: string | null;
  paragraph_label?: string | null;
  paragraph_text?: string | null;
  item_label?: string | null;
  item_text?: string | null;
  sub_item_label?: string | null;
  sub_item_text?: string | null;
}

export interface DocumentDetail {
  id: string;
  version_id?: string;
  title: string;
  description: string | null;
  document_type: string;
  version_number: number;
  raw_text: string;
  parse_warnings: string[];
  metadata?: {
    title: string | null;
    revisionDate: string | null;
    documentNotes: string[];
  };
  sections: DocumentSectionRecord[];
}

export type DiffType = "ADDITION" | "DELETION" | "MODIFICATION";
export type RevisionStatus =
  | "REQUIRED"
  | "RECOMMENDED"
  | "NOT_REQUIRED"
  | "LOW_CONFIDENCE_REVIEW";

export interface ComparisonRunSummary {
  id: string;
  created_at: string;
  document_id?: string;
  document_version_id?: string;
  law_version_id?: string;
  policy_title: string;
  policy_version_number: number;
  law_title: string;
  law_version_label: string | null;
  law_effective_date: string | null;
  diff_count: number;
  revision_status: RevisionStatus | null;
  revision_confidence: number | null;
  revision_ai_used: boolean | null;
  human_review_required: boolean | null;
}

export interface ComparisonResultRecord {
  id: string;
  affected_path: string;
  hierarchy_type: HierarchyType;
  match_type: string;
  diff_type: DiffType;
  confidence: number;
  before_text: string;
  after_text: string;
  explanation: string;
  reasoning_trace: string[];
  ai_used: boolean;
}

export interface ComparisonReviewDetail {
  id: string;
  created_at: string;
  warning_messages: string[];
  policy_title: string;
  policy_version_number: number;
  policy_raw_text: string;
  law_title: string;
  law_version_label: string | null;
  law_effective_date: string | null;
  law_raw_text: string;
  revision_decision_id: string | null;
  revision_status: RevisionStatus | null;
  revision_rationale: string | null;
  revision_confidence: number | null;
  revision_ai_used: boolean | null;
  human_review_required: boolean | null;
  results: ComparisonResultRecord[];
}

export interface AggregatedComparisonResultRecord extends ComparisonResultRecord {
  comparison_run_id: string;
  policy_title: string;
  law_title: string;
}

export interface ComparisonReviewAggregate {
  run_ids: string[];
  warning_messages: string[];
  policy_titles: string[];
  law_titles: string[];
  revision_statuses: RevisionStatus[];
  results: AggregatedComparisonResultRecord[];
}

export interface AiRevisionGuidanceItem {
  document_id: string;
  document_title: string;
  target_section_path: string;
  comparison_source_title: string;
  policy_evidence_paths: string[];
  comparison_evidence_paths: string[];
  rationale: string;
  confidence: number;
  suggested_action: string;
}

export interface AiGroupReportDocument {
  document_id: string;
  document_title: string;
  key_points: string[];
  source_paths: string[];
  evidence_pairs?: Array<{
    key_point: string;
    source_path: string;
  }>;
}

export interface AiGroupReportRequirement {
  topic: string;
  detail: string;
  source_titles: string[];
  source_paths: string[];
  notes: string;
  evidence_pairs?: Array<{
    source_title: string;
    source_path: string;
  }>;
}

export interface AiGroupReport {
  summary: string;
  key_findings: string[];
  documents: AiGroupReportDocument[];
  merged_requirements: AiGroupReportRequirement[];
}

export interface AiComparisonGap {
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

export interface AiComparisonCoveredItem {
  topic: string;
  reason: string;
  policy_evidence_paths: string[];
  comparison_evidence_paths: string[];
}

export interface AiComparisonDocumentActionItem {
  priority: string;
  target_section_path: string;
  current_issue: string;
  action: string;
  required_change: string;
  instruction: string;
  draft_revision_text: string;
  rationale: string;
}

export interface AiComparisonDocumentAction {
  document_id: string;
  document_title: string;
  actions: AiComparisonDocumentActionItem[];
}

export interface AiComparisonReport {
  summary: string;
  revision_needed: boolean;
  overall_comment: string;
  gaps: AiComparisonGap[];
  well_covered_items: AiComparisonCoveredItem[];
  document_actions: AiComparisonDocumentAction[];
  low_confidence_notes: string[];
  remaining_watchpoints: string[];
}

export type AiRevisionAnalysisStage = "left" | "right" | "final";

export type PromptSlotList = [string, string, string];
export type PromptSlotIndex = 0 | 1 | 2;

export interface AiRevisionPromptOverrides {
  left: PromptSlotList;
  right: PromptSlotList;
  final: PromptSlotList;
}

export interface AiRevisionGuidance {
  left_group_report: AiGroupReport;
  right_group_report: AiGroupReport;
  comparison_report: AiComparisonReport;
  model: string | null;
  api_call_count: number;
}

export interface AnalysisSelectionCounts {
  leftDocumentCount: number;
  rightDocumentCount: number;
  rightLawCount: number;
}

export interface SavedAnalysisHistoryEntry {
  id: string;
  createdAt: string;
  title: string;
  fileName?: string;
  selectionSummary: string;
  selectionCounts: AnalysisSelectionCounts;
  guidance?: AiRevisionGuidance;
}

export interface AiReportHistoryEntry extends SavedAnalysisHistoryEntry {
  guidance: AiRevisionGuidance;
}

export interface AiReportHistorySummary extends SavedAnalysisHistoryEntry {
  guidance?: undefined;
}

export interface AiRevisionStageResult {
  stage: AiRevisionAnalysisStage;
  left_group_report: AiGroupReport | null;
  right_group_report: AiGroupReport | null;
  comparison_report: AiComparisonReport | null;
  model: string | null;
  api_call_count: number;
}
