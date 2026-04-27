import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import {
  classifyRevision,
  deleteAiReportHistoryEntry,
  getAiReportHistoryEntry,
  getAggregatedComparisonReview,
  getComparisonReview,
  listAiReportHistory,
  saveAiReportHistoryEntry,
} from "../lib/documentService";
import type {
  AiReportHistoryEntry,
  AiReportHistorySummary,
  AiComparisonReport,
  AiGroupReport,
  AiRevisionGuidance,
  ComparisonReviewAggregate,
  ComparisonReviewDetail,
  OpenAiSettings,
} from "../types";

interface ComparisonReviewPanelProps {
  comparisonRunId: string | null;
  comparisonRunIds?: string[];
  selectedDocumentIds?: string[];
  referenceDocumentIds?: string[];
  selectedLawVersionIds?: string[];
  viewMode?: "results" | "history";
  autoLoadHistoryRequest?: {
    requestId: number;
    aiReportHistoryId?: string | null;
    selectionSummary: string;
    selectionCounts: AiReportHistoryEntry["selectionCounts"];
  } | null;
  setStatus: (value: string) => void;
  onOverviewChange?: (value: ComparisonReviewOverviewSnapshot) => void;
  analysisState: ComparisonReviewAnalysisState;
  openAiSettings?: Partial<OpenAiSettings>;
}

const STAGE_REQUEST_TIMEOUT_MS = 190_000;
export type AnalysisStagePhase =
  | "left"
  | "left-wait"
  | "right"
  | "right-wait"
  | "parallel"
  | "final"
  | "complete"
  | null;

export type ComparisonReviewAnalysisState = {
  aiGuidance: AiRevisionGuidance | null;
  leftGroupReport: AiGroupReport | null;
  rightGroupReport: AiGroupReport | null;
  comparisonReport: AiComparisonReport | null;
  aiAnalysisError: string | null;
  apiCallCount: number;
  isAnalyzingSelection: boolean;
  analysisStageLabel: string | null;
  analysisStagePhase: AnalysisStagePhase;
  analysisStageStartedAt: number | null;
};

export type ComparisonReviewOverviewSnapshot = {
  selectionSummary: string;
  selectionCounts: {
    leftDocumentCount: number;
    rightDocumentCount: number;
    rightLawCount: number;
  };
  apiCallCount: number;
  stageProgress: ReturnType<typeof getStageProgress>;
};

export function ComparisonReviewPanel({
  comparisonRunId,
  comparisonRunIds = [],
  selectedDocumentIds = [],
  referenceDocumentIds = [],
  selectedLawVersionIds = [],
  viewMode = "results",
  autoLoadHistoryRequest = null,
  setStatus,
  onOverviewChange,
  analysisState,
  openAiSettings,
}: ComparisonReviewPanelProps) {
  const emitStatus = useEffectEvent((message: string) => {
    setStatus(message);
  });
  const [detail, setDetail] = useState<ComparisonReviewDetail | null>(null);
  const [aggregate, setAggregate] = useState<ComparisonReviewAggregate | null>(null);
  const [progressNow, setProgressNow] = useState(() => Date.now());
  const [isLoading, setIsLoading] = useState(false);
  const [isClassifying, setIsClassifying] = useState(false);
  const [savedHistory, setSavedHistory] = useState<AiReportHistorySummary[]>([]);
  const [isSavedHistoryLoading, setIsSavedHistoryLoading] = useState(false);
  const [loadedHistoryEntry, setLoadedHistoryEntry] = useState<AiReportHistoryEntry | null>(null);
  const savedHistoryRef = useRef<AiReportHistorySummary[]>([]);
  const savedHistoryLoadPromiseRef = useRef<Promise<AiReportHistorySummary[]> | null>(null);
  const handledAutoLoadRequestIdRef = useRef<number | null>(null);
  const selectionSummary = getSelectionSummary(
    selectedDocumentIds.length,
    referenceDocumentIds.length,
    selectedLawVersionIds.length,
  );
  const selectionCounts = {
    leftDocumentCount: selectedDocumentIds.length,
    rightDocumentCount: referenceDocumentIds.length,
    rightLawCount: selectedLawVersionIds.length,
  };
  const stageProgress = getStageProgress({
    leftGroupReport: analysisState.leftGroupReport,
    rightGroupReport: analysisState.rightGroupReport,
    comparisonReport: analysisState.comparisonReport,
    isAnalyzingSelection: analysisState.isAnalyzingSelection,
    analysisStageLabel: analysisState.analysisStageLabel,
    analysisStagePhase: analysisState.analysisStagePhase,
    analysisStageStartedAt: analysisState.analysisStageStartedAt,
    now: progressNow,
  });

  useEffect(() => {
    if (!analysisState.isAnalyzingSelection || !analysisState.analysisStageStartedAt) {
      return;
    }

    const timer = window.setInterval(() => {
      setProgressNow(Date.now());
    }, 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, [analysisState.analysisStageStartedAt, analysisState.isAnalyzingSelection]);

  function loadSavedHistory() {
    if (savedHistoryLoadPromiseRef.current) {
      return savedHistoryLoadPromiseRef.current;
    }

    setIsSavedHistoryLoading(true);
    savedHistoryLoadPromiseRef.current = listAiReportHistory()
      .then((entries) => {
        savedHistoryRef.current = entries;
        setSavedHistory(entries);
        return entries;
      })
      .finally(() => {
        savedHistoryLoadPromiseRef.current = null;
        setIsSavedHistoryLoading(false);
      });

    return savedHistoryLoadPromiseRef.current;
  }

  useEffect(() => {
    if (viewMode !== "results") {
      return;
    }

    let cancelled = false;
    loadSavedHistory()
      .catch((error: Error) => {
        if (!cancelled) {
          emitStatus(error.message);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [viewMode]);

  useEffect(() => {
    if (viewMode !== "results") {
      return;
    }

    if (analysisState.aiGuidance || loadedHistoryEntry || savedHistory.length === 0) {
      return;
    }

    const bestEntrySummary = findBestHistoryEntry(savedHistory, selectionSummary, selectionCounts);
    if (!bestEntrySummary) {
      return;
    }

    void getAiReportHistoryEntry(bestEntrySummary.id).then((entry) => {
      if (!entry) {
        return;
      }
      setLoadedHistoryEntry(entry);
      emitStatus(`저장된 AI 리포트 이력을 자동으로 불러왔습니다. (${formatSavedHistoryTimestamp(entry.createdAt)})`);
    });
  }, [
    analysisState.aiGuidance,
    emitStatus,
    loadedHistoryEntry,
    savedHistory,
    selectionCounts,
    selectionSummary,
    viewMode,
  ]);

  useEffect(() => {
    if (viewMode !== "history" || !autoLoadHistoryRequest) {
      return;
    }

    if (handledAutoLoadRequestIdRef.current === autoLoadHistoryRequest.requestId) {
      return;
    }
    handledAutoLoadRequestIdRef.current = autoLoadHistoryRequest.requestId;

    let cancelled = false;
    setIsSavedHistoryLoading(true);

    const loadEntry = autoLoadHistoryRequest.aiReportHistoryId
      ? getAiReportHistoryEntry(autoLoadHistoryRequest.aiReportHistoryId)
      : loadSavedHistory().then((entries) => {
          const summary = findExactHistoryEntry(
            entries,
            autoLoadHistoryRequest.selectionSummary,
            autoLoadHistoryRequest.selectionCounts,
          ) ?? entries[0] ?? null;
          return summary ? getAiReportHistoryEntry(summary.id) : null;
        });

    loadEntry
      .then((entry) => {
        if (cancelled) {
          return;
        }

        if (!entry) {
          emitStatus("저장된 AI 리포트 이력이 없습니다.");
          return;
        }

        setLoadedHistoryEntry(entry);
        emitStatus(
          autoLoadHistoryRequest.aiReportHistoryId
            ? `검토 이력에서 연결된 AI 리포트를 불러왔습니다. (${formatSavedHistoryTimestamp(entry.createdAt)})`
            : `정확히 일치하는 AI 리포트가 없어 최신 저장 리포트를 불러왔습니다. (${formatSavedHistoryTimestamp(entry.createdAt)})`,
        );
      })
      .catch((error: Error) => {
        if (!cancelled) {
          emitStatus(error.message);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsSavedHistoryLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [autoLoadHistoryRequest?.requestId, viewMode]);

  useEffect(() => {
    onOverviewChange?.({
      selectionSummary,
      selectionCounts,
      apiCallCount: analysisState.apiCallCount,
      stageProgress,
    });
  }, [analysisState.apiCallCount, onOverviewChange, selectionCounts, selectionSummary, stageProgress]);

  useEffect(() => {
    if (comparisonRunIds.length > 1) {
      setLoadedHistoryEntry(null);
      setIsLoading(true);
      getAggregatedComparisonReview(comparisonRunIds)
        .then((data) => {
          setAggregate(data);
          setDetail(null);
        })
        .catch((error: Error) => {
          emitStatus(error.message);
          setAggregate(null);
          setDetail(null);
        })
        .finally(() => {
          setIsLoading(false);
        });
      return;
    }

    if (!comparisonRunId) {
      setDetail(null);
      setAggregate(null);
      return;
    }

    setLoadedHistoryEntry(null);
    setIsLoading(true);
    getComparisonReview(comparisonRunId)
      .then((data) => {
        setDetail(data);
        setAggregate(null);
      })
      .catch((error: Error) => {
        emitStatus(error.message);
        setDetail(null);
        setAggregate(null);
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, [comparisonRunId, comparisonRunIds]);

  async function handleClassify() {
    if (!comparisonRunId) {
      return;
    }

    setIsClassifying(true);
    setStatus("백엔드 AI 분류기에 개정 권고 생성을 요청하는 중입니다...");

    try {
      await classifyRevision(comparisonRunId, openAiSettings);
      const updated = await getComparisonReview(comparisonRunId);
      setDetail(updated);
      setStatus("개정 권고를 갱신했습니다.");
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "개정 권고 분류에 실패했습니다.",
      );
    } finally {
      setIsClassifying(false);
    }
  }

  async function handleSaveCurrentReport() {
    if (!analysisState.aiGuidance) {
      return;
    }

    try {
      const entry = await saveAiReportHistoryEntry({
        title: buildSavedHistoryTitle(selectionCounts),
        selectionSummary,
        selectionCounts,
        guidance: analysisState.aiGuidance,
      });
      const { guidance: _guidance, ...summaryEntry } = entry;
      setSavedHistory((current) => [summaryEntry, ...current].slice(0, 50));
      emitStatus("현재 AI 비교 리포트를 DB 이력에 저장했습니다.");
    } catch (error) {
      emitStatus(error instanceof Error ? error.message : "AI 리포트 저장에 실패했습니다.");
    }
  }

  async function handleLoadSavedReport(entryId: string) {
    const entry = await getAiReportHistoryEntry(entryId);
    if (!entry) {
      emitStatus("선택한 AI 리포트 이력을 찾지 못했습니다.");
      return;
    }

    setLoadedHistoryEntry(entry);
    setDetail(null);
    setAggregate(null);
    setIsLoading(false);
    emitStatus(`저장된 AI 리포트 이력을 불러왔습니다. (${formatSavedHistoryTimestamp(entry.createdAt)})`);
  }

  async function handleDeleteSavedReport(entryId: string) {
    try {
      await deleteAiReportHistoryEntry(entryId);
      setSavedHistory((current) => current.filter((item) => item.id !== entryId));
      emitStatus("선택한 AI 리포트 이력을 DB에서 삭제했습니다.");
    } catch (error) {
      emitStatus(error instanceof Error ? error.message : "AI 리포트 이력 삭제에 실패했습니다.");
    }
  }

  const hasSelectionContext =
    selectedDocumentIds.length > 0 &&
    (referenceDocumentIds.length > 0 || selectedLawVersionIds.length > 0);
  const overviewSelectionSummary = loadedHistoryEntry?.selectionSummary ?? selectionSummary;
  const overviewSelectionCounts = loadedHistoryEntry?.selectionCounts ?? selectionCounts;
  const shouldShowHistory = viewMode === "history";
  const shouldShowResults = viewMode === "results" || loadedHistoryEntry !== null;
  const displayedGuidance = loadedHistoryEntry?.guidance ?? analysisState.aiGuidance;
  const displayedLeftGroupReport = loadedHistoryEntry?.guidance.left_group_report ?? analysisState.leftGroupReport;
  const displayedRightGroupReport = loadedHistoryEntry?.guidance.right_group_report ?? analysisState.rightGroupReport;
  const displayedComparisonReport =
    loadedHistoryEntry?.guidance.comparison_report ?? analysisState.comparisonReport;
  const displayedApiCallCount = loadedHistoryEntry?.guidance.api_call_count ?? analysisState.apiCallCount;
  const displayedAnalysisStageLabel =
    loadedHistoryEntry ? "저장된 이력을 불러왔습니다." : analysisState.analysisStageLabel;
  const displayedAiAnalysisError = loadedHistoryEntry ? null : analysisState.aiAnalysisError;
  const displayedIsAnalyzingSelection = loadedHistoryEntry ? false : analysisState.isAnalyzingSelection;

  if (loadedHistoryEntry) {
    return (
      <div className="stack comparison-review-shell">
        {shouldShowHistory ? (
          <SavedAnalysisHistorySection
            entries={savedHistory}
            onLoad={handleLoadSavedReport}
            onDelete={handleDeleteSavedReport}
          />
        ) : null}
        <div className="info-card comparison-history-loaded-card">
          <div className="comparison-history-loaded-main">
            <span className="muted-label">저장된 리포트</span>
            <strong>{loadedHistoryEntry.title}</strong>
            <p className="helper-text detailed-empty-reason">
              저장 시각 {formatSavedHistoryTimestamp(loadedHistoryEntry.createdAt)}
            </p>
          </div>
          <button
            type="button"
            className="button ghost"
            onClick={() => {
              setLoadedHistoryEntry(null);
            }}
          >
            이력 닫기
          </button>
        </div>
        <AiGuidancePanel
          guidance={displayedGuidance}
          leftGroupReport={displayedLeftGroupReport}
          rightGroupReport={displayedRightGroupReport}
          comparisonReport={displayedComparisonReport}
          error={displayedAiAnalysisError}
          isLoading={displayedIsAnalyzingSelection}
          analysisStageLabel={displayedAnalysisStageLabel}
          apiCallCount={displayedApiCallCount}
          className="ai-guidance-offset"
          onSaveCurrentReport={handleSaveCurrentReport}
          isHistoryView={shouldShowHistory}
        />
      </div>
    );
  }

  if (!shouldShowHistory && !comparisonRunId && comparisonRunIds.length === 0 && !hasSelectionContext) {
    return (
      <div className="stack comparison-review-shell">
        <AiGuidancePanel
          guidance={displayedGuidance}
          leftGroupReport={displayedLeftGroupReport}
          rightGroupReport={displayedRightGroupReport}
          comparisonReport={displayedComparisonReport}
          error={displayedAiAnalysisError}
          isLoading={displayedIsAnalyzingSelection}
          analysisStageLabel={displayedAnalysisStageLabel}
          apiCallCount={displayedApiCallCount}
          className="ai-guidance-offset"
          onSaveCurrentReport={handleSaveCurrentReport}
          isHistoryView={shouldShowHistory}
        />
      </div>
    );
  }

  if (shouldShowHistory && loadedHistoryEntry === null) {
    return (
      <div className="stack comparison-review-shell">
        <div className="section-header comparison-review-header">
          <h2>AI 리포트 이력</h2>
          <p>저장된 AI 비교 리포트를 다시 열거나 삭제할 수 있습니다.</p>
        </div>
        <SavedAnalysisHistorySection
          entries={savedHistory}
          isLoading={isSavedHistoryLoading}
          onLoad={handleLoadSavedReport}
          onDelete={handleDeleteSavedReport}
        />
      </div>
    );
  }

  if ((!detail && !aggregate) && isLoading) {
    return (
      <div className="empty-state">
        <strong>비교 검토 데이터를 불러오는 중입니다...</strong>
      </div>
    );
  }

  if (aggregate) {
    return (
      <div className="stack comparison-review-shell">
        <div className="section-header comparison-review-header">
          <h2>{shouldShowHistory ? "이력 관리" : "검토 결과"}</h2>
          <p>선택된 정책·지침과 지정된 법령을 한 묶음으로 분석한 종합 결과입니다.</p>
        </div>
        {shouldShowHistory ? (
          <SavedAnalysisHistorySection
            entries={savedHistory}
            isLoading={isSavedHistoryLoading}
            onLoad={handleLoadSavedReport}
            onDelete={handleDeleteSavedReport}
          />
        ) : null}
        {isLoading ? (
          <div className="info-card">
            <span className="muted-label">로딩 상태</span>
            <strong>선택된 비교 결과를 다시 불러오는 중입니다.</strong>
          </div>
        ) : null}
        <div className="comparison-summary-strip">
          <div className="info-card comparison-summary-box comparison-summary-box-policy">
            <span className="muted-label">선택 정책 및 지침</span>
            <strong>{aggregate.policy_titles.length}건</strong>
          </div>
          <div className="comparison-summary-vs">VS</div>
          <div className="info-card comparison-summary-box comparison-summary-box-law">
            <span className="muted-label">법령</span>
            <strong>{aggregate.law_titles.join(", ")}</strong>
          </div>
          <div className="info-card comparison-summary-box comparison-summary-box-api">
            <span className="muted-label">OpenAI API 호출</span>
            <strong>{displayedApiCallCount}건</strong>
          </div>
        </div>

        {aggregate.warning_messages.length > 0 ? (
          <div className="warning-card detail-card">
            <strong>비교 경고</strong>
            <div className="stack">
              {aggregate.warning_messages.map((warning) => {
                const detail = describeComparisonWarning(warning);
                return (
                  <div key={warning} className="warning-detail-item">
                    <div className="pill-row">
                      <span className={`pill ${detail.tone}`}>{detail.label}</span>
                    </div>
                    <strong>{detail.title}</strong>
                    <p className="helper-text detailed-empty-reason">{detail.impact}</p>
                    <p className="helper-text detailed-empty-reason">권장 조치: {detail.action}</p>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        {shouldShowResults ? (
          <AiGuidancePanel
            guidance={displayedGuidance}
            leftGroupReport={displayedLeftGroupReport}
            rightGroupReport={displayedRightGroupReport}
            comparisonReport={displayedComparisonReport}
            error={displayedAiAnalysisError}
            isLoading={displayedIsAnalyzingSelection}
            analysisStageLabel={displayedAnalysisStageLabel}
            apiCallCount={displayedApiCallCount}
            className="ai-guidance-offset"
            onSaveCurrentReport={handleSaveCurrentReport}
            isHistoryView={shouldShowHistory}
          />
        ) : null}
      </div>
    );
  }

  if (!detail) {
    if (shouldShowHistory) {
      return (
        <div className="empty-state">
          <strong>비교 검토 데이터를 찾지 못했습니다.</strong>
        </div>
      );
    }

    return (
      <div className="stack comparison-review-shell">
        <AiGuidancePanel
          guidance={displayedGuidance}
          leftGroupReport={displayedLeftGroupReport}
          rightGroupReport={displayedRightGroupReport}
          comparisonReport={displayedComparisonReport}
          error={displayedAiAnalysisError}
          isLoading={displayedIsAnalyzingSelection}
          analysisStageLabel={displayedAnalysisStageLabel}
          apiCallCount={displayedApiCallCount}
          className="ai-guidance-offset"
          onSaveCurrentReport={handleSaveCurrentReport}
          isHistoryView={shouldShowHistory}
        />
      </div>
    );
  }

  const detailData = detail;

  return (
    <div className="stack comparison-review-shell">
      <div className="section-header comparison-review-header">
        <h2>{shouldShowHistory ? "이력 관리" : "검토 결과"}</h2>
        <p>
          법령 변경에 따라 현행 정책을 개정해야 하는지 검토하기 위한 결과만 표시합니다.
        </p>
      </div>
      {shouldShowHistory ? (
        <SavedAnalysisHistorySection
          entries={savedHistory}
          isLoading={isSavedHistoryLoading}
          onLoad={handleLoadSavedReport}
          onDelete={handleDeleteSavedReport}
        />
      ) : null}
      {isLoading ? (
        <div className="info-card">
          <span className="muted-label">로딩 상태</span>
          <strong>선택된 비교 결과를 다시 불러오는 중입니다.</strong>
        </div>
      ) : null}
      <div className="meta-grid comparison-meta-grid">
        <div className="info-card">
          <span className="muted-label">정책 문서</span>
          <strong>{detailData.policy_title}</strong>
          <p className="helper-text">버전 {detailData.policy_version_number}</p>
        </div>
        <div className="info-card">
          <span className="muted-label">법령 문서</span>
          <strong>{detailData.law_title}</strong>
          <p className="helper-text">
            {detailData.law_version_label ?? "버전 정보 없음"}
            {detailData.law_effective_date ? ` · ${detailData.law_effective_date}` : ""}
          </p>
        </div>
        <div className="info-card">
          <span className="muted-label">개정 권고</span>
          <strong>{toRevisionStatusLabel(detailData.revision_status) ?? "아직 분류되지 않음"}</strong>
          <p className="helper-text">
            {detailData.revision_confidence !== null
              ? `신뢰도 ${Math.round(detailData.revision_confidence * 100)}%`
              : "AI 권고가 아직 없습니다"}
          </p>
        </div>
      </div>

      <div className="section-header inline-header">
        <div>
          <h3>개정 검토 결과</h3>
          <p>정책 개정 필요 여부와 가이드만 표시합니다.</p>
        </div>
        <button
          className="button secondary"
          onClick={handleClassify}
          disabled={isClassifying}
          type="button"
        >
          {isClassifying ? "분류 중..." : "권고 다시 생성"}
        </button>
      </div>

      <div className="recommendation-card">
        <div className="pill-row">
          <span className={`pill ${getStatusTone(detailData.revision_status)}`}>
            {toRevisionStatusLabel(detailData.revision_status) ?? "미분류"}
          </span>
          <span className="pill neutral">
            {detailData.revision_confidence !== null
              ? `신뢰도 ${Math.round(detailData.revision_confidence * 100)}%`
              : "신뢰도 대기"}
          </span>
          <span className="pill neutral">
            {detailData.revision_ai_used ? "AI 설명 사용" : "결정론 결과만 사용"}
          </span>
        </div>
        <p className="recommendation-copy">
          {detailData.revision_rationale ??
            "이 비교 실행에 대해 아직 저장된 개정 권고가 없습니다."}
        </p>
        <p className="helper-text">
          사람 검토 필요 여부: {detailData.human_review_required ? "예" : "아니오"}
        </p>
      </div>

      {detailData.warning_messages.length > 0 ? (
        <div className="warning-card detail-card">
          <strong>비교 경고</strong>
          <div className="stack">
            {detailData.warning_messages.map((warning) => {
              const detail = describeComparisonWarning(warning);
              return (
                <div key={warning} className="warning-detail-item">
                  <div className="pill-row">
                    <span className={`pill ${detail.tone}`}>{detail.label}</span>
                  </div>
                  <strong>{detail.title}</strong>
                  <p className="helper-text detailed-empty-reason">{detail.impact}</p>
                  <p className="helper-text detailed-empty-reason">권장 조치: {detail.action}</p>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {shouldShowResults ? (
        <AiGuidancePanel
          guidance={displayedGuidance}
          leftGroupReport={displayedLeftGroupReport}
          rightGroupReport={displayedRightGroupReport}
          comparisonReport={displayedComparisonReport}
          error={displayedAiAnalysisError}
          isLoading={displayedIsAnalyzingSelection}
          analysisStageLabel={displayedAnalysisStageLabel}
          apiCallCount={displayedApiCallCount}
          className="ai-guidance-offset"
          onSaveCurrentReport={handleSaveCurrentReport}
          isHistoryView={shouldShowHistory}
        />
      ) : null}
    </div>
  );
}

function AiGuidancePanel(input: {
  guidance: AiRevisionGuidance | null;
  leftGroupReport: AiGroupReport | null;
  rightGroupReport: AiGroupReport | null;
  comparisonReport: AiComparisonReport | null;
  error: string | null;
  isLoading: boolean;
  analysisStageLabel: string | null;
  apiCallCount: number;
  className?: string;
  onSaveCurrentReport: () => void;
  isHistoryView?: boolean;
}) {
  const [collapsedSections, setCollapsedSections] = useState({
    left: false,
    right: false,
    final: false,
  });
  const resultColumnTemplate = [
    collapsedSections.left ? "92px" : "minmax(0, 1fr)",
    collapsedSections.right ? "92px" : "minmax(0, 1fr)",
    collapsedSections.final ? "92px" : "minmax(0, 1fr)",
  ].join(" ");

  return (
    <section className={`review-column comparison-ai-shell ${input.className ?? ""}`.trim()}>
      <div className="comparison-result-columns" style={{ gridTemplateColumns: resultColumnTemplate }}>
        <GroupReportSection
          collapsedClassName={collapsedSections.left ? "is-collapsed" : ""}
          collapsed={collapsedSections.left}
          onToggleCollapse={() =>
            setCollapsedSections((current) => ({ ...current, left: !current.left }))
          }
          stepLabel="1단계"
          frameClassName="comparison-review-stage-frame-step-1"
          title="비교 대상 정리"
          description="비교 대상 문서를 통합 정리합니다."
          summary={input.leftGroupReport?.summary ?? "비교 대상 리포트를 생성하면 여기에 결과가 표시됩니다."}
          keyFindings={input.leftGroupReport?.key_findings ?? []}
          documents={(input.leftGroupReport?.documents ?? []).map((item) => ({
            id: `left-document-${item.document_id}`,
            title: item.document_title,
            evidencePairs: normalizeDocumentEvidencePairs(item),
          }))}
          requirements={(input.leftGroupReport?.merged_requirements ?? []).map((item, index) => ({
            id: `left-requirement-${index}-${item.topic}`,
            topic: item.topic,
            detail: item.detail,
            evidencePairs: normalizeRequirementEvidencePairs(item),
            notes: item.notes,
          }))}
          isHistoryView={input.isHistoryView}
        />
        <GroupReportSection
          collapsedClassName={collapsedSections.right ? "is-collapsed" : ""}
          collapsed={collapsedSections.right}
          onToggleCollapse={() =>
            setCollapsedSections((current) => ({ ...current, right: !current.right }))
          }
          stepLabel="2단계"
          frameClassName="comparison-review-stage-frame-step-2"
          title="기준 정리"
          description="기준 문서·법률 묶음을 기준 요구사항으로 정리합니다."
          summary={input.rightGroupReport?.summary ?? "기준 리포트를 생성하면 여기에 결과가 표시됩니다."}
          keyFindings={input.rightGroupReport?.key_findings ?? []}
          documents={(input.rightGroupReport?.documents ?? []).map((item) => ({
            id: `right-document-${item.document_id}`,
            title: item.document_title,
            evidencePairs: normalizeDocumentEvidencePairs(item),
          }))}
          requirements={(input.rightGroupReport?.merged_requirements ?? []).map((item, index) => ({
            id: `right-requirement-${index}-${item.topic}`,
            topic: item.topic,
            detail: item.detail,
            evidencePairs: normalizeRequirementEvidencePairs(item),
            notes: item.notes,
          }))}
          isHistoryView={input.isHistoryView}
        />
        <ComparisonReportSection
          collapsedClassName={collapsedSections.final ? "is-collapsed" : ""}
          collapsed={collapsedSections.final}
          onToggleCollapse={() =>
            setCollapsedSections((current) => ({ ...current, final: !current.final }))
          }
          stepLabel="3단계"
          frameClassName="comparison-review-stage-frame-step-3"
          title="최종 비교 리포트"
          description="좌우 정리본을 비교해 개정 포인트를 도출합니다."
          guidance={input.comparisonReport}
          apiCallCount={input.apiCallCount}
          model={input.guidance?.model ?? "미기록"}
          analysisStageLabel={input.error ?? input.analysisStageLabel}
          isHistoryView={input.isHistoryView}
        />
      </div>
    </section>
  );
}

function SavedAnalysisHistorySection(input: {
  entries: AiReportHistorySummary[];
  isLoading?: boolean;
  onLoad: (entryId: string) => void;
  onDelete: (entryId: string) => void;
}) {
  const [page, setPage] = useState(1);
  const pageSize = 5;
  const totalPages = Math.max(1, Math.ceil(input.entries.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageEntries = input.entries.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  useEffect(() => {
    setPage((current) => Math.min(current, Math.max(1, Math.ceil(input.entries.length / pageSize))));
  }, [input.entries.length]);

  return (
    <section className="review-column comparison-history-shell">
      {input.isLoading ? (
        <div className="info-card">
          <strong>저장된 AI 리포트 이력을 불러오는 중입니다.</strong>
          <p className="helper-text detailed-empty-reason">잠시 후 선택한 검토 이력의 리포트를 바로 표시합니다.</p>
        </div>
      ) : input.entries.length === 0 ? (
        <div className="info-card">
          <strong>저장된 AI 리포트 이력이 없습니다.</strong>
          <p className="helper-text detailed-empty-reason">AI 비교 결과가 생성되면 `결과 저장`으로 보관할 수 있습니다.</p>
        </div>
      ) : (
        <div className="stack">
          <div className="ai-report-history-list">
            {pageEntries.map((entry) => (
              <article key={entry.id} className="ai-report-history-item">
                <div className="ai-report-history-main">
                  <span className="muted-label">{formatSavedHistoryTimestamp(entry.createdAt)}</span>
                  <strong>{entry.title}</strong>
                  <p>{entry.selectionSummary}</p>
                </div>
                <div className="ai-report-history-meta">
                  <span>대상 {entry.selectionCounts.leftDocumentCount}</span>
                  <span>기준 {entry.selectionCounts.rightDocumentCount + entry.selectionCounts.rightLawCount}</span>
                  <span>호출 열람 시 확인</span>
                </div>
                <div className="ai-report-history-actions">
                  <button type="button" className="button ghost" onClick={() => input.onLoad(entry.id)}>
                    열기
                  </button>
                  <button type="button" className="button ghost" onClick={() => input.onDelete(entry.id)}>
                    삭제
                  </button>
                </div>
              </article>
            ))}
          </div>
          {totalPages > 1 ? (
            <div className="comparison-history-pagination">
              {Array.from({ length: totalPages }, (_, index) => index + 1).map((pageNumber) => (
                <button
                  key={pageNumber}
                  type="button"
                  className={`button ghost comparison-history-page-button ${pageNumber === currentPage ? "is-active" : ""}`}
                  onClick={() => setPage(pageNumber)}
                >
                  {pageNumber}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

type GuidanceItem = {
  id: string;
  title: string;
  priority: string;
  changeType: string;
  targetPath: string;
  targetPathReason: string;
  comparisonSourceTitle: string;
  policyEvidence: string[];
  comparisonEvidence: string[];
  action: string;
  actionInstruction: string;
  actionExample: string;
  confidence: number;
  reason: string;
};

type GroupDocumentItem = {
  id: string;
  title: string;
  evidencePairs: Array<{
    keyPoint: string;
    sourcePath: string;
  }>;
};

type GroupRequirementItem = {
  id: string;
  topic: string;
  detail: string;
  evidencePairs: Array<{
    sourceTitle: string;
    sourcePath: string;
  }>;
  notes: string;
};

function GroupReportSection(input: {
  collapsedClassName?: string;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  stepLabel: string;
  frameClassName?: string;
  title: string;
  description: string;
  summary: string;
  keyFindings: string[];
  documents: GroupDocumentItem[];
  requirements: GroupRequirementItem[];
  isHistoryView?: boolean;
}) {
  const documentRows = buildDocumentRows(input.documents);
  const requirementRows = buildRequirementRows(input.requirements);
  return (
    <section
      className={`review-column comparison-source-column comparison-review-stage-frame comparison-report-block ${input.frameClassName ?? ""} ${input.collapsedClassName ?? ""}`.trim()}
    >
      <div className="section-header comparison-frame-header comparison-stage-frame-header">
        <div className="comparison-stage-frame-head">
          <div className="comparison-stage-frame-title-row">
            {!input.collapsed ? <h3>{input.title}</h3> : null}
            <span className="comparison-report-stage-step">{input.stepLabel}</span>
          </div>
          <button
            type="button"
            className="button ghost comparison-section-toggle"
            onClick={input.onToggleCollapse}
          >
            {input.collapsed ? "펼치기" : "접기"}
          </button>
        </div>
        {input.isHistoryView ? (
          <button
            type="button"
            className="button ghost"
            onClick={() =>
              downloadCsv(
                `${input.title}.csv`,
                ["구분", "문서/주제", "핵심 내용", "근거 문서", "근거 경로", "비고"],
                [
                  ["요약", input.title, input.summary, "", "", ""],
                  ...input.keyFindings.map((item) => ["핵심 정리", input.title, item, "", "", ""]),
                  ...documentRows.map((row) => ["문서별 정리", row[0], row[1], "", row[2], ""]),
                  ...requirementRows.map((row) => ["통합 요구사항", row[0], row[1], row[2], row[3], row[4]]),
                ],
              )
            }
          >
            CSV 내보내기
          </button>
        ) : null}
        {!input.collapsed ? <p>{input.description}</p> : null}
      </div>
      {!input.collapsed ? (
        <>
          <SummarySection summary={input.summary} emptyText="요약이 없습니다." />
          <ReportTableSection
            title="핵심 정리"
            columns={["번호", "내용"]}
            rows={input.keyFindings.map((item, index) => [String(index + 1), item])}
            emptyText="핵심 정리 항목이 없습니다."
            leftAlignValues={input.isHistoryView}
          />
          <section className="review-column">
            <div className="section-header compact-section-header">
              <h3>{`${input.title} 문서별 정리`}</h3>
            </div>
            <ReportTableSection
              title=""
              columns={["문서", "핵심 정리", "근거 경로"]}
              rows={documentRows}
              emptyText="문서별 정리 항목이 없습니다."
              hideTitle
              leftAlignValues={input.isHistoryView}
            />
          </section>
          <section className="review-column">
            <div className="section-header compact-section-header">
              <h3>{`${input.title} 통합 요구사항`}</h3>
            </div>
            <ReportTableSection
              title=""
              columns={["주제", "내용", "출처 문서", "근거 경로", "비고"]}
              rows={requirementRows}
              emptyText="통합 요구사항이 없습니다."
              hideTitle
              leftAlignValues={input.isHistoryView}
            />
          </section>
        </>
      ) : null}
    </section>
  );
}

function ComparisonReportSection(input: {
  collapsedClassName?: string;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  stepLabel: string;
  frameClassName?: string;
  title: string;
  description: string;
  guidance: AiComparisonReport | null;
  apiCallCount: number;
  model: string;
  analysisStageLabel: string | null;
  isHistoryView?: boolean;
}) {
  const report = input.guidance;

  return (
    <section
      className={`review-column comparison-source-column comparison-review-stage-frame comparison-report-block ${input.frameClassName ?? ""} ${input.collapsedClassName ?? ""}`.trim()}
    >
      <div className="section-header comparison-frame-header comparison-stage-frame-header">
        <div className="comparison-stage-frame-head">
          <div className="comparison-stage-frame-title-row">
            {!input.collapsed ? <h3>{input.title}</h3> : null}
            <span className="comparison-report-stage-step">{input.stepLabel}</span>
          </div>
          <button
            type="button"
            className="button ghost comparison-section-toggle"
            onClick={input.onToggleCollapse}
          >
            {input.collapsed ? "펼치기" : "접기"}
          </button>
        </div>
        {input.isHistoryView ? (
          <button
            type="button"
            className="button ghost"
            onClick={() =>
              downloadCsv(
                `${input.title}.csv`,
                ["구분", "주제/문서", "수정 위치", "무엇을 수정", "어떻게 수정", "예시 문안", "기준 요구사항", "현재 상태/문제", "위험/근거"],
                [
                  ["요약", input.title, "", report?.summary ?? "", report?.overall_comment ?? "", "", "", "", ""],
                  ...(report?.gaps ?? []).map((item) => [
                    "개정 필요 항목",
                    `${item.topic} / ${item.target_document_title}`,
                    item.target_section_path,
                    item.recommended_revision,
                    item.revision_instruction,
                    item.revision_example,
                    item.right_requirement,
                    item.left_current_state,
                    item.risk,
                  ]),
                  ...(report?.document_actions ?? []).flatMap((item) =>
                    item.actions.map((action) => [
                      "문서별 조치",
                      item.document_title,
                      action.target_section_path,
                      action.required_change,
                      action.instruction,
                      action.draft_revision_text,
                      action.action,
                      action.current_issue,
                      action.rationale,
                    ]),
                  ),
                  ...(report?.well_covered_items ?? []).map((item) => [
                    "이미 충분히 반영된 항목",
                    item.topic,
                    "",
                    item.reason,
                    "",
                    "",
                    joinListForCell(item.comparison_evidence_paths),
                    joinListForCell(item.policy_evidence_paths),
                    "",
                  ]),
                  ...(report?.remaining_watchpoints ?? []).map((item) => ["남은 관찰 포인트", item, "", "", "", "", "", "", ""]),
                  ...(report?.low_confidence_notes ?? []).map((item) => ["저신뢰 메모", item, "", "", "", "", "", "", ""]),
                ],
              )
            }
          >
            CSV 내보내기
          </button>
        ) : null}
        {!input.collapsed ? <p>{input.description}</p> : null}
      </div>
      {!input.collapsed ? (
        <>
          <SummarySection
            summary={report?.summary ?? "비교 대상/기준 정리가 끝난 뒤 최종 비교 리포트를 생성합니다."}
            emptyText="요약이 없습니다."
          />
          <GuidanceSection
            title="개정 필요 항목"
            emptyText="개정 필요 항목이 없습니다."
            emptyReason={
              report
                ? "오른쪽 기준 대비 즉시 보완이 필요한 차이를 특정하지 못했습니다."
                : "최종 비교 단계가 아직 완료되지 않았습니다."
            }
            items={(report?.gaps ?? []).map((item, index) => ({
              id: `gap-${index}-${item.topic}`,
              title: `${item.topic} · ${item.target_document_title}`,
              priority: item.priority,
              changeType: item.gap_type,
              targetPath: item.target_section_path,
              targetPathReason: item.target_section_reason,
              comparisonSourceTitle: item.comparison_source_title,
              policyEvidence: item.policy_evidence_paths,
              comparisonEvidence: item.comparison_evidence_paths,
              action: item.recommended_revision,
              actionInstruction: item.revision_instruction,
              actionExample: item.revision_example,
              confidence: item.confidence,
              reason: `${item.gap_type} | 우선순위: ${item.priority}\n기준 요구사항: ${item.right_requirement}\n현재 상태: ${item.left_current_state}\n위험: ${item.risk}`,
            }))}
            leftAlignValues={input.isHistoryView}
          />
          <ReportTableSection
            title="이미 충분히 반영된 항목"
            columns={["주제", "판단", "정책 근거", "기준 근거"]}
            rows={(report?.well_covered_items ?? []).map((item) => [
              item.topic,
              item.reason,
              joinListForCell(item.policy_evidence_paths),
              joinListForCell(item.comparison_evidence_paths),
            ])}
            emptyText="이미 충분히 반영된 항목이 없습니다."
            leftAlignValues={input.isHistoryView}
          />
          <ReportTableSection
            title="남은 관찰 포인트"
            columns={["번호", "내용"]}
            rows={(report?.remaining_watchpoints ?? []).map((item, index) => [String(index + 1), item])}
            emptyText="남은 관찰 포인트가 없습니다."
            leftAlignValues={input.isHistoryView}
          />
          <ReportTableSection
            title="저신뢰 메모"
            columns={["번호", "내용"]}
            rows={(report?.low_confidence_notes ?? []).map((item, index) => [String(index + 1), item])}
            emptyText="저신뢰 메모가 없습니다."
            leftAlignValues={input.isHistoryView}
          />
          <ReportTableSection
            title="문서별 조치"
            columns={["문서", "조치"]}
            rows={(report?.document_actions ?? []).flatMap((item) =>
              item.actions
                .filter((action) => hasVisibleDocumentAction(action))
                .map((action, index) => [
                index === 0 ? item.document_title : "",
                [
                  `${action.priority}|${action.action}|${action.target_section_path}`,
                  `문제: ${action.current_issue}`,
                  `필수 변경: ${action.required_change}`,
                  `수정 지시: ${action.instruction}`,
                  `예시 문안: ${action.draft_revision_text}`,
                  `근거: ${action.rationale}`,
                ].join("\n"),
              ]),
            )}
            emptyText="문서별 조치가 없습니다."
            leftAlignValues={input.isHistoryView}
            renderRow={(row, index) => {
              const actionText = String(row[1] ?? "");
              const [headline = "", ...detailLines] = actionText.split("\n");
              const [priority = "-", action = "-", targetPath = ""] = headline.split("|");
              return [
                row[0],
                <div className="comparison-action-cell" key={`action-${index}`}>
                  <div className="pill-row">
                    <span className={`pill ${getPriorityTone(priority)}`}>{priority}</span>
                    <span className={`pill ${getChangeTypeTone(action)}`}>{action}</span>
                  </div>
                  <div className="comparison-action-path">{targetPath}</div>
                  <div className="comparison-action-body">{detailLines.join("\n")}</div>
                </div>,
              ];
            }}
          />
        </>
      ) : null}
    </section>
  );
}

function runStageWithTimeout<T>(label: string, promise: Promise<T>) {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      window.setTimeout(() => {
        reject(new Error(`${label} 응답이 ${Math.round(STAGE_REQUEST_TIMEOUT_MS / 1000)}초를 넘겨 지연되고 있습니다.`));
      }, STAGE_REQUEST_TIMEOUT_MS);
    }),
  ]);
}

function formatSavedHistoryTimestamp(value: string) {
  try {
    return new Date(value).toLocaleString("ko-KR", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return value;
  }
}

function buildSavedHistoryTitle(selectionCounts: AiReportHistoryEntry["selectionCounts"]) {
  return `비교 대상 ${selectionCounts.leftDocumentCount}건 · 기준 문서 ${selectionCounts.rightDocumentCount}건 · 법령 ${selectionCounts.rightLawCount}건`;
}

type AiReportHistoryMatchCandidate = Pick<
  AiReportHistorySummary,
  "id" | "selectionSummary" | "selectionCounts" | "createdAt"
>;

function findBestHistoryEntry(
  entries: AiReportHistoryMatchCandidate[],
  selectionSummary: string,
  selectionCounts: AiReportHistoryEntry["selectionCounts"],
) {
  const exactMatch = findExactHistoryEntry(entries, selectionSummary, selectionCounts);

  return exactMatch ?? entries[0] ?? null;
}

function findExactHistoryEntry(
  entries: AiReportHistoryMatchCandidate[],
  selectionSummary: string,
  selectionCounts: AiReportHistoryEntry["selectionCounts"],
) {
  return entries.find((entry) =>
    entry.selectionSummary === selectionSummary &&
    entry.selectionCounts.leftDocumentCount === selectionCounts.leftDocumentCount &&
    entry.selectionCounts.rightDocumentCount === selectionCounts.rightDocumentCount &&
    entry.selectionCounts.rightLawCount === selectionCounts.rightLawCount,
  ) ?? null;
}

export function getStageProgress(input: {
  leftGroupReport: AiGroupReport | null;
  rightGroupReport: AiGroupReport | null;
  comparisonReport: AiComparisonReport | null;
  isAnalyzingSelection: boolean;
  analysisStageLabel: string | null;
  analysisStagePhase: AnalysisStagePhase;
  analysisStageStartedAt: number | null;
  now: number;
}) {
  const steps = [
    {
      id: "left",
      label: "1단계",
      status: input.leftGroupReport ? "done" : input.isAnalyzingSelection ? "active" : "idle",
      statusLabel: input.leftGroupReport ? "완료" : input.isAnalyzingSelection ? "진행 중" : "대기",
      percent: input.leftGroupReport ? 100 : 0,
    },
    {
      id: "right",
      label: "2단계",
      status: input.rightGroupReport
        ? "done"
        : input.isAnalyzingSelection && input.analysisStagePhase === "right"
          ? "active"
          : "idle",
      statusLabel: input.rightGroupReport
        ? "완료"
        : input.isAnalyzingSelection && input.analysisStagePhase === "right"
          ? "진행 중"
          : "대기",
      percent: input.rightGroupReport ? 100 : 0,
    },
    {
      id: "final",
      label: "3단계",
      status: input.comparisonReport
        ? "done"
        : input.rightGroupReport && input.isAnalyzingSelection
          ? "active"
          : "idle",
      statusLabel: input.comparisonReport
        ? "완료"
        : input.rightGroupReport && input.isAnalyzingSelection
          ? "진행 중"
          : "대기",
      percent: input.comparisonReport ? 100 : 0,
    },
  ] as const;

  if (input.comparisonReport) {
    return {
      label: "최종 비교 완료",
      detail: "비교 대상 정리, 기준 정리, 최종 비교 리포트가 모두 채워졌습니다.",
      percent: 100,
      steps,
    };
  }

  if (input.rightGroupReport) {
    return {
      label: input.isAnalyzingSelection ? "최종 비교 진행 중" : "기준 정리 완료",
      detail:
        input.analysisStageLabel ?? "기준 정리가 끝났고 최종 비교 리포트를 준비하고 있습니다.",
      percent: input.isAnalyzingSelection ? 66 : 66,
      steps,
    };
  }

  if (input.leftGroupReport) {
    return {
      label: input.isAnalyzingSelection ? "기준 정리 진행 중" : "비교 대상 정리 완료",
      detail:
        input.analysisStageLabel ?? "비교 대상 정리가 끝났고 기준 정리를 준비하고 있습니다.",
      percent: input.rightGroupReport ? 66 : 33,
      steps,
    };
  }

  if (input.isAnalyzingSelection) {
    return {
      label: "비교 대상 정리 진행 중",
      detail: input.analysisStageLabel ?? "단계 리포트를 생성하고 있습니다.",
      percent: 0,
      steps,
    };
  }

  return {
    label: "실행 대기",
    detail: "좌우 그룹 비교 실행 후 단계별 리포트가 순차적으로 채워집니다.",
    percent: 0,
    steps,
  };
}

function GuidanceSection(input: {
  title: string;
  emptyText: string;
  emptyReason: string;
  items: GuidanceItem[];
  leftAlignValues?: boolean;
}) {
  return (
    <section className="review-column">
      <div className="section-header">
        <h3>{input.title}</h3>
      </div>
      {input.items.length === 0 ? (
        <ReportTableSection
          title=""
          columns={["상태", "내용"]}
          rows={[["안내", `${input.emptyText}\n${input.emptyReason}`]]}
          emptyText={input.emptyText}
          hideTitle
        />
      ) : (
        <ReportTableSection
          title=""
          columns={["주제", "수정 위치", "기준", "정책 근거", "기준 근거", "권고", "예시 문안", "신뢰도", "판단 근거"]}
          rows={buildGuidanceRows(input.items)}
          emptyText={input.emptyText}
          hideTitle
          leftAlignValues={input.leftAlignValues}
        />
      )}
    </section>
  );
}

function ReportTableSection(input: {
  title: string;
  columns: string[];
  rows: Array<Array<ReactNode>>;
  emptyText: string;
  hideTitle?: boolean;
  leftAlignValues?: boolean;
  renderRow?: (row: Array<ReactNode>, index: number) => Array<ReactNode>;
}) {
  return (
    <section className="review-column comparison-table-section">
      {!input.hideTitle ? (
        <div className="section-header compact-section-header">
          <h3>{input.title}</h3>
        </div>
      ) : null}
      <div className="comparison-table-wrap">
        <table className={`comparison-data-table ${input.leftAlignValues ? "comparison-data-table-left-values" : ""}`.trim()}>
          <thead>
            <tr>
              {input.columns.map((column) => (
                <th key={column}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {input.rows.length === 0 ? (
              <tr>
                {input.columns.map((column, index) => (
                  <td
                    key={`${input.title}-empty-${column}`}
                    className={`comparison-table-empty ${index === 0 ? "comparison-table-empty-primary" : ""} ${
                      shouldLeftAlignComparisonColumn(input.columns[index] ?? "") ? "comparison-cell-left" : ""
                    }`.trim()}
                  >
                    {index === 0 ? input.emptyText : "-"}
                  </td>
                ))}
              </tr>
            ) : (
              input.rows.map((rawRow, index) => {
                const row = input.renderRow ? input.renderRow(rawRow, index) : rawRow;
                return (
                <tr key={`${input.title}-${index}`}>
                  {row.map((cell, cellIndex) => (
                    <td
                      key={`${input.title}-${index}-${cellIndex}`}
                      className={shouldLeftAlignComparisonColumn(input.columns[cellIndex] ?? "") ? "comparison-cell-left" : ""}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function escapeCsvCell(value: string) {
  const normalized = value.replace(/\r\n/g, "\n");
  if (/[",\n]/.test(normalized)) {
    return `"${normalized.replace(/"/g, "\"\"")}"`;
  }
  return normalized;
}

function downloadCsv(fileName: string, columns: string[], rows: string[][]) {
  if (typeof window === "undefined") {
    return;
  }

  const csv = [columns, ...rows]
    .map((row) => row.map((cell) => escapeCsvCell(String(cell ?? ""))).join(","))
    .join("\n");
  const blob = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8;" });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
}

function SummarySection(input: { summary: string; emptyText: string }) {
  const content = input.summary.trim() || input.emptyText;

  return (
    <section className="review-column comparison-summary-section">
      <div className="info-card comparison-report-summary-card ai-summary-card">
        <p className="comparison-report-summary-copy">{content}</p>
      </div>
    </section>
  );
}

function joinListForCell(items: string[]) {
  if (items.length === 0) {
    return "-";
  }

  return items.join("\n");
}

function buildDocumentRows(items: GroupDocumentItem[]) {
  return items.flatMap((item) => {
    const rows = item.evidencePairs.length > 0
      ? item.evidencePairs
      : [{ keyPoint: "", sourcePath: "" }];
    return rows
      .filter((pair, index) => index === 0 || pair.keyPoint.trim() || pair.sourcePath.trim())
      .map((pair, index) => [
        index === 0 ? item.title : "",
        pair.keyPoint.trim(),
        pair.sourcePath.trim(),
      ])
      .filter((row) => {
        const [title, keyPoint] = row;
        return String(title).trim().length > 0 || String(keyPoint).trim().length > 0;
      });
  });
}

function buildRequirementRows(items: GroupRequirementItem[]) {
  return items.flatMap((item) => {
    const rows = item.evidencePairs.length > 0
      ? item.evidencePairs
      : [{ sourceTitle: "", sourcePath: "" }];
    return rows
      .filter((pair, index) => index === 0 || pair.sourceTitle.trim() || pair.sourcePath.trim())
      .map((pair, index) => [
        index === 0 ? item.topic : "",
        index === 0 ? item.detail : "",
        pair.sourceTitle.trim(),
        pair.sourcePath.trim(),
        index === 0 ? item.notes || "" : "",
      ])
      .filter((row) => {
        const [topic, detail, sourceTitle, , notes] = row;
        return (
          String(topic).trim().length > 0 ||
          String(detail).trim().length > 0 ||
          String(sourceTitle).trim().length > 0 ||
          String(notes).trim().length > 0
        );
      });
  });
}

function normalizeDocumentEvidencePairs(item: AiGroupReport["documents"][number]) {
  if (item.evidence_pairs && item.evidence_pairs.length > 0) {
    return item.evidence_pairs
      .map((pair) => ({
        keyPoint: pair.key_point.trim(),
        sourcePath: pair.source_path.trim(),
      }));
  }

  return zipEvidencePairs(item.key_points, item.source_paths).map(([keyPoint, sourcePath]) => ({
    keyPoint,
    sourcePath,
  }));
}

function normalizeRequirementEvidencePairs(item: AiGroupReport["merged_requirements"][number]) {
  if (item.evidence_pairs && item.evidence_pairs.length > 0) {
    return item.evidence_pairs
      .map((pair) => ({
        sourceTitle: pair.source_title.trim(),
        sourcePath: pair.source_path.trim(),
      }));
  }

  return zipEvidencePairs(item.source_titles, item.source_paths).map(([sourceTitle, sourcePath]) => ({
    sourceTitle,
    sourcePath,
  }));
}

function zipEvidencePairs(left: string[], right: string[]) {
  const rowCount = Math.max(left.length, right.length, 0);
  return Array.from({ length: rowCount }, (_, index) => [
    left[index]?.trim() || "",
    right[index]?.trim() || "",
  ] as const);
}

function buildGuidanceRows(items: GuidanceItem[]) {
  return items.map((item) => [
    <div className="comparison-guidance-topic-cell" key={`${item.id}-topic`}>
      <div>{item.title}</div>
      <div className="pill-row">
        <span className={`pill ${getPriorityTone(item.priority)}`}>{item.priority}</span>
        <span className={`pill ${getChangeTypeTone(item.changeType)}`}>{item.changeType}</span>
      </div>
    </div>,
    `${item.targetPath}\n${item.targetPathReason}`.trim(),
    item.comparisonSourceTitle,
    joinListForCell(item.policyEvidence),
    joinListForCell(item.comparisonEvidence),
    `${item.action}\n${item.actionInstruction}`.trim(),
    item.actionExample,
    `${Math.round(item.confidence * 100)}%`,
    item.reason,
  ]);
}

function hasVisibleDocumentAction(action: AiComparisonReport["document_actions"][number]["actions"][number]) {
  return [
    action.current_issue,
    action.required_change,
    action.instruction,
    action.draft_revision_text,
    action.rationale,
  ].some((value) => String(value ?? "").trim().length > 0);
}

function shouldLeftAlignComparisonColumn(column: string) {
  return [
    "내용",
    "핵심 정리",
    "권고",
    "예시 문안",
    "판단",
    "판단 근거",
    "조치",
    "수정 위치",
  ].includes(column);
}

function getChangeTypeTone(value: string) {
  if (value.includes("신설")) {
    return "accent";
  }
  if (value.includes("수정")) {
    return "warning";
  }
  if (value.includes("삭제")) {
    return "danger";
  }
  return "neutral";
}

function getPriorityTone(value: string) {
  if (value === "상") {
    return "danger";
  }
  if (value === "중") {
    return "warning";
  }
  if (value === "하") {
    return "neutral";
  }
  return "neutral";
}

function toRevisionStatusLabel(status: ComparisonReviewDetail["revision_status"]) {
  switch (status) {
    case "REQUIRED":
      return "개정 필요";
    case "RECOMMENDED":
      return "개정 권장";
    case "NOT_REQUIRED":
      return "개정 불필요";
    case "LOW_CONFIDENCE_REVIEW":
      return "저신뢰 검토 필요";
    default:
      return null;
  }
}

function getStatusTone(status: ComparisonReviewDetail["revision_status"]) {
  switch (status) {
    case "REQUIRED":
      return "danger";
    case "RECOMMENDED":
      return "warning";
    case "NOT_REQUIRED":
      return "success";
    case "LOW_CONFIDENCE_REVIEW":
      return "neutral";
    default:
      return "neutral";
  }
}

export function getSelectionSummary(
  selectedDocumentCount: number,
  referenceDocumentCount: number,
  selectedLawVersionCount: number,
) {
  return `비교 대상 ${selectedDocumentCount}개, 기준 ${referenceDocumentCount + selectedLawVersionCount}개가 현재 분석 범위에 포함되어 있습니다.`;
}

function describeComparisonWarning(warning: string) {
  const normalized = warning.toLowerCase();

  if (/누락|missing|없음|찾지 못/.test(normalized)) {
    return {
      tone: "danger",
      label: "차단 가능",
      title: warning,
      impact: "비교 범위 일부가 비어 있어 결과가 누락되거나 신뢰도가 크게 낮아질 수 있습니다.",
      action: "누락된 문서 또는 법령 구조를 먼저 보완한 뒤 비교를 다시 실행하세요.",
    };
  }

  if (/신뢰|애매|모호|불일치|정렬/.test(normalized)) {
    return {
      tone: "warning",
      label: "검토 필요",
      title: warning,
      impact: "자동 비교는 완료됐지만 결과 근거 위치나 권고 강도를 사람이 확인하는 편이 안전합니다.",
      action: "하단 권고의 근거 위치와 원문을 함께 대조하세요.",
    };
  }

  return {
    tone: "warning",
    label: "주의",
    title: warning,
    impact: "비교는 가능하지만 결과 해석에 추가 검토가 필요합니다.",
    action: "경고 내용을 기준으로 우선순위를 정하고 재파싱 또는 재실행 여부를 판단하세요.",
  };
}
