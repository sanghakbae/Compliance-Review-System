import { useEffect, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { AuthPanel } from "./components/AuthPanel";
import {
  ComparisonReviewPanel,
  type ComparisonReviewAnalysisState,
  getSelectionSummary,
  getStageProgress,
  type ComparisonReviewOverviewSnapshot,
} from "./components/ComparisonReviewPanel";
import { DocumentList } from "./components/DocumentList";
import { DocumentUploadForm } from "./components/DocumentUploadForm";
import { DocumentViewer } from "./components/DocumentViewer";
import { LawSourcePanel } from "./components/LawSourcePanel";
import { LawVersionPreview } from "./components/LawVersionPreview";
import { PromptSettingsPanel } from "./components/PromptSettingsPanel";
import {
  COMPARISON_REPORT_INSTRUCTIONS,
  LEFT_REPORT_INSTRUCTIONS,
  RIGHT_REPORT_INSTRUCTIONS,
} from "../shared/analysisPrompts";
import {
  analyzeSelectedRevisionsStage,
  deleteWorkspaceFavorite,
  deleteLawSource,
  deleteDocument,
  getDocumentDetail,
  getPolicySecuritySettings,
  getPolicyUserOpenAiSettings,
  listComparisonRuns,
  listDocuments,
  listLawVersions,
  listReviewExecutionHistory,
  listWorkspaceFavorites,
  reparseLawSource,
  reparseDocument,
  runComparison,
  saveAiReportHistoryEntry,
  savePolicySecuritySettings,
  savePolicyUserOpenAiSettings,
  saveReviewExecutionHistoryEntry,
  updateReviewExecutionHistoryStatus,
  saveWorkspaceFavorite,
  uploadDocument,
  uploadStructuredRowsDocument,
} from "./lib/documentService";
import {
  signOutUser,
  clearFirebaseAuthArtifacts,
  onAppAuthChange,
  type AppAuthSession,
} from "./lib/firebaseAuth";
import { hasFirebaseEnv } from "./lib/firebaseClient";
import type {
  AiRevisionPromptOverrides,
  ComparisonRunSummary,
  DocumentSummary,
  LawVersionSummary,
  OpenAiSettings,
  PromptSlotIndex,
  PromptSlotList,
  ReviewExecutionHistoryEntry,
  SecuritySettings,
  WorkspaceFavorite,
  WorkspaceSelectionSnapshot,
} from "./types";

type NoticeTone = "info" | "success" | "warning" | "danger";
type PersistedWorkspaceSelection = WorkspaceSelectionSnapshot;
type LawDashboardCategory = "법률" | "시행령" | "시행규칙" | "기준";
const DEFAULT_OPENAI_MODEL = "gpt-5.2";
const DOCUMENT_PARSER_REPARSE_VERSION = "preserve-deleted-and-amended-items-v11";

type AppNotice = {
  tone: NoticeTone;
  label: string;
  title: string;
  detail?: string;
  actions?: string[];
  debug?: string[];
};

type WorkspaceSection =
  | "dashboard"
  | "documents"
  | "comparison"
  | "results"
  | "history"
  | "settings";

const WORKSPACE_SECTION_STORAGE_KEY = "policy-revision-mgmt-active-workspace-section";
const WORKSPACE_SECTIONS: WorkspaceSection[] = [
  "dashboard",
  "documents",
  "comparison",
  "results",
  "history",
  "settings",
];
const REVIEW_HISTORY_PAGE_SIZE = 5;
const DEFAULT_SECURITY_SETTINGS: SecuritySettings = {
  allowedEmailDomain: "muhayu.com",
  sessionIdleTimeoutMinutes: 60,
};
const SESSION_ACTIVITY_REFRESH_THROTTLE_MS = 15 * 1000;
type WorkspaceDataLoadState = {
  documents: boolean;
  lawVersions: boolean;
  comparisonRuns: boolean;
  workspaceFavorites: boolean;
  reviewExecutionHistory: boolean;
};
const EMPTY_WORKSPACE_DATA_LOAD_STATE: WorkspaceDataLoadState = {
  documents: false,
  lawVersions: false,
  comparisonRuns: false,
  workspaceFavorites: false,
  reviewExecutionHistory: false,
};

function getPortalWorkspaceSection(
  embeddedContext?: { project?: string; view?: string; embedded?: boolean },
): WorkspaceSection | null {
  if (!embeddedContext?.embedded) {
    return null;
  }

  return WORKSPACE_SECTIONS.includes(embeddedContext.view as WorkspaceSection)
    ? (embeddedContext.view as WorkspaceSection)
    : null;
}

function isPortalEmbeddedWorkspace(
  embeddedContext?: { project?: string; view?: string; embedded?: boolean },
) {
  return Boolean(embeddedContext?.embedded);
}

export default function App({ embeddedContext }: { embeddedContext?: { project?: string; view?: string; embedded?: boolean } } = {}) {
  const embeddedWorkspace = isPortalEmbeddedWorkspace(embeddedContext);
  const portalWorkspaceSection = getPortalWorkspaceSection(embeddedContext);
  const emptyComparisonAnalysisState: ComparisonReviewAnalysisState = {
    aiGuidance: null,
    leftGroupReport: null,
    rightGroupReport: null,
    comparisonReport: null,
    aiAnalysisError: null,
    apiCallCount: 0,
    isAnalyzingSelection: false,
    analysisStageLabel: null,
    analysisStagePhase: null,
    analysisStageStartedAt: null,
  };
  const [session, setSession] = useState<AppAuthSession | null>(
    embeddedWorkspace
      ? {
          user: { id: "portal-guest", email: "portal@local" },
          access_token: "portal-guest",
        }
      : null,
  );
  // False until Firebase has restored auth state at least once. Prevents the
  // login screen from flashing on refresh while the session is being restored.
  const [authResolved, setAuthResolved] = useState(embeddedWorkspace);
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [comparisonRuns, setComparisonRuns] = useState<ComparisonRunSummary[]>([]);
  const [lawVersions, setLawVersions] = useState<LawVersionSummary[]>([]);
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(
    null,
  );
  const [checkedDocumentIds, setCheckedDocumentIds] = useState<string[]>([]);
  const [comparisonTargetDocumentIds, setComparisonTargetDocumentIds] = useState<string[]>([]);
  const [comparisonReferenceDocumentIds, setComparisonReferenceDocumentIds] = useState<string[]>([]);
  const [draggingDocumentId, setDraggingDocumentId] = useState<string | null>(null);
  const [deletingDocumentId, setDeletingDocumentId] = useState<string | null>(null);
  const [pendingDeleteDocumentId, setPendingDeleteDocumentId] = useState<string | null>(null);
  const [reparsingDocumentId, setReparsingDocumentId] = useState<string | null>(null);
  const [isReparsingAllDocuments, setIsReparsingAllDocuments] = useState(false);
  const documentXlsxImportInputRef = useRef<HTMLInputElement | null>(null);
  const [selectedLawVersionIds, setSelectedLawVersionIds] = useState<string[]>([]);
  const [selectedComparisonRunId, setSelectedComparisonRunId] = useState<string | null>(
    null,
  );
  const [analysisRequestKey, setAnalysisRequestKey] = useState(0);
  const [documentPreviewRefreshKey, setDocumentPreviewRefreshKey] = useState(0);
  const [lawPreviewRefreshKey, setLawPreviewRefreshKey] = useState(0);
  const [workspaceSelectionHydrated, setWorkspaceSelectionHydrated] = useState(false);
  const [workspaceFavorites, setWorkspaceFavorites] = useState<WorkspaceFavorite[]>([]);
  const [reviewExecutionHistory, setReviewExecutionHistory] = useState<ReviewExecutionHistoryEntry[]>([]);
  const [reviewHistoryPage, setReviewHistoryPage] = useState(1);
  const [aiHistoryLoadRequest, setAiHistoryLoadRequest] = useState<{
    requestId: number;
    aiReportHistoryId?: string | null;
    selectionSummary: string;
    selectionCounts: {
      leftDocumentCount: number;
      rightDocumentCount: number;
      rightLawCount: number;
    };
  } | null>(null);
  const [pendingAiOnlyReviewHistoryId, setPendingAiOnlyReviewHistoryId] = useState<string | null>(null);
  const [pendingAiOnlyReportHistoryId, setPendingAiOnlyReportHistoryId] = useState<string | null>(null);
  const [openAiSettings, setOpenAiSettings] = useState<OpenAiSettings>({
    apiKey: "",
    model: DEFAULT_OPENAI_MODEL,
  });
  const [openAiSettingsHydrated, setOpenAiSettingsHydrated] = useState(false);
  const [securitySettings, setSecuritySettings] = useState<SecuritySettings>(DEFAULT_SECURITY_SETTINGS);
  const [securitySettingsHydrated, setSecuritySettingsHydrated] = useState(false);
  const openAiSettingsSaveTimerRef = useRef<number | null>(null);
  const openAiSettingsDirtyRef = useRef(false);
  const openAiSettingsSaveRequestIdRef = useRef(0);
  const securitySettingsSaveTimerRef = useRef<number | null>(null);
  const securitySettingsDirtyRef = useRef(false);
  const securitySettingsSaveRequestIdRef = useRef(0);
  const [activeWorkspaceSection, setActiveWorkspaceSection] = useState<WorkspaceSection>(
    () => portalWorkspaceSection ?? readWorkspaceSection() ?? "dashboard",
  );
  const [isWorkspaceSidebarCollapsed, setIsWorkspaceSidebarCollapsed] = useState(false);
  const [isDocumentsPanelCollapsed, setIsDocumentsPanelCollapsed] = useState(false);
  const [workspaceDataLoadState, setWorkspaceDataLoadState] = useState<WorkspaceDataLoadState>(
    EMPTY_WORKSPACE_DATA_LOAD_STATE,
  );
  const [appNotice, setAppNoticeState] = useState<AppNotice | null>(null);
  const [comparisonOverview, setComparisonOverview] = useState<ComparisonReviewOverviewSnapshot | null>(null);
  const [comparisonAnalysisState, setComparisonAnalysisState] = useState<ComparisonReviewAnalysisState>(
    emptyComparisonAnalysisState,
  );
  const [promptOverrides, setPromptOverrides] = useState<AiRevisionPromptOverrides>({
    left: [LEFT_REPORT_INSTRUCTIONS, "", ""],
    right: [RIGHT_REPORT_INSTRUCTIONS, "", ""],
    final: [COMPARISON_REPORT_INSTRUCTIONS, "", ""],
  });
  const [activePromptSlotByStage, setActivePromptSlotByStage] = useState<
    Record<keyof AiRevisionPromptOverrides, PromptSlotIndex>
  >({
    left: 0,
    right: 0,
    final: 0,
  });
  const lastSessionActivityAtRef = useRef(Date.now());
  const lastSessionActivityRecordAtRef = useRef(0);
  const isSupabaseConfigured = hasFirebaseEnv();
  const sessionUserId = session?.user.id ?? null;

  function setAppNotice(nextNotice: AppNotice | null) {
    if (
      nextNotice &&
      isTransientFetchStatus(`${nextNotice.title}\n${nextNotice.detail ?? ""}`)
    ) {
      setAppNoticeState((current) =>
        current && isTransientFetchStatus(`${current.title}\n${current.detail ?? ""}`) ? null : current,
      );
      return;
    }

    setAppNoticeState(nextNotice);
  }

  function setStatus(message: string) {
    if (isTransientFetchStatus(message)) {
      setAppNoticeState((current) =>
        current && isTransientFetchStatus(`${current.title}\n${current.detail ?? ""}`) ? null : current,
      );
      console.warn("[status] transient fetch failure suppressed:", message);
      return;
    }

    const [titleLine, ...restLines] = message
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const explicitDetail = restLines.join("\n").trim();
    const inferredDetail = inferNoticeDetail(message);
    setAppNotice({
      tone: inferNoticeTone(message),
      label: "작업 상태",
      title: titleLine || message,
      detail: [explicitDetail, inferredDetail].filter(Boolean).join("\n\n") || undefined,
      actions: inferNoticeActions(message),
    });
  }

  useEffect(() => {
    if (appNotice && isTransientFetchStatus(`${appNotice.title}\n${appNotice.detail ?? ""}`)) {
      setAppNoticeState(null);
    }
  }, [appNotice]);

  function isAllowedEmailDomain(email?: string | null) {
    const normalizedEmail = email?.trim().toLowerCase() ?? "";
    if (!normalizedEmail) {
      return false;
    }
    // Exact-email allowlist takes precedence over domain matching (so a single
    // consumer Gmail account can be permitted). Configured via VITE_ALLOWED_EMAILS.
    if (ALLOWED_EMAILS.length > 0) {
      return ALLOWED_EMAILS.includes(normalizedEmail);
    }
    const allowedDomain = normalizeAllowedEmailDomain(securitySettings.allowedEmailDomain);
    return normalizedEmail.endsWith(`@${allowedDomain}`);
  }

  async function rejectDisallowedSession(email?: string | null) {
    await signOutUser().catch(() => undefined);
    clearFirebaseAuthArtifacts();
    setSession(null);
    setAppNotice({
      tone: "danger",
      label: "인증 제한",
      title: "허용되지 않은 Google Workspace 도메인입니다.",
      detail: securitySettings.allowedEmailDomain
        ? `${normalizeAllowedEmailDomain(securitySettings.allowedEmailDomain)} 계정만 로그인할 수 있습니다. 현재 계정: ${email ?? "알 수 없음"}`
        : "허용 도메인 설정을 확인하세요.",
      actions: ["허용된 계정으로 다시 로그인하세요."],
    });
  }

  function hasDeterministicComparisonResult(entry: ReviewExecutionHistoryEntry) {
    return entry.resultStatus === "comparison_completed" && entry.comparisonRunIds.length > 0;
  }

  function hasAiOnlyHistoryResult(entry: ReviewExecutionHistoryEntry) {
    return entry.resultStatus === "ai_completed";
  }

  useEffect(() => {
    setReviewHistoryPage((current) =>
      Math.min(current, Math.max(1, Math.ceil(reviewExecutionHistory.length / REVIEW_HISTORY_PAGE_SIZE))),
    );
  }, [reviewExecutionHistory.length]);

  async function handleHeaderSignOut() {
    try {
      await signOutUser();
      clearFirebaseAuthArtifacts();
      setAppNotice({
        tone: "warning",
        label: "인증 상태",
        title: "로그아웃되었습니다.",
        detail: "다시 로그인하기 전까지 업로드와 비교 실행은 비활성화됩니다.",
        actions: ["Google 로그인을 다시 진행하세요."],
      });
    } catch (error) {
      setAppNotice({
        tone: "danger",
        label: "인증 상태",
        title: "로그아웃에 실패했습니다.",
        detail: error instanceof Error ? error.message : "잠시 후 다시 시도하세요.",
        actions: ["잠시 후 다시 시도하세요."],
      });
    }
  }

  useEffect(() => {
    if (embeddedWorkspace) {
      setSession({
        user: { id: "portal-guest", email: "portal@local" },
        access_token: "portal-guest",
      });
      setAppNotice({
        tone: "info",
        label: "포털 모드",
        title: "로그인 없이 전체 화면을 표시합니다.",
        detail: "문서 관리, 비교덱 구성, 검토 결과, 이력 관리, 설정을 모두 볼 수 있습니다.",
      });
      return;
    }

    if (!isSupabaseConfigured) {
      setAppNotice({
        tone: "warning",
        label: "설정 필요",
        title: "Firebase 환경 변수가 비어 있습니다.",
        detail: "인증과 데이터 기능은 비활성화된 상태입니다.",
        actions: [
          ".env에 VITE_FIREBASE_API_KEY를 설정하세요.",
          ".env에 VITE_FIREBASE_PROJECT_ID를 설정하세요.",
        ],
        debug: ["환경 변수 누락으로 인증/데이터 기능 비활성화"],
      });
      return;
    }

    let cancelled = false;

    // Firebase fires this once with the restored user (or null) on init, and
    // again on every sign-in / sign-out / token refresh — replacing both the
    // Supabase getSession bootstrap and onAuthStateChange subscription.
    const unsubscribe = onAppAuthChange(async (nextSession) => {
      if (cancelled) {
        return;
      }
      // Auth state is now known (signed in or out) — safe to render the real UI.
      setAuthResolved(true);

      if (!nextSession) {
        setSession(null);
        setAppNotice({
          tone: "info",
          label: "인증 대기",
          title: "로그인 후 계속 진행하세요.",
          detail: "현재 화면은 보이지만 업로드와 비교 실행은 잠겨 있습니다.",
          actions: ["Google 로그인으로 인증하세요."],
          debug: ["인증 세션 없음"],
        });
        return;
      }

      if (!isAllowedEmailDomain(nextSession.user.email)) {
        await rejectDisallowedSession(nextSession.user.email);
        return;
      }

      setSession(nextSession);
      setAppNotice({
        tone: "success",
        label: "인증 상태",
        title: "인증되었습니다.",
        detail: "문서 업로드, 법령 선택, 비교 실행을 진행할 수 있습니다.",
        actions: ["문서를 업로드하거나 기존 문서를 선택하세요.", "좌우 그룹을 구성한 뒤 비교를 실행하세요."],
        debug: ["인증 세션 확인 완료", `user=${nextSession.user.email ?? "unknown"}`],
      });
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [embeddedWorkspace, isSupabaseConfigured, securitySettings.allowedEmailDomain]);

  useEffect(() => {
    if (!embeddedWorkspace) {
      return;
    }

    setActiveWorkspaceSection(portalWorkspaceSection ?? "dashboard");
  }, [embeddedWorkspace, portalWorkspaceSection]);

  useEffect(() => {
    if (!session || embeddedWorkspace || !isSupabaseConfigured) {
      return;
    }

    const sessionIdleTimeoutMinutes = normalizeSessionIdleTimeoutMinutes(
      securitySettings.sessionIdleTimeoutMinutes,
    );
    const sessionIdleTimeoutMs = sessionIdleTimeoutMinutes * 60 * 1000;
    let timeoutHandled = false;
    lastSessionActivityAtRef.current = Date.now();
    lastSessionActivityRecordAtRef.current = 0;

    function recordSessionActivity() {
      const now = Date.now();
      if (now - lastSessionActivityRecordAtRef.current < SESSION_ACTIVITY_REFRESH_THROTTLE_MS) {
        return;
      }

      lastSessionActivityAtRef.current = now;
      lastSessionActivityRecordAtRef.current = now;
    }

    async function expireIdleSession() {
      if (timeoutHandled) {
        return;
      }

      timeoutHandled = true;
      await signOutUser().catch(() => undefined);
      clearFirebaseAuthArtifacts();
      setSession(null);
      setAppNotice({
        tone: "warning",
        label: "세션 만료",
        title: `${sessionIdleTimeoutMinutes}분 동안 사용이 없어 로그아웃되었습니다.`,
        detail: `계속 사용하려면 ${normalizeAllowedEmailDomain(securitySettings.allowedEmailDomain)} Google 계정으로 다시 로그인하세요.`,
        actions: ["Google 로그인을 다시 진행하세요."],
      });
    }

    function checkIdleTimeout() {
      if (Date.now() - lastSessionActivityAtRef.current >= sessionIdleTimeoutMs) {
        void expireIdleSession();
      }
    }

    const activityEvents: Array<keyof WindowEventMap> = [
      "click",
      "keydown",
      "pointerdown",
      "scroll",
      "focus",
    ];
    activityEvents.forEach((eventName) => {
      window.addEventListener(eventName, recordSessionActivity, { passive: true });
    });
    document.addEventListener("visibilitychange", recordSessionActivity);
    const intervalId = window.setInterval(checkIdleTimeout, 30 * 1000);

    return () => {
      activityEvents.forEach((eventName) => {
        window.removeEventListener(eventName, recordSessionActivity);
      });
      document.removeEventListener("visibilitychange", recordSessionActivity);
      window.clearInterval(intervalId);
    };
  }, [
    embeddedWorkspace,
    isSupabaseConfigured,
    securitySettings.allowedEmailDomain,
    securitySettings.sessionIdleTimeoutMinutes,
    session,
  ]);

  useEffect(() => {
    if (!embeddedWorkspace) {
      return;
    }

    setActiveWorkspaceSection(portalWorkspaceSection ?? "documents");
  }, [embeddedWorkspace, portalWorkspaceSection]);

  useEffect(() => {
    if (embeddedWorkspace) {
      return;
    }

    writeWorkspaceSection(activeWorkspaceSection);
  }, [activeWorkspaceSection, embeddedWorkspace]);

  useEffect(() => {
    if (!isSupabaseConfigured) {
      return;
    }

    if (!sessionUserId) {
      setDocuments([]);
      setLawVersions([]);
      setComparisonRuns([]);
      setReviewExecutionHistory([]);
      setPendingAiOnlyReviewHistoryId(null);
      setPendingAiOnlyReportHistoryId(null);
      setSelectedDocumentId(null);
      setCheckedDocumentIds([]);
      setComparisonTargetDocumentIds([]);
      setComparisonReferenceDocumentIds([]);
      setDraggingDocumentId(null);
      setPendingDeleteDocumentId(null);
      setIsReparsingAllDocuments(false);
      setSelectedLawVersionIds([]);
      setSelectedComparisonRunId(null);
      setAnalysisRequestKey(0);
      setDocumentPreviewRefreshKey(0);
      setLawPreviewRefreshKey(0);
      setWorkspaceSelectionHydrated(false);
      setWorkspaceFavorites([]);
      setWorkspaceDataLoadState(EMPTY_WORKSPACE_DATA_LOAD_STATE);
      return;
    }

    let cancelled = false;
    const savedSelection = readWorkspaceSelection(sessionUserId);
    const needs = getWorkspaceDataRequirements(activeWorkspaceSection);
    const requests: Promise<void>[] = [];
    const loadErrors: string[] = [];
    const loadStartedAt = performance.now();

    if (needs.documents && !workspaceDataLoadState.documents) {
      requests.push(
        listDocuments()
          .then((documentItems) => {
            if (cancelled) {
              return;
            }
            setDocuments(documentItems);
            setSelectedDocumentId((current) => {
              const nextSelectedId =
                workspaceSelectionHydrated && current
                  ? current
                  : (savedSelection?.selectedDocumentId ?? null);
              return nextSelectedId && documentItems.some((item) => item.id === nextSelectedId)
                ? nextSelectedId
                : null;
            });
            setCheckedDocumentIds((current) =>
              current.filter((id) => documentItems.some((item) => item.id === id)),
            );
            setComparisonTargetDocumentIds((current) =>
              filterExistingIds(
                workspaceSelectionHydrated ? current : (savedSelection?.targetDocumentIds ?? []),
                documentItems,
              ),
            );
            setComparisonReferenceDocumentIds((current) =>
              filterExistingIds(
                workspaceSelectionHydrated ? current : (savedSelection?.referenceDocumentIds ?? []),
                documentItems,
              ),
            );
            setWorkspaceDataLoadState((current) => ({ ...current, documents: true }));
          })
          .catch((error: Error) => {
            loadErrors.push(`문서 목록: ${error.message}`);
          }),
      );
    }

    if (needs.lawVersions && !workspaceDataLoadState.lawVersions) {
      requests.push(
        listLawVersions()
          .then((lawVersionItems) => {
            if (cancelled) {
              return;
            }
            setLawVersions(lawVersionItems);
            setSelectedLawVersionIds((current) =>
              filterExistingIds(
                workspaceSelectionHydrated ? current : (savedSelection?.lawVersionIds ?? []),
                lawVersionItems,
              ),
            );
            setWorkspaceDataLoadState((current) => ({ ...current, lawVersions: true }));
          })
          .catch((error: Error) => {
            loadErrors.push(`법령 목록: ${error.message}`);
          }),
      );
    }

    if (needs.comparisonRuns && !workspaceDataLoadState.comparisonRuns) {
      requests.push(
        listComparisonRuns()
          .then((comparisonItems) => {
            if (cancelled) {
              return;
            }
            setComparisonRuns(comparisonItems);
            setSelectedComparisonRunId((current) =>
              current && comparisonItems.some((item) => item.id === current) ? current : null,
            );
            setWorkspaceDataLoadState((current) => ({ ...current, comparisonRuns: true }));
          })
          .catch((error: Error) => {
            loadErrors.push(`검토 결과: ${error.message}`);
          }),
      );
    }

    if (needs.workspaceFavorites && !workspaceDataLoadState.workspaceFavorites) {
      requests.push(
        listWorkspaceFavorites()
          .then((favorites) => {
            if (cancelled) {
              return;
            }
            setWorkspaceFavorites(favorites);
            setWorkspaceDataLoadState((current) => ({ ...current, workspaceFavorites: true }));
          })
          .catch((error: Error) => {
            loadErrors.push(`저장된 즐겨찾기: ${error.message}`);
          }),
      );
    }

    if (needs.reviewExecutionHistory && !workspaceDataLoadState.reviewExecutionHistory) {
      requests.push(
        listReviewExecutionHistory()
          .then((historyItems) => {
            if (cancelled) {
              return;
            }
            setReviewExecutionHistory(historyItems);
            setWorkspaceDataLoadState((current) => ({ ...current, reviewExecutionHistory: true }));
          })
          .catch((error: Error) => {
            loadErrors.push(`실행 이력: ${error.message}`);
          }),
      );
    }

    if (requests.length === 0) {
      return;
    }

    void Promise.allSettled(requests).then(() => {
      if (cancelled) {
        return;
      }
      if (needs.documents || needs.lawVersions) {
        setWorkspaceSelectionHydrated(true);
      }

      if (loadErrors.length > 0) {
        const loadDurationMs = Math.round(performance.now() - loadStartedAt);
        setAppNotice({
          tone: "warning",
          label: "부분 로드 오류",
          title: "현재 메뉴 데이터 일부를 불러오지 못했습니다.",
          detail: `${loadErrors.join("\n")}\n로드 시간: ${loadDurationMs}ms`,
          actions: ["필요한 메뉴에 진입할 때 데이터만 다시 불러옵니다.", "인증 상태와 Supabase 연결을 확인하세요."],
          debug: [...loadErrors, `lazy workspace load=${loadDurationMs}ms`, `section=${activeWorkspaceSection}`],
        });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [
    activeWorkspaceSection,
    sessionUserId,
    isSupabaseConfigured,
    workspaceDataLoadState,
    workspaceSelectionHydrated,
  ]);

  useEffect(() => {
    const hasSelectionContext =
      comparisonTargetDocumentIds.length > 0 &&
      (comparisonReferenceDocumentIds.length > 0 || selectedLawVersionIds.length > 0);

    if (!hasSelectionContext) {
      setComparisonAnalysisState(emptyComparisonAnalysisState);
      return;
    }

    if (analysisRequestKey === 0) {
      return;
    }

    let cancelled = false;

    setComparisonAnalysisState({
      ...emptyComparisonAnalysisState,
      isAnalyzingSelection: true,
      analysisStageLabel: "1단계 비교 대상 정리 중",
      analysisStagePhase: "left",
      analysisStageStartedAt: Date.now(),
    });

    (async () => {
      setStatus("1단계 비교 대상 정리를 시작했습니다.");
      const leftStage = await runComparisonStageWithTimeout(
        "1단계 비교 대상 정리",
        analyzeSelectedRevisionsStage({
          stage: "left",
          targetDocumentIds: comparisonTargetDocumentIds,
          referenceDocumentIds: comparisonReferenceDocumentIds,
          lawVersionIds: selectedLawVersionIds,
          promptOverrides: selectActivePromptOverrides(promptOverrides, activePromptSlotByStage),
          openAiSettings,
        }),
      );

      if (cancelled) {
        return;
      }

      setComparisonAnalysisState((current) => ({
        ...current,
        leftGroupReport: leftStage.left_group_report,
        apiCallCount: leftStage.api_call_count,
        analysisStageLabel: "2단계 기준 정리 중",
        analysisStagePhase: "right",
        analysisStageStartedAt: Date.now(),
      }));

      setStatus("2단계 기준 정리를 시작했습니다.");
      const rightStage = await runComparisonStageWithTimeout(
        "2단계 기준 정리",
        analyzeSelectedRevisionsStage({
          stage: "right",
          targetDocumentIds: comparisonTargetDocumentIds,
          referenceDocumentIds: comparisonReferenceDocumentIds,
          lawVersionIds: selectedLawVersionIds,
          promptOverrides: selectActivePromptOverrides(promptOverrides, activePromptSlotByStage),
          openAiSettings,
        }),
      );

      if (cancelled) {
        return;
      }

      setComparisonAnalysisState((current) => ({
        ...current,
        rightGroupReport: rightStage.right_group_report,
        apiCallCount: Math.max(current.apiCallCount, rightStage.api_call_count),
        analysisStageLabel: "3단계 최종 비교 리포트 생성 중",
        analysisStagePhase: "final",
        analysisStageStartedAt: Date.now(),
      }));

      setStatus("3단계 최종 비교 리포트 생성을 시작했습니다.");
      const finalStage = await runComparisonStageWithTimeout(
        "3단계 최종 비교 리포트 생성",
        analyzeSelectedRevisionsStage({
          stage: "final",
          targetDocumentIds: comparisonTargetDocumentIds,
          referenceDocumentIds: comparisonReferenceDocumentIds,
          lawVersionIds: selectedLawVersionIds,
          leftGroupReport: leftStage.left_group_report,
          rightGroupReport: rightStage.right_group_report,
          promptOverrides: selectActivePromptOverrides(promptOverrides, activePromptSlotByStage),
          openAiSettings,
        }),
      );

      if (cancelled) {
        return;
      }

      const finalGuidance = {
        left_group_report: leftStage.left_group_report as NonNullable<typeof leftStage.left_group_report>,
        right_group_report: rightStage.right_group_report as NonNullable<typeof rightStage.right_group_report>,
        comparison_report: finalStage.comparison_report as NonNullable<typeof finalStage.comparison_report>,
        model: finalStage.model,
        api_call_count: finalStage.api_call_count,
      };

      let aiHistorySaveError: string | null = null;
      try {
        const savedAiReport = await saveAiReportHistoryEntry({
          title: buildAiReportHistoryTitle({
            leftDocumentCount: comparisonTargetDocumentIds.length,
            rightDocumentCount: comparisonReferenceDocumentIds.length,
            rightLawCount: selectedLawVersionIds.length,
          }),
          selectionSummary: getSelectionSummary(
            comparisonTargetDocumentIds.length,
            comparisonReferenceDocumentIds.length,
            selectedLawVersionIds.length,
          ),
          selectionCounts: {
            leftDocumentCount: comparisonTargetDocumentIds.length,
            rightDocumentCount: comparisonReferenceDocumentIds.length,
            rightLawCount: selectedLawVersionIds.length,
          },
          guidance: finalGuidance,
        });
        if (selectedLawVersionIds.length === 0) {
          setPendingAiOnlyReportHistoryId(savedAiReport.id);
        }
      } catch (error) {
        aiHistorySaveError =
          error instanceof Error ? error.message : "AI 리포트 이력 저장에 실패했습니다.";
      }

      setComparisonAnalysisState({
        aiGuidance: finalGuidance,
        leftGroupReport: leftStage.left_group_report,
        rightGroupReport: rightStage.right_group_report,
        comparisonReport: finalStage.comparison_report,
        aiAnalysisError: null,
        apiCallCount: finalStage.api_call_count,
        isAnalyzingSelection: false,
        analysisStageLabel: "3단계 리포트 생성 완료",
        analysisStagePhase: "complete",
        analysisStageStartedAt: Date.now(),
      });
      setStatus(
        aiHistorySaveError
          ? `3단계 최종 비교 리포트 생성은 완료됐지만 AI 리포트 이력 저장에 실패했습니다. ${aiHistorySaveError}`
          : "3단계 최종 비교 리포트 생성이 완료되었습니다. AI 리포트 이력에도 저장했습니다.",
      );
      setActiveWorkspaceSection("results");
    })().catch((error: Error) => {
      if (cancelled) {
        return;
      }

      setComparisonAnalysisState({
        ...emptyComparisonAnalysisState,
        aiAnalysisError: error.message,
      });
      setStatus(error.message);
    });

    return () => {
      cancelled = true;
    };
  }, [
    analysisRequestKey,
    activePromptSlotByStage,
    comparisonReferenceDocumentIds,
    comparisonTargetDocumentIds,
    openAiSettings,
    promptOverrides,
    selectedLawVersionIds,
  ]);

  useEffect(() => {
    if (
      !pendingAiOnlyReviewHistoryId ||
      !pendingAiOnlyReportHistoryId ||
      !comparisonAnalysisState.aiGuidance ||
      selectedLawVersionIds.length > 0
    ) {
      return;
    }

    let cancelled = false;

    updateReviewExecutionHistoryStatus({
      entryId: pendingAiOnlyReviewHistoryId,
      resultStatus: "ai_completed",
      aiReportHistoryId: pendingAiOnlyReportHistoryId,
    })
      .then((updatedEntry) => {
        if (cancelled) {
          return;
        }

        setReviewExecutionHistory((current) =>
          current.map((entry) => (entry.id === updatedEntry.id ? updatedEntry : entry)),
        );
        setPendingAiOnlyReviewHistoryId(null);
        setPendingAiOnlyReportHistoryId(null);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }

        setReviewExecutionHistory((current) =>
          current.map((entry) =>
            entry.id === pendingAiOnlyReviewHistoryId
              ? { ...entry, resultStatus: "ai_completed" }
              : entry,
          ),
        );
        setPendingAiOnlyReviewHistoryId(null);
        setPendingAiOnlyReportHistoryId(null);
      });

    return () => {
      cancelled = true;
    };
  }, [
    comparisonAnalysisState.aiGuidance,
    pendingAiOnlyReportHistoryId,
    pendingAiOnlyReviewHistoryId,
    selectedLawVersionIds.length,
  ]);

  useEffect(() => {
    const hasSelectionContext =
      comparisonTargetDocumentIds.length > 0 &&
      (comparisonReferenceDocumentIds.length > 0 || selectedLawVersionIds.length > 0);

    if (!hasSelectionContext || analysisRequestKey === 0) {
      setComparisonOverview(null);
      return;
    }

    setComparisonOverview({
      selectionSummary: `비교 대상 ${comparisonTargetDocumentIds.length}개, 기준 ${
        comparisonReferenceDocumentIds.length + selectedLawVersionIds.length
      }개가 현재 분석 범위에 포함되어 있습니다.`,
      selectionCounts: {
        leftDocumentCount: comparisonTargetDocumentIds.length,
        rightDocumentCount: comparisonReferenceDocumentIds.length,
        rightLawCount: selectedLawVersionIds.length,
      },
      apiCallCount: comparisonAnalysisState.apiCallCount,
      stageProgress: getStageProgress({
        leftGroupReport: comparisonAnalysisState.leftGroupReport,
        rightGroupReport: comparisonAnalysisState.rightGroupReport,
        comparisonReport: comparisonAnalysisState.comparisonReport,
        isAnalyzingSelection: comparisonAnalysisState.isAnalyzingSelection,
        analysisStageLabel: comparisonAnalysisState.analysisStageLabel,
        analysisStagePhase: comparisonAnalysisState.analysisStagePhase,
        analysisStageStartedAt: comparisonAnalysisState.analysisStageStartedAt,
        now: Date.now(),
      }),
    });
  }, [
    analysisRequestKey,
    comparisonAnalysisState,
    comparisonReferenceDocumentIds.length,
    comparisonTargetDocumentIds.length,
    selectedLawVersionIds.length,
  ]);

  useEffect(() => {
    if (!sessionUserId || !workspaceSelectionHydrated) {
      return;
    }

    writeWorkspaceSelection(sessionUserId, {
      selectedDocumentId,
      targetDocumentIds: comparisonTargetDocumentIds,
      referenceDocumentIds: comparisonReferenceDocumentIds,
      lawVersionIds: selectedLawVersionIds,
    });
  }, [
    sessionUserId,
    workspaceSelectionHydrated,
    selectedDocumentId,
    comparisonTargetDocumentIds,
    comparisonReferenceDocumentIds,
    selectedLawVersionIds,
  ]);

  useEffect(() => {
    let cancelled = false;

    if (!session?.access_token) {
      openAiSettingsDirtyRef.current = false;
      setOpenAiSettings({
        apiKey: "",
        model: DEFAULT_OPENAI_MODEL,
      });
      setOpenAiSettingsHydrated(true);
      return () => {
        cancelled = true;
      };
    }

    setOpenAiSettingsHydrated(false);
    getPolicyUserOpenAiSettings(DEFAULT_OPENAI_MODEL)
      .then((settings) => {
        if (cancelled) {
          return;
        }
        openAiSettingsDirtyRef.current = false;
        setOpenAiSettings(settings);
        setOpenAiSettingsHydrated(true);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        openAiSettingsDirtyRef.current = false;
        setOpenAiSettings({
          apiKey: "",
          model: DEFAULT_OPENAI_MODEL,
        });
        setOpenAiSettingsHydrated(true);
      });

    return () => {
      cancelled = true;
    };
  }, [session?.access_token]);

  useEffect(() => {
    if (!openAiSettingsHydrated || !session?.access_token) {
      return;
    }

    if (!openAiSettingsDirtyRef.current) {
      return;
    }

    if (openAiSettingsSaveTimerRef.current !== null) {
      window.clearTimeout(openAiSettingsSaveTimerRef.current);
    }

    const requestId = openAiSettingsSaveRequestIdRef.current + 1;
    openAiSettingsSaveRequestIdRef.current = requestId;
    openAiSettingsSaveTimerRef.current = window.setTimeout(() => {
      void savePolicyUserOpenAiSettings(openAiSettings, DEFAULT_OPENAI_MODEL)
        .then(() => {
          if (openAiSettingsSaveRequestIdRef.current === requestId) {
            openAiSettingsDirtyRef.current = false;
          }
        })
        .catch(() => undefined);
    }, 400);

    return () => {
      if (openAiSettingsSaveTimerRef.current !== null) {
        window.clearTimeout(openAiSettingsSaveTimerRef.current);
        openAiSettingsSaveTimerRef.current = null;
      }
    };
  }, [openAiSettings, openAiSettingsHydrated, session?.access_token]);

  useEffect(() => {
    let cancelled = false;

    if (!session?.access_token) {
      securitySettingsDirtyRef.current = false;
      setSecuritySettings(DEFAULT_SECURITY_SETTINGS);
      setSecuritySettingsHydrated(true);
      return () => {
        cancelled = true;
      };
    }

    setSecuritySettingsHydrated(false);
    getPolicySecuritySettings(DEFAULT_SECURITY_SETTINGS)
      .then((settings) => {
        if (cancelled) {
          return;
        }
        securitySettingsDirtyRef.current = false;
        setSecuritySettings(settings);
        setSecuritySettingsHydrated(true);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        securitySettingsDirtyRef.current = false;
        setSecuritySettings(DEFAULT_SECURITY_SETTINGS);
        setSecuritySettingsHydrated(true);
      });

    return () => {
      cancelled = true;
    };
  }, [session?.access_token]);

  useEffect(() => {
    if (!securitySettingsHydrated || !session?.access_token) {
      return;
    }

    if (!securitySettingsDirtyRef.current) {
      return;
    }

    if (securitySettingsSaveTimerRef.current !== null) {
      window.clearTimeout(securitySettingsSaveTimerRef.current);
    }

    const requestId = securitySettingsSaveRequestIdRef.current + 1;
    securitySettingsSaveRequestIdRef.current = requestId;
    securitySettingsSaveTimerRef.current = window.setTimeout(() => {
      void savePolicySecuritySettings(securitySettings, DEFAULT_SECURITY_SETTINGS)
        .then((savedSettings) => {
          if (securitySettingsSaveRequestIdRef.current === requestId) {
            securitySettingsDirtyRef.current = false;
            setSecuritySettings(savedSettings);
            setAppNotice({
              tone: "success",
              label: "설정 저장",
              title: "인증/세션 정책을 자동 저장했습니다.",
              detail: `허용 도메인: ${savedSettings.allowedEmailDomain}, 세션 타임아웃: ${savedSettings.sessionIdleTimeoutMinutes}분`,
            });
          }
        })
        .catch((error) => {
          setAppNotice({
            tone: "danger",
            label: "설정 저장 실패",
            title: "인증/세션 정책을 저장하지 못했습니다.",
            detail: error instanceof Error ? error.message : "잠시 후 다시 시도하세요.",
          });
        });
    }, 3000);

    return () => {
      if (securitySettingsSaveTimerRef.current !== null) {
        window.clearTimeout(securitySettingsSaveTimerRef.current);
        securitySettingsSaveTimerRef.current = null;
      }
    };
  }, [securitySettings, securitySettingsHydrated, session?.access_token]);

  useEffect(() => {
    if (!session?.user.email || !securitySettingsHydrated || embeddedWorkspace) {
      return;
    }

    if (!isAllowedEmailDomain(session.user.email)) {
      void rejectDisallowedSession(session.user.email);
    }
  }, [
    embeddedWorkspace,
    securitySettings.allowedEmailDomain,
    securitySettingsHydrated,
    session?.user.email,
  ]);

  async function handleUpload(file: File, title: string, description: string) {
    setAppNotice({
      tone: "info",
      label: "업로드 진행",
      title: "문서를 업로드하고 구조화 섹션을 등록하는 중입니다...",
      detail: `${file.name} 파일을 읽어 장·조·항·호·목 구조로 파싱합니다.`,
      actions: ["업로드가 끝날 때까지 현재 탭을 유지하세요."],
      debug: [`upload file=${file.name}`, `title=${title || file.name}`, `size=${file.size}`],
    });
    try {
      await uploadDocument({ file, title, description });
      const [documentItems, lawVersionItems, comparisonItems] = await Promise.all([
        listDocuments(),
        listLawVersions(),
        listComparisonRuns(),
      ]);
      setDocuments(documentItems);
      setLawVersions(lawVersionItems);
      setComparisonRuns(comparisonItems);
      setSelectedDocumentId((current) =>
        current && documentItems.some((item) => item.id === current) ? current : null,
      );
      setCheckedDocumentIds((current) =>
        current.filter((id) => documentItems.some((item) => item.id === id)),
      );
      setComparisonTargetDocumentIds((current) =>
        current.filter((id) => documentItems.some((item) => item.id === id)),
      );
      setComparisonReferenceDocumentIds((current) =>
        current.filter((id) => documentItems.some((item) => item.id === id)),
      );
      setSelectedLawVersionIds((current) =>
        current.filter((id) => lawVersionItems.some((item) => item.id === id)),
      );
      setSelectedComparisonRunId((current) =>
        current && comparisonItems.some((item) => item.id === current) ? current : null,
      );
      setAppNotice({
        tone: "success",
        label: "업로드 완료",
        title: "문서 업로드와 구조 파싱이 완료되었습니다.",
        detail: `"${title || file.name}" 문서가 목록에 반영되었습니다.`,
        actions: ["문서 목록에서 방금 올린 문서를 선택해 구조를 확인하세요.", "비교 대상 그룹으로 드래그해 비교 플로우를 이어가세요."],
        debug: [`documents=${documentItems.length}`, `comparison_runs=${comparisonItems.length}`],
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "문서 업로드 중 오류가 발생했습니다.";
      setAppNotice({
        tone: "danger",
        label: "업로드 실패",
        title: "문서 업로드 중 오류가 발생했습니다.",
        detail: message,
        actions: ["지원 형식(txt, md, docx)인지 확인하세요.", "로그인 세션이 유효한지 확인한 뒤 다시 시도하세요."],
        debug: [`upload error=${message}`],
      });
    }
  }

  async function handleExportDocumentsXlsx() {
    if (documents.length === 0) {
      return;
    }

    setAppNotice({
      tone: "info",
      label: "XLSX 내보내기",
      title: "전체 문서 목록을 XLSX로 생성하는 중입니다...",
      detail: `${documents.length}개 문서의 장·조·항·호·목과 내용을 불러옵니다.`,
      debug: [`export document_count=${documents.length}`],
    });

    try {
      const workbook = XLSX.utils.book_new();
      const usedSheetNames = new Set<string>(["문서 목록"]);
      const indexRows: Array<{
        번호: number;
        문서명: string;
        시트명: string;
        시행일: string;
        섹션수: number;
      }> = [];

      for (const document of documents) {
        const detail = await getDocumentDetail(document.id);
        const sheetName = buildUniqueXlsxSheetName(detail.title, usedSheetNames);
        indexRows.push({
          번호: indexRows.length + 1,
          문서명: detail.title,
          시트명: sheetName,
          시행일: detail.metadata?.revisionDate ?? "",
          섹션수: detail.sections.length,
        });
        const rows = detail.sections.flatMap((section, index) => buildXlsxContentRows({
          행번호: index + 1,
          문서명: detail.title,
          장: section.chapter_label ?? "",
          조: section.article_label ?? "",
          항: section.paragraph_label ?? "",
          호: section.item_label ?? "",
          목: section.sub_item_label ?? "",
          내용: section.original_text,
        }));
        const worksheet = XLSX.utils.json_to_sheet(rows.length > 0 ? rows : buildXlsxContentRows({ 행번호: 1, 문서명: detail.title, 장: "", 조: "", 항: "", 호: "", 목: "", 내용: detail.raw_text }));
        worksheet["!cols"] = [
          { wch: 60 },
          { wch: 10 },
          { wch: 10 },
          { wch: 10 },
          { wch: 14 },
          { wch: 8 },
          { wch: 8 },
          { wch: 8 },
          { wch: 100 },
        ];
        XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
      }

      const indexWorksheet = XLSX.utils.json_to_sheet(indexRows);
      indexWorksheet["!cols"] = [
        { wch: 8 },
        { wch: 60 },
        { wch: 34 },
        { wch: 14 },
        { wch: 10 },
      ];
      workbook.SheetNames.unshift("문서 목록");
      workbook.Sheets["문서 목록"] = indexWorksheet;

      downloadWorkbookXlsx(workbook, `policy-documents-${formatDateStamp(new Date())}.xlsx`);
      setAppNotice({
        tone: "success",
        label: "XLSX 내보내기 완료",
        title: "전체 문서 목록을 XLSX로 내보냈습니다.",
        detail: "각 문서는 시트별로 장·조·항·호·목·내용 컬럼에 담겼습니다.",
        debug: [`exported document_count=${documents.length}`],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "XLSX 내보내기 중 오류가 발생했습니다.";
      setAppNotice({
        tone: "danger",
        label: "XLSX 내보내기 실패",
        title: "XLSX 내보내기 중 오류가 발생했습니다.",
        detail: message,
        debug: [`xlsx export error=${message}`],
      });
    }
  }

  async function handleImportDocumentsXlsx(file: File) {
    setAppNotice({
      tone: "info",
      label: "XLSX 가져오기",
      title: "XLSX 문서를 데이터베이스에 저장하는 중입니다...",
      detail: "각 시트의 내용 컬럼을 그대로 이어 원문으로 저장합니다.",
      debug: [`import file=${file.name}`, `size=${file.size}`],
    });

    try {
      const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
      const titleBySheetName = readXlsxDocumentTitleMap(workbook);
      const imports = workbook.SheetNames.filter((sheetName) => sheetName !== "문서 목록").map((sheetName) => {
        const worksheet = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet, { defval: "" });
        const titleFromRows = rows
          .map((row) => String(row["문서명"] ?? "").trim())
          .find(Boolean);
        const structuredRows = buildImportedXlsxRows(rows);
        const rawText = structuredRows.map((row) => row.content).join("\n");

        return {
          title: titleFromRows || titleBySheetName.get(sheetName)?.trim() || sheetName.trim() || file.name.replace(/\.[^.]+$/u, ""),
          rows: structuredRows,
          rawText,
        };
      }).filter((entry) => entry.rawText.trim().length > 0);

      if (imports.length === 0) {
        throw new Error("가져올 내용 컬럼이 없습니다. XLSX에 '내용' 컬럼이 필요합니다.");
      }

      for (const entry of imports) {
        await uploadStructuredRowsDocument({
          rows: entry.rows,
          title: entry.title,
          description: `XLSX import: ${file.name}`,
          sourceFileName: `${sanitizeFileName(entry.title)}.xlsx`,
        });
      }

      const [documentItems, lawVersionItems, comparisonItems] = await Promise.all([
        listDocuments(),
        listLawVersions(),
        listComparisonRuns(),
      ]);
      setDocuments(documentItems);
      setLawVersions(lawVersionItems);
      setComparisonRuns(comparisonItems);
      setSelectedDocumentId(documentItems[0]?.id ?? null);
      setDocumentPreviewRefreshKey((current) => current + 1);
      setAppNotice({
        tone: "success",
        label: "XLSX 가져오기 완료",
        title: "XLSX 문서를 데이터베이스에 저장했습니다.",
        detail: `${imports.length}개 시트를 문서로 등록했습니다. 내용 컬럼은 그대로 원문에 저장했습니다.`,
        debug: [`imported sheets=${imports.length}`],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "XLSX 가져오기 중 오류가 발생했습니다.";
      setAppNotice({
        tone: "danger",
        label: "XLSX 가져오기 실패",
        title: "XLSX 가져오기 중 오류가 발생했습니다.",
        detail: message,
        actions: ["시트에 장, 조, 항, 호, 목, 내용 컬럼이 있는지 확인하세요."],
        debug: [`xlsx import error=${message}`],
      });
    }
  }

  async function refreshDocumentSummariesAfterSave() {
    const documentItems = await listDocuments();
    setDocuments(documentItems);
    setSelectedDocumentId((current) =>
      current && documentItems.some((item) => item.id === current) ? current : null,
    );
    setCheckedDocumentIds((current) =>
      current.filter((id) => documentItems.some((item) => item.id === id)),
    );
    setComparisonTargetDocumentIds((current) =>
      current.filter((id) => documentItems.some((item) => item.id === id)),
    );
    setComparisonReferenceDocumentIds((current) =>
      current.filter((id) => documentItems.some((item) => item.id === id)),
    );
  }

  async function handleDocumentSaved() {
    try {
      await refreshDocumentSummariesAfterSave();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "문서 목록 새로고침 중 오류가 발생했습니다.";
      setAppNotice({
        tone: "warning",
        label: "목록 갱신 실패",
        title: "문서는 저장됐지만 문서 목록을 새로고침하지 못했습니다.",
        detail: message,
        actions: ["문서 내용은 저장되었습니다.", "필요하면 새로고침 후 목록 정보를 다시 확인하세요."],
        debug: [`document summary refresh error=${message}`],
      });
    }
  }

  async function handleDeleteDocument(document: DocumentSummary) {
    if (pendingDeleteDocumentId !== document.id) {
      setPendingDeleteDocumentId(document.id);
      setAppNotice({
        tone: "warning",
        label: "삭제 확인",
        title: `"${document.title}" 문서를 삭제할까요?`,
        detail: "삭제하려면 같은 문서의 삭제 버튼을 한 번 더 누르세요.",
        actions: ["두 번째 클릭에서 실제 삭제가 진행됩니다.", "다른 문서를 누르면 확인 대상이 바뀝니다."],
        debug: [`delete pending document_id=${document.id}`],
      });
      return;
    }

    setDeletingDocumentId(document.id);
    setPendingDeleteDocumentId(null);
    setAppNotice({
      tone: "warning",
      label: "삭제 진행",
      title: "문서를 삭제하는 중입니다...",
      detail: `"${document.title}"와 연결된 선택 상태를 함께 정리합니다.`,
      debug: [`delete start document_id=${document.id}`],
    });

    try {
      await deleteDocument({ documentId: document.id });
      const [documentItems, lawVersionItems, comparisonItems] = await Promise.all([
        listDocuments(),
        listLawVersions(),
        listComparisonRuns(),
      ]);
      setDocuments(documentItems);
      setLawVersions(lawVersionItems);
      setComparisonRuns(comparisonItems);
      setSelectedDocumentId((current) =>
        current && documentItems.some((item) => item.id === current) ? current : null,
      );
      setCheckedDocumentIds((current) =>
        current.filter((id) => documentItems.some((item) => item.id === id)),
      );
      setComparisonTargetDocumentIds((current) =>
        current.filter((id) => documentItems.some((item) => item.id === id)),
      );
      setComparisonReferenceDocumentIds((current) =>
        current.filter((id) => documentItems.some((item) => item.id === id)),
      );
      setSelectedComparisonRunId((current) =>
        current && comparisonItems.some((item) => item.id === current) ? current : null,
      );
      setAppNotice({
        tone: "success",
        label: "삭제 완료",
        title: "문서 삭제가 완료되었습니다.",
        detail: "문서 목록과 비교 대상 그룹에서 해당 항목을 정리했습니다.",
        debug: [`documents=${documentItems.length}`, `comparison_runs=${comparisonItems.length}`],
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "문서 삭제 중 오류가 발생했습니다.";
      setAppNotice({
        tone: "danger",
        label: "삭제 실패",
        title: "문서 삭제 중 오류가 발생했습니다.",
        detail: message,
        debug: [`delete error=${message}`],
      });
    } finally {
      setDeletingDocumentId(null);
    }
  }

  async function handleReparseDocument(document: DocumentSummary) {
    setReparsingDocumentId(document.id);
    setAppNotice({
      tone: "info",
      label: "문서 재파싱",
      title: "문서 구조를 최신 규칙으로 다시 파싱하는 중입니다...",
      detail: `"${document.title}"의 장·조·항·호·목 구조를 다시 계산합니다.`,
      debug: [`reparse start document_id=${document.id}`],
    });

    try {
      await reparseDocument({ documentId: document.id });
      const [documentItems, comparisonItems] = await Promise.all([
        listDocuments(),
        listComparisonRuns(),
      ]);
      setDocuments(documentItems);
      setComparisonRuns(comparisonItems);
      setSelectedDocumentId((current) =>
        current && documentItems.some((item) => item.id === current) ? current : document.id,
      );
      setCheckedDocumentIds((current) =>
        current.filter((id) => documentItems.some((item) => item.id === id)),
      );
      setComparisonTargetDocumentIds((current) =>
        current.filter((id) => documentItems.some((item) => item.id === id)),
      );
      setComparisonReferenceDocumentIds((current) =>
        current.filter((id) => documentItems.some((item) => item.id === id)),
      );
      setSelectedComparisonRunId((current) =>
        current && comparisonItems.some((item) => item.id === current) ? current : null,
      );
      setAppNotice({
        tone: "success",
        label: "문서 재파싱",
        title: "문서 구조를 최신 규칙으로 다시 파싱했습니다.",
        detail: `"${document.title}"의 구조화 섹션을 새 규칙으로 갱신했습니다.`,
        actions: ["문서 보기 패널에서 항·호 분리가 올바른지 확인하세요."],
        debug: [`documents=${documentItems.length}`, `comparison_runs=${comparisonItems.length}`],
      });
      setDocumentPreviewRefreshKey((current) => current + 1);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "문서 재파싱 중 오류가 발생했습니다.";
      setAppNotice({
        tone: "danger",
        label: "문서 재파싱 실패",
        title: "문서 재파싱 중 오류가 발생했습니다.",
        detail: message,
        debug: [`reparse error=${message}`],
      });
    } finally {
      setReparsingDocumentId(null);
    }
  }

  async function handleReparseAllDocuments(input: { automatic?: boolean } = {}) {
    const targetDocuments = [...documents];
    if (targetDocuments.length === 0) {
      return;
    }

    setIsReparsingAllDocuments(true);
    setAppNotice({
      tone: "info",
      label: input.automatic ? "문서 전체 재파싱" : "전체 재파싱",
      title: input.automatic
        ? "기존 문서에 최신 조문 파싱 규칙을 적용하는 중입니다..."
        : "모든 문서를 최신 규칙으로 다시 파싱하는 중입니다...",
      detail: `${targetDocuments.length}개 문서의 제N조의X 조문과 장·조·항·호·목 구조를 다시 계산합니다.`,
      debug: [`bulk reparse count=${targetDocuments.length}`],
    });

    let completedCount = 0;
    try {
      for (const document of targetDocuments) {
        setReparsingDocumentId(document.id);
        await reparseDocument({ documentId: document.id });
        completedCount += 1;
      }

      const [documentItems, comparisonItems] = await Promise.all([
        listDocuments(),
        listComparisonRuns(),
      ]);
      setDocuments(documentItems);
      setComparisonRuns(comparisonItems);
      setSelectedDocumentId((current) =>
        current && documentItems.some((item) => item.id === current)
          ? current
          : (documentItems[0]?.id ?? null),
      );
      setCheckedDocumentIds((current) =>
        current.filter((id) => documentItems.some((item) => item.id === id)),
      );
      setComparisonTargetDocumentIds((current) =>
        current.filter((id) => documentItems.some((item) => item.id === id)),
      );
      setComparisonReferenceDocumentIds((current) =>
        current.filter((id) => documentItems.some((item) => item.id === id)),
      );
      setSelectedComparisonRunId((current) =>
        current && comparisonItems.some((item) => item.id === current) ? current : null,
      );
      setDocumentPreviewRefreshKey((current) => current + 1);
      if (sessionUserId) {
        writeDocumentParserReparseVersion(sessionUserId, DOCUMENT_PARSER_REPARSE_VERSION);
      }
      setAppNotice({
        tone: "success",
        label: "전체 재파싱 완료",
        title: "모든 기존 문서에 최신 파싱 규칙을 적용했습니다.",
        detail: `${completedCount}개 문서를 다시 파싱했습니다. 제7조의1 같은 조문은 조 컬럼에 들어갑니다.`,
        debug: [`bulk reparse completed=${completedCount}`],
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "전체 문서 재파싱 중 오류가 발생했습니다.";
      setAppNotice({
        tone: "danger",
        label: "전체 재파싱 실패",
        title: "전체 문서 재파싱 중 오류가 발생했습니다.",
        detail: `${completedCount}/${targetDocuments.length}개 처리 후 중단되었습니다. ${message}`,
        debug: [`bulk reparse error=${message}`, `completed=${completedCount}`],
      });
    } finally {
      setReparsingDocumentId(null);
      setIsReparsingAllDocuments(false);
      if (input.automatic && sessionUserId) {
        writeDocumentParserReparseVersion(sessionUserId, DOCUMENT_PARSER_REPARSE_VERSION);
      }
    }
  }

  async function handleDeleteLawSource(lawVersionId: string) {
    setAppNotice({
      tone: "warning",
      label: "법령 정리",
      title: "법령을 삭제하는 중입니다...",
      detail: "선택된 기준 그룹에서도 함께 제거됩니다.",
      debug: [`delete law_version_id=${lawVersionId}`],
    });

    try {
      await deleteLawSource({ lawVersionId });
      const lawVersionItems = await listLawVersions();
      setLawVersions(lawVersionItems);
      setSelectedLawVersionIds((current) => current.filter((id) => id !== lawVersionId));
      setAppNotice({
        tone: "success",
        label: "법령 정리",
        title: "법령 삭제가 완료되었습니다.",
        detail: "기준과 등록된 법령 목록을 새로 고쳤습니다.",
        debug: [`law_versions=${lawVersionItems.length}`],
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "법령 삭제 중 오류가 발생했습니다.";
      setAppNotice({
        tone: "danger",
        label: "법령 정리 실패",
        title: "법령 삭제 중 오류가 발생했습니다.",
        detail: message,
        debug: [`law delete error=${message}`],
      });
    }
  }

  async function handleReparseLawSource(lawVersionId: string) {
    setAppNotice({
      tone: "info",
      label: "법령 재파싱",
      title: "법령 구조를 최신 규칙으로 다시 파싱하는 중입니다...",
      detail: "장·조·항·호·목 구조를 다시 계산해 비교 정확도를 높입니다.",
      debug: [`reparse law_version_id=${lawVersionId}`],
    });

    try {
      await reparseLawSource({ lawVersionId });
      const lawVersionItems = await listLawVersions();
      setLawVersions(lawVersionItems);
      setSelectedLawVersionIds((current) =>
        current.filter((id) => lawVersionItems.some((item) => item.id === id)),
      );
      setAppNotice({
        tone: "success",
        label: "법령 재파싱",
        title: "법령 구조를 최신 규칙으로 다시 파싱했습니다.",
        detail: "선택 상태는 유지한 채 구조 정보만 갱신했습니다.",
        debug: [`law_versions=${lawVersionItems.length}`],
      });
      setLawPreviewRefreshKey((current) => current + 1);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "법령 재파싱 중 오류가 발생했습니다.";
      setAppNotice({
        tone: "danger",
        label: "법령 재파싱 실패",
        title: "법령 재파싱 중 오류가 발생했습니다.",
        detail: message,
        actions: ["원문 링크 또는 저장된 원문 데이터를 확인하세요.", "필요하면 법령을 다시 등록하세요."],
        debug: [`law reparse error=${message}`],
      });
    }
  }

  async function handleRunComparison() {
    const selectedDocuments = documents.filter(
      (document) => comparisonTargetDocumentIds.includes(document.id) && document.version_id,
    );
    const selectedReferenceDocuments = documents.filter((document) =>
      comparisonReferenceDocumentIds.includes(document.id),
    );

    if (selectedDocuments.length === 0) {
      setAppNotice({
        tone: "warning",
        label: "비교 실행 차단",
        title: "비교할 정책 또는 지침을 선택하세요.",
        detail: "비교 대상이 비어 있으면 비교를 시작할 수 없습니다.",
        actions: ["문서 목록에서 문서를 비교 대상으로 드래그하세요."],
        debug: ["comparison blocked target_count=0"],
      });
      return;
    }

    if (selectedReferenceDocuments.length === 0 && selectedLawVersionIds.length === 0) {
      setAppNotice({
        tone: "warning",
        label: "비교 실행 차단",
        title: "기준에 비교 기준 문서 또는 기준 법률을 선택하세요.",
        detail: "비교 기준이 없으면 차이 분석과 AI 권고를 만들 수 없습니다.",
        actions: ["문서를 기준으로 드래그하거나 등록된 법령을 추가하세요."],
        debug: ["comparison blocked reference_count=0", "comparison blocked law_count=0"],
      });
      return;
    }

    setAppNotice({
      tone: "info",
      label: "검토 실행 시작",
      title: "검토 실행을 시작했습니다.",
      detail: `${selectedDocuments.length}개 비교 대상과 ${selectedReferenceDocuments.length + selectedLawVersionIds.length}개 기준으로 분석을 준비 중입니다.`,
      actions: ["하단 진행 박스에서 현재 분석 범위와 단계 진행 상태를 확인하세요."],
      debug: [
        `target_count=${selectedDocuments.length}`,
        `reference_count=${selectedReferenceDocuments.length}`,
        `law_count=${selectedLawVersionIds.length}`,
        "ai_analysis_requested=true",
      ],
    });

    const reviewHistoryBase = createReviewExecutionHistoryEntry({
      reviewerEmail: session?.user.email ?? "알 수 없음",
      targetTitles: selectedDocuments.map((item) => item.title),
      referenceTitles: [
        ...selectedReferenceDocuments.map((item) => item.title),
        ...selectedLawVersionIds
          .map((lawVersionId) => lawVersions.find((item) => item.id === lawVersionId)?.source_title)
          .filter((value): value is string => Boolean(value)),
      ],
    });

    if (selectedLawVersionIds.length === 0) {
      setAnalysisRequestKey((current) => current + 1);
      setPendingAiOnlyReportHistoryId(null);
      let reviewHistorySaveWarning: string | null = null;
      try {
        const savedHistoryEntry = await saveReviewExecutionHistoryEntry({
          reviewerEmail: reviewHistoryBase.reviewerEmail,
          targetTitles: reviewHistoryBase.targetTitles,
          referenceTitles: reviewHistoryBase.referenceTitles,
          comparisonRunIds: [],
          resultStatus: "pending",
        });
        setPendingAiOnlyReviewHistoryId(savedHistoryEntry.id);
        setReviewExecutionHistory((current) => [savedHistoryEntry, ...current].slice(0, 50));
      } catch (error) {
        reviewHistorySaveWarning =
          error instanceof Error
            ? `검토 실행 이력 저장 실패: ${error.message}`
            : "검토 실행 이력을 데이터베이스에 저장하지 못했습니다.";
      }
      setAppNotice({
        tone: reviewHistorySaveWarning ? "warning" : "info",
        label: "검토 실행 중",
        title: `비교 대상 정책·지침 ${selectedDocuments.length}건과 기준 문서 ${selectedReferenceDocuments.length}건의 AI 검토를 진행 중입니다.`,
        detail: [
          "법령 없이 문서 간 갭 분석만 순차 실행합니다.",
          reviewHistorySaveWarning,
        ].filter(Boolean).join("\n\n"),
        actions: ["하단 진행 박스에서 1단계, 2단계, 3단계 진행 상태를 확인하세요."],
        debug: [`target_count=${selectedDocuments.length}`, `reference_count=${selectedReferenceDocuments.length}`, "law_count=0"],
      });
      return;
    }

    setAnalysisRequestKey((current) => current + 1);
    setPendingAiOnlyReviewHistoryId(null);
    setPendingAiOnlyReportHistoryId(null);

    setAppNotice({
      tone: "info",
      label: "비교 실행",
      title: "비교 대상·기준 AI 비교 리포트와 법령 비교를 함께 실행하는 중입니다...",
      detail: `${selectedDocuments.length}개 정책·지침과 ${selectedLawVersionIds.length}개 법령 조합의 결정론 비교를 진행하면서, 비교 대상·기준 OpenAI 리포트도 별도로 생성합니다.`,
      actions: ["하단 비교 검토 패널에서 3단계 AI 리포트가 먼저 표시되는지 확인하세요."],
      debug: [
        `target_count=${selectedDocuments.length}`,
        `reference_count=${selectedReferenceDocuments.length}`,
        `law_count=${selectedLawVersionIds.length}`,
        "ai_analysis_requested=true",
      ],
    });

    try {
      const results = [];

      for (const document of selectedDocuments) {
        for (const lawVersionId of selectedLawVersionIds) {
          const result = await runComparison({
            documentVersionId: document.version_id as string,
            lawVersionId,
          });
          results.push(result);
        }
      }

      const comparisonItems = await listComparisonRuns();
      setComparisonRuns(comparisonItems);
      const comparisonRunIds = results
        .map(
          (item) =>
            (item as { data?: { comparisonRunId?: unknown } } | null)?.data?.comparisonRunId,
        )
        .filter((value): value is string => typeof value === "string");
      let reviewHistorySaveWarning: string | null = null;
      try {
        const savedHistoryEntry = await saveReviewExecutionHistoryEntry({
          reviewerEmail: reviewHistoryBase.reviewerEmail,
          targetTitles: reviewHistoryBase.targetTitles,
          referenceTitles: reviewHistoryBase.referenceTitles,
          comparisonRunIds,
          resultStatus: "comparison_completed",
        });
        setPendingAiOnlyReviewHistoryId(null);
        setPendingAiOnlyReportHistoryId(null);
        setReviewExecutionHistory((current) => [savedHistoryEntry, ...current].slice(0, 50));
      } catch (error) {
        reviewHistorySaveWarning =
          error instanceof Error
            ? `검토 실행 이력 저장 실패: ${error.message}`
            : "검토 실행 이력을 데이터베이스에 저장하지 못했습니다.";
      }
      const comparisonRunId =
        (() => {
          const first = (results[0] as { data?: { comparisonRunId?: unknown } } | undefined)?.data
            ?.comparisonRunId;
          return typeof first === "string" ? first : null;
        })() ??
        comparisonItems[0]?.id ??
        null;
      setSelectedComparisonRunId(comparisonRunId);
      setAppNotice({
        tone: reviewHistorySaveWarning ? "warning" : "success",
        label: "비교 완료",
        title: `비교 대상 정책·지침 ${selectedDocuments.length}건, 기준 문서 ${selectedReferenceDocuments.length}건, 기준 법률 ${selectedLawVersionIds.length}건의 결정론 비교가 완료되었습니다.`,
        detail: [
          "AI 3단계 리포트와 비교 결과를 함께 검토할 수 있습니다.",
          reviewHistorySaveWarning,
        ].filter(Boolean).join("\n\n"),
        actions: ["하단 비교 검토 패널에서 비교 대상 정리, 기준 정리, 최종 비교 리포트를 확인하세요."],
        debug: [
          `comparison_runs=${comparisonItems.length}`,
          `selected_run=${comparisonRunId ?? "none"}`,
          "ai_analysis_requested=true",
        ],
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "비교 실행 중 오류가 발생했습니다.";
      setAppNotice({
        tone: "warning",
        label: "결정론 비교 실패",
        title: "법령 기준 결정론 비교 실행 중 오류가 발생했습니다.",
        detail: `결정론 비교는 실패했지만, 비교 대상·기준 OpenAI 리포트는 별도로 생성됩니다. ${message}`,
        actions: ["하단 비교 검토 패널에서 3단계 AI 리포트가 생성됐는지 먼저 확인하세요.", "필요하면 구조 섹션과 법령 비교 데이터를 다시 점검하세요."],
        debug: [`comparison error=${message}`, "ai_analysis_requested=true"],
      });
    }
  }

  function handleAddLawVersion(lawVersionId: string) {
    setSelectedLawVersionIds((current) =>
      current.includes(lawVersionId) ? current : [...current, lawVersionId],
    );
    const lawVersion = lawVersions.find((item) => item.id === lawVersionId);
    setAppNotice({
      tone: "info",
      label: "선택 변경",
      title: "기준 법률을 비교 그룹에 추가했습니다.",
      detail: lawVersion?.source_title ?? "선택된 법률을 기준 그룹에 반영했습니다.",
      debug: [`law_version_id=${lawVersionId}`],
    });
  }

  function handleSelectDocument(documentId: string) {
    setSelectedDocumentId(documentId);
    setDocumentPreviewRefreshKey((current) => current + 1);
    const document = documents.find((item) => item.id === documentId);
    setAppNotice({
      tone: "info",
      label: "문서 선택",
      title: "문서 보기에 표시할 문서를 선택했습니다.",
      detail: document ? document.title : "선택한 문서를 불러옵니다.",
      debug: [`document_id=${documentId}`],
    });
  }

  function handleRemoveLawVersion(lawVersionId: string) {
    setSelectedLawVersionIds((current) => current.filter((id) => id !== lawVersionId));
    const lawVersion = lawVersions.find((item) => item.id === lawVersionId);
    setAppNotice({
      tone: "info",
      label: "선택 변경",
      title: "기준 법률을 비교 그룹에서 제거했습니다.",
      detail: lawVersion?.source_title ?? "선택한 법률을 기준 그룹에서 제외했습니다.",
      debug: [`law_version_id=${lawVersionId}`],
    });
  }

  function handleDropTargetDocument(documentId: string) {
    setComparisonTargetDocumentIds((current) =>
      current.includes(documentId) ? current : [...current, documentId],
    );
    setComparisonReferenceDocumentIds((current) => current.filter((id) => id !== documentId));
    const document = documents.find((item) => item.id === documentId);
    setAppNotice({
      tone: "info",
      label: "그룹 이동",
      title: "문서를 비교 대상 그룹으로 이동했습니다.",
      detail: document ? document.title : "선택한 문서를 비교 대상에 배치했습니다.",
      debug: [`document_id=${documentId}`, "group=target"],
    });
  }

  function handleRemoveTargetDocument(documentId: string) {
    setComparisonTargetDocumentIds((current) => current.filter((id) => id !== documentId));
    const document = documents.find((item) => item.id === documentId);
    setAppNotice({
      tone: "info",
      label: "그룹 이동",
      title: "문서를 비교 대상 그룹에서 해제했습니다.",
      detail: document ? document.title : "문서 목록으로 다시 표시됩니다.",
      debug: [`document_id=${documentId}`, "group=target_removed"],
    });
  }

  function handleDropReferenceDocument(documentId: string) {
    setComparisonReferenceDocumentIds((current) =>
      current.includes(documentId) ? current : [...current, documentId],
    );
    setComparisonTargetDocumentIds((current) => current.filter((id) => id !== documentId));
    const document = documents.find((item) => item.id === documentId);
    setAppNotice({
      tone: "info",
      label: "그룹 이동",
      title: "문서를 기준 문서 그룹으로 이동했습니다.",
      detail: document ? document.title : "선택한 문서를 기준 그룹에 배치했습니다.",
      debug: [`document_id=${documentId}`, "group=reference"],
    });
  }

  function handleRemoveReferenceDocument(documentId: string) {
    setComparisonReferenceDocumentIds((current) => current.filter((id) => id !== documentId));
    const document = documents.find((item) => item.id === documentId);
    setAppNotice({
      tone: "info",
      label: "그룹 이동",
      title: "문서를 기준 문서 그룹에서 해제했습니다.",
      detail: document ? document.title : "문서 목록으로 다시 표시됩니다.",
      debug: [`document_id=${documentId}`, "group=reference_removed"],
    });
  }

  async function handleSaveWorkspaceFavorite() {
    if (!sessionUserId) {
      return;
    }

    const snapshot = createWorkspaceSelectionSnapshot({
      selectedDocumentId,
      targetDocumentIds: comparisonTargetDocumentIds,
      referenceDocumentIds: comparisonReferenceDocumentIds,
      lawVersionIds: selectedLawVersionIds,
    });

    if (
      snapshot.targetDocumentIds.length === 0 &&
      snapshot.referenceDocumentIds.length === 0 &&
      snapshot.lawVersionIds.length === 0
    ) {
      setAppNotice({
        tone: "warning",
        label: "즐겨찾기 저장 차단",
        title: "비어 있는 비교 구성을 즐겨찾기로 저장할 수 없습니다.",
        detail: "먼저 좌우 그룹에 문서나 법령을 배치하세요.",
      });
      return;
    }

    const input = window.prompt("현재 비교 구성을 저장할 이름을 입력하세요.");
    if (input === null) {
      return;
    }

    const name = input.trim();
    if (!name) {
      setAppNotice({
        tone: "warning",
        label: "즐겨찾기 저장 차단",
        title: "즐겨찾기 이름이 비어 있어 저장하지 않았습니다.",
      });
      return;
    }

    const updatedAt = new Date().toISOString();
    const existing = workspaceFavorites.find((item) => item.name === name);

    try {
      const savedFavorite = await saveWorkspaceFavorite({
        favoriteId: existing?.id,
        name,
        selection: snapshot,
      });

      setWorkspaceFavorites((current) => {
        const withoutSaved = current.filter((item) => item.id !== savedFavorite.id);
        return [{ ...savedFavorite, updatedAt }, ...withoutSaved];
      });
    } catch (error) {
      setAppNotice({
        tone: "danger",
        label: "즐겨찾기 저장 실패",
        title: "배치 즐겨찾기를 저장하지 못했습니다.",
        detail: error instanceof Error ? error.message : "잠시 후 다시 시도하세요.",
      });
      return;
    }

    setAppNotice({
      tone: "success",
      label: "즐겨찾기 저장",
      title: `"${name}" 즐겨찾기를 저장했습니다.`,
      detail: "따로 해제하거나 다른 즐겨찾기를 불러오기 전까지 현재 배치 상태를 다시 불러올 수 있습니다.",
      debug: [
        `target_count=${snapshot.targetDocumentIds.length}`,
        `reference_count=${snapshot.referenceDocumentIds.length}`,
        `law_count=${snapshot.lawVersionIds.length}`,
      ],
    });
  }

  function handleApplyWorkspaceFavorite(favoriteId: string) {
    const favorite = workspaceFavorites.find((item) => item.id === favoriteId);
    if (!favorite) {
      return;
    }

    const targetIds = filterExistingIds(favorite.selection.targetDocumentIds, documents);
    const referenceIds = filterExistingIds(favorite.selection.referenceDocumentIds, documents);
    const lawIds = filterExistingIds(favorite.selection.lawVersionIds, lawVersions);
    const nextSelectedDocumentId =
      favorite.selection.selectedDocumentId &&
      documents.some((item) => item.id === favorite.selection.selectedDocumentId)
        ? favorite.selection.selectedDocumentId
        : null;

    setSelectedDocumentId(nextSelectedDocumentId);
    setComparisonTargetDocumentIds(targetIds);
    setComparisonReferenceDocumentIds(referenceIds);
    setSelectedLawVersionIds(lawIds);
    if (nextSelectedDocumentId) {
      setDocumentPreviewRefreshKey((current) => current + 1);
    }

    setAppNotice({
      tone: "success",
      label: "즐겨찾기 적용",
      title: `"${favorite.name}" 구성을 불러왔습니다.`,
      detail: "저장된 좌우 그룹과 법령 선택 상태를 현재 작업 화면에 반영했습니다.",
      debug: [
        `target_count=${targetIds.length}`,
        `reference_count=${referenceIds.length}`,
        `law_count=${lawIds.length}`,
      ],
    });
  }

  async function handleDeleteWorkspaceFavorite(favoriteId: string) {
    const favorite = workspaceFavorites.find((item) => item.id === favoriteId);
    if (!favorite) {
      return;
    }

    try {
      await deleteWorkspaceFavorite(favoriteId);
      setWorkspaceFavorites((current) => current.filter((item) => item.id !== favoriteId));
    } catch (error) {
      setAppNotice({
        tone: "danger",
        label: "즐겨찾기 삭제 실패",
        title: "배치 즐겨찾기를 삭제하지 못했습니다.",
        detail: error instanceof Error ? error.message : "잠시 후 다시 시도하세요.",
      });
      return;
    }

    setAppNotice({
      tone: "info",
      label: "즐겨찾기 삭제",
      title: `"${favorite.name}" 즐겨찾기를 삭제했습니다.`,
      detail: "현재 화면 배치는 유지되며 저장된 즐겨찾기 목록에서만 제거됩니다.",
    });
  }

  const activeComparisonRunIds = comparisonRuns
    .filter((run) =>
      comparisonTargetDocumentIds.includes(run.document_id ?? "") &&
      selectedLawVersionIds.includes(run.law_version_id ?? ""),
    )
    .map((run) => run.id);
  const highlightedDocumentIds = Array.from(
    new Set([
      ...checkedDocumentIds,
      ...comparisonTargetDocumentIds,
      ...comparisonReferenceDocumentIds,
    ]),
  );
  const workspaceNavigationItems: {
    id: WorkspaceSection;
    label: string;
    icon: string;
  }[] = [
    {
      id: "dashboard",
      label: "대시보드",
      icon: "⌂",
    },
    {
      id: "documents",
      label: "문서 관리",
      icon: "▤",
    },
    {
      id: "comparison",
      label: "비교 설정",
      icon: "⇄",
    },
    {
      id: "results",
      label: "검토 결과",
      icon: "✓",
    },
    {
      id: "history",
      label: "검토 이력",
      icon: "◷",
    },
    {
      id: "settings",
      label: "설정",
      icon: "⚙",
    },
  ];
  const activeWorkspaceMeta = getWorkspaceSectionMeta(activeWorkspaceSection);
  const showWorkspaceNavigation = Boolean(session) || embeddedWorkspace;
  const headerStatus = appNotice ?? {
    tone: "info" as const,
    label: "진행 현황",
    title: "대기 중",
    detail: "현재 실행 중인 작업이 없습니다.",
  };
  const dashboardLawDocuments = documents.filter((item) => isLawLikeDocument(item));
  const dashboardRegisteredLaws = getLatestRegisteredLaws(lawVersions);
  const dashboardLawFallbackItems = dashboardLawDocuments.map((item) => ({
    id: item.id,
    title: item.title,
    category: getLawCategoryFromText(item.title),
    section_count: item.section_count,
    version_label: `버전 ${item.version_number}`,
  }));
  const dashboardLawDisplayItems = dashboardRegisteredLaws.length
    ? dashboardRegisteredLaws.map((item) => ({
        id: item.id,
        title: item.source_title ?? "제목 없음",
        category: getLawDashboardCategory(item),
        section_count: item.section_count,
        version_label: item.version_label ?? "버전 미기재",
      }))
    : dashboardLawFallbackItems;
  const dashboardPolicyDocuments = documents.filter((item) => !isLawLikeDocument(item));
  const dashboardDocumentCategoryCounts = dashboardPolicyDocuments.reduce(
    (counts, item) => {
      const category = getDashboardDocumentCategory(item);

      if (category) {
        counts[category] += 1;
      }

      return counts;
    },
    {
      정책: 0,
      지침: 0,
    } as Record<"정책" | "지침", number>,
  );
  const dashboardLawCategoryCounts = dashboardLawDisplayItems.reduce(
    (counts, item) => {
      const category = item.category;

      if (category) {
        counts[category] += 1;
      }

      return counts;
    },
    {
      법률: 0,
      시행령: 0,
      시행규칙: 0,
      기준: 0,
    } as Record<LawDashboardCategory, number>,
  );
  const dashboardLawSectionCount = dashboardLawDisplayItems.reduce((sum, item) => sum + item.section_count, 0);
  const dashboardRecentDocuments = dashboardPolicyDocuments.slice(0, 3);
  const dashboardRecentLaws = dashboardLawDisplayItems.slice(0, 3);
  const dashboardRecentRuns = reviewExecutionHistory.slice(0, 3);
  const dashboardDocumentSectionCount = dashboardPolicyDocuments.reduce((sum, item) => sum + item.section_count, 0);
  const reviewHistoryTotalPages = Math.max(1, Math.ceil(reviewExecutionHistory.length / REVIEW_HISTORY_PAGE_SIZE));
  const reviewHistoryCurrentPage = Math.min(reviewHistoryPage, reviewHistoryTotalPages);
  const reviewHistoryPageEntries = reviewExecutionHistory.slice(
    (reviewHistoryCurrentPage - 1) * REVIEW_HISTORY_PAGE_SIZE,
    reviewHistoryCurrentPage * REVIEW_HISTORY_PAGE_SIZE,
  );

  return (
    <div className={`app-shell ${showWorkspaceNavigation ? "" : "login-shell"}`.trim()}>
      <div className="app-frame">
        <div className="app-main-column">
          <div
            className={`workspace-shell ${showWorkspaceNavigation ? "" : "no-sidebar"} ${
              isWorkspaceSidebarCollapsed ? "workspace-shell-sidebar-collapsed" : ""
            }`.trim()}
          >
            {showWorkspaceNavigation ? (
              <aside
                className={`workspace-sidebar ${
                  isWorkspaceSidebarCollapsed ? "workspace-sidebar-collapsed" : ""
                }`.trim()}
                aria-label="작업 탐색"
              >
                <div className="workspace-sidebar-title">
                  <strong>{isWorkspaceSidebarCollapsed ? "CR" : "준거성 검토 시스템"}</strong>
                  <button
                    type="button"
                    className="workspace-sidebar-toggle"
                    aria-label={isWorkspaceSidebarCollapsed ? "사이드 메뉴 펼치기" : "사이드 메뉴 접기"}
                    title={isWorkspaceSidebarCollapsed ? "사이드 메뉴 펼치기" : "사이드 메뉴 접기"}
                    onClick={() => setIsWorkspaceSidebarCollapsed((current) => !current)}
                  >
                    {isWorkspaceSidebarCollapsed ? "›" : "‹"}
                  </button>
                </div>
                <nav className="workspace-nav">
                  {workspaceNavigationItems.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={`workspace-nav-item ${activeWorkspaceSection === item.id ? "is-active" : ""}`}
                      aria-label={item.label}
                      title={item.label}
                      data-label={item.label}
                      onClick={() => {
                        setActiveWorkspaceSection(item.id);
                        if (item.id === "documents") {
                          setSelectedDocumentId(documents[0]?.id ?? null);
                        }
                      }}
                    >
                      <span className="workspace-nav-icon" aria-hidden="true">
                        {item.icon}
                      </span>
                      <strong>{item.label}</strong>
                    </button>
                  ))}
                </nav>
                <div className="workspace-auth-inline" aria-label="로그인 상태">
                  <span className="workspace-auth-inline-label">로그인 계정</span>
                  <strong>{session?.user.email ?? "세션 없음"}</strong>
                  <button
                    type="button"
                    className="workspace-auth-inline-button"
                    onClick={handleHeaderSignOut}
                  >
                    로그아웃
                  </button>
                </div>
              </aside>
            ) : null}

            <div
              className={`workspace-content ${
                activeWorkspaceSection === "history" ? "workspace-content-history" : ""
              }`.trim()}
            >
              {showWorkspaceNavigation && !["dashboard", "history"].includes(activeWorkspaceSection) ? (
                <div className="workspace-hero-row">
                  <header
                    className={`hero ${activeWorkspaceSection === "documents" ? "hero-documents" : ""}`.trim()}
                  >
                    <div
                      className={`hero-main ${activeWorkspaceSection === "documents" ? "hero-main-documents" : ""}`.trim()}
                    >
                      <p
                        className={`eyebrow ${activeWorkspaceSection === "documents" ? "hero-documents-eyebrow" : ""}`.trim()}
                      >
                        {activeWorkspaceMeta.kicker}
                      </p>
                      <h1
                        className={`hero-title-single-line ${activeWorkspaceSection === "documents" ? "hero-documents-title" : ""}`.trim()}
                      >
                        {activeWorkspaceMeta.title}
                      </h1>
                      <p
                        className={`hero-copy ${activeWorkspaceSection === "documents" ? "hero-documents-copy" : ""}`.trim()}
                      >
                        {activeWorkspaceMeta.description}
                      </p>
                    </div>
                  </header>
                  <aside className="workspace-status-side">
                    <section className="workspace-status-box workspace-progress-status-box" aria-label="진행 현황">
                      <span className="workspace-status-box-label">{headerStatus.label}</span>
                      <strong>{headerStatus.title}</strong>
                      {headerStatus.detail ? <p>{headerStatus.detail}</p> : null}
                    </section>
                  </aside>
                </div>
              ) : null}

              <main
                className={`workspace-stack ${
                  showWorkspaceNavigation && ["dashboard", "history"].includes(activeWorkspaceSection)
                    ? "workspace-stack-no-hero"
                    : ""
                } ${activeWorkspaceSection === "history" ? "workspace-stack-history" : ""}`.trim()}
              >
                {!showWorkspaceNavigation && !isSupabaseConfigured ? null : !isSupabaseConfigured ? (
                  <section className="panel">
                    <div className="warning-card">
                      <strong>Supabase 설정이 필요합니다</strong>
                      <p>
                        `.env.example`를 기준으로 `.env`를 만든 뒤
                        `VITE_SUPABASE_URL`과 `VITE_SUPABASE_ANON_KEY`를 설정하세요.
                      </p>
                      <p className="helper-text">
                        지금은 화면만 로컬에서 보이는 상태이며, 해당 값이 없으면
                        인증, 업로드, 비교, 권고 기능은 비활성화됩니다.
                      </p>
                    </div>
                  </section>
                ) : null}

                {!authResolved && !embeddedWorkspace ? (
                  <section className="panel panel-equal-height workspace-body-card workspace-login-page">
                    <div className="workspace-login-layout">
                      <p className="helper-text">인증 상태를 확인하는 중입니다…</p>
                    </div>
                  </section>
                ) : !showWorkspaceNavigation ? (
                  <section className="panel panel-equal-height workspace-body-card workspace-login-page">
                    <div className="workspace-login-layout">
                      <AuthPanel
                        session={session}
                        allowedDomain={
                          ALLOWED_EMAILS.length > 0
                            ? null
                            : normalizeAllowedEmailDomain(securitySettings.allowedEmailDomain)
                        }
                      />
                    </div>
                  </section>
                ) : null}

                {activeWorkspaceSection === "dashboard" ? (
                  <section className="workspace-body-plain workspace-dashboard-layout">
                    <section className="panel workspace-dashboard-hero">
                      <div className="workspace-dashboard-hero-copy">
                        <p className="workspace-dashboard-kicker">Dashboard</p>
                        <p>
                          법령, 정책·지침, 최근 점검 이력을 분리해서 보고 현재 관리 상태를 빠르게 파악할 수 있게 구성했습니다.
                        </p>
                      </div>
                      <div className="workspace-dashboard-hero-actions">
                        <button className="button" type="button" onClick={() => setActiveWorkspaceSection("documents")}>
                          문서 관리
                        </button>
                        <button className="button secondary" type="button" onClick={() => setActiveWorkspaceSection("comparison")}>
                          비교 설정
                        </button>
                        <button className="button ghost" type="button" onClick={() => setActiveWorkspaceSection("history")}>
                          점검 이력 보기
                        </button>
                      </div>
                    </section>

                    <div className="workspace-dashboard-board">
                      <section className="panel workspace-dashboard-panel workspace-dashboard-panel-law">
                        <div className="section-header workspace-dashboard-panel-header">
                          <span className="workspace-dashboard-panel-badge">법령</span>
                          <h2>법령 최신 등록 현황</h2>
                          <p>법령 소스별 최신 등록 버전을 기준으로 유형별 현황을 확인합니다.</p>
                        </div>
                        <div className="workspace-dashboard-stat-row">
                          <div className="workspace-dashboard-stat-card">
                            <span>법률</span>
                            <strong>{dashboardLawCategoryCounts.법률}</strong>
                          </div>
                          <div className="workspace-dashboard-stat-card">
                            <span>시행령</span>
                            <strong>{dashboardLawCategoryCounts.시행령}</strong>
                          </div>
                          <div className="workspace-dashboard-stat-card">
                            <span>시행규칙</span>
                            <strong>{dashboardLawCategoryCounts.시행규칙}</strong>
                          </div>
                          <div className="workspace-dashboard-stat-card">
                            <span>기준</span>
                            <strong>{dashboardLawCategoryCounts.기준}</strong>
                          </div>
                          <div className="workspace-dashboard-stat-card">
                            <span>전체 법령</span>
                            <strong>{dashboardLawDisplayItems.length}</strong>
                          </div>
                          <div className="workspace-dashboard-stat-card workspace-dashboard-stat-card-section-total">
                            <span>전체 섹션</span>
                            <strong>{dashboardLawSectionCount}</strong>
                          </div>
                        </div>
                        <div className="stack">
                          {dashboardRecentLaws.length ? (
                            dashboardRecentLaws.map((law) => (
                              <div key={law.id} className="workspace-dashboard-record">
                                <div>
                                  <span className="muted-label">법령명</span>
                                  <strong>{law.title}</strong>
                                </div>
                                <div className="workspace-dashboard-record-meta">
                                  <span>{law.version_label}</span>
                                  <span>섹션 {law.section_count}개</span>
                                </div>
                              </div>
                            ))
                          ) : (
                            <div className="workspace-dashboard-empty">
                              <strong>등록된 법령이 없습니다.</strong>
                              <p>비교 설정에서 기준 법령 URL을 먼저 등록하세요.</p>
                            </div>
                          )}
                        </div>
                      </section>

                      <section className="panel workspace-dashboard-panel workspace-dashboard-panel-document">
                        <div className="section-header workspace-dashboard-panel-header">
                          <span className="workspace-dashboard-panel-badge">문서</span>
                          <h2>정책 및 지침 등록 현황</h2>
                          <p>정책과 지침을 구분해서 현재 등록 상태와 최근 문서를 보여줍니다.</p>
                        </div>
                        <div className="workspace-dashboard-stat-row">
                          <div className="workspace-dashboard-stat-card">
                            <span>정책</span>
                            <strong>{dashboardDocumentCategoryCounts.정책}</strong>
                          </div>
                          <div className="workspace-dashboard-stat-card">
                            <span>지침</span>
                            <strong>{dashboardDocumentCategoryCounts.지침}</strong>
                          </div>
                          <div className="workspace-dashboard-stat-card workspace-dashboard-stat-card-section-total">
                            <span>전체 섹션</span>
                            <strong>{dashboardDocumentSectionCount}</strong>
                          </div>
                        </div>
                        <div className="stack">
                          {dashboardRecentDocuments.length ? (
                            dashboardRecentDocuments.map((document) => (
                              <button
                                key={document.id}
                                type="button"
                                className="workspace-dashboard-record workspace-dashboard-record-button"
                                onClick={() => {
                                  setSelectedDocumentId(document.id);
                                  setActiveWorkspaceSection("documents");
                                }}
                              >
                                <div>
                                  <span className="muted-label">{getDashboardDocumentCategory(document) ?? document.document_type}</span>
                                  <strong>{document.title}</strong>
                                </div>
                                <div className="workspace-dashboard-record-meta">
                                  <span>버전 {document.version_number}</span>
                                  <span>섹션 {document.section_count}개</span>
                                </div>
                              </button>
                            ))
                          ) : (
                            <div className="workspace-dashboard-empty">
                              <strong>등록된 문서가 없습니다.</strong>
                              <p>문서 관리에서 정책 또는 지침 문서를 업로드하세요.</p>
                            </div>
                          )}
                        </div>
                      </section>

                      <section className="panel workspace-dashboard-panel workspace-dashboard-panel-history">
                        <div className="section-header workspace-dashboard-panel-header">
                          <span className="workspace-dashboard-panel-badge">History</span>
                          <h2>최근 점검 이력</h2>
                          <p>최근 수행한 점검 실행을 시간순으로 보고, 바로 결과 검토로 이동할 수 있습니다.</p>
                        </div>
                        <div className="stack">
                          {dashboardRecentRuns.length ? (
                            dashboardRecentRuns.map((run) => (
                              <button
                                key={run.id}
                                type="button"
                                className="workspace-dashboard-history-item"
                                onClick={() => {
                                  setSelectedComparisonRunId(run.comparisonRunIds[0] ?? null);
                                  setActiveWorkspaceSection(
                                    hasDeterministicComparisonResult(run) ? "results" : "history",
                                  );
                                }}
                              >
                                <div className="workspace-dashboard-history-top">
                                  <strong>{joinListForDisplay(run.targetTitles)}</strong>
                                  <span>{formatDashboardDate(run.createdAt)}</span>
                                </div>
                                <p>{joinListForDisplay(run.referenceTitles)}</p>
                                <div className="workspace-dashboard-history-meta">
                                  <span>{run.reviewerEmail}</span>
                                  <span>
                                    {hasDeterministicComparisonResult(run)
                                      ? `결과 ${run.comparisonRunIds.length}건`
                                      : hasAiOnlyHistoryResult(run)
                                        ? "AI 리포트 완료"
                                        : "AI 비교 진행 중"}
                                  </span>
                                </div>
                              </button>
                            ))
                          ) : (
                            <div className="workspace-dashboard-empty">
                              <strong>최근 점검 이력이 없습니다.</strong>
                              <p>비교 설정을 마친 뒤 첫 점검을 실행하면 이력이 쌓입니다.</p>
                            </div>
                          )}
                        </div>
                      </section>
                    </div>
                  </section>
                ) : null}

                {activeWorkspaceSection === "documents" ? (
                  <div
                    className={`review-shell workspace-documents-layout ${
                      isDocumentsPanelCollapsed ? "workspace-documents-layout-collapsed" : ""
                    }`.trim()}
                  >
                    <div className="workspace-documents-column">
                      {isDocumentsPanelCollapsed ? (
                        <button
                          type="button"
                          className="documents-panel-rail-toggle"
                          aria-label="문서 목록 펼치기"
                          title="문서 목록 펼치기"
                          onClick={() => setIsDocumentsPanelCollapsed(false)}
                        >
                          <span>›</span>
                          <strong>문서 목록</strong>
                        </button>
                      ) : (
                        <>
                          <section className="panel workspace-body-card workspace-documents-panel">
                            <div className="section-header workspace-section-header">
                              <div>
                                <h2>문서 목록</h2>
                                <p>문서 목록에서 선택한 문서를 오른쪽에서 구조와 본문으로 바로 검토할 수 있습니다.</p>
                              </div>
                              <div className="structured-editor-toolbar">
                                <button
                                  type="button"
                                  className="button ghost structured-toolbar-button documents-panel-collapse-button"
                                  aria-label="문서 목록 접기"
                                  title="문서 목록 접기"
                                  onClick={() => setIsDocumentsPanelCollapsed(true)}
                                >
                                  ‹
                                </button>
                                <button
                                  type="button"
                                  className="button ghost structured-toolbar-button"
                                  onClick={() => {
                                    documentXlsxImportInputRef.current?.click();
                                  }}
                                  disabled={!session || !isSupabaseConfigured}
                                >
                                  XLSX Import
                                </button>
                                <button
                                  type="button"
                                  className="button ghost structured-toolbar-button"
                                  onClick={() => {
                                    void handleExportDocumentsXlsx();
                                  }}
                                  disabled={documents.length === 0}
                                >
                                  XLSX Export
                                </button>
                                <input
                                  ref={documentXlsxImportInputRef}
                                  type="file"
                                  accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                                  className="visually-hidden"
                                  onChange={(event) => {
                                    const file = event.target.files?.[0];
                                    event.target.value = "";
                                    if (file) {
                                      void handleImportDocumentsXlsx(file);
                                    }
                                  }}
                                />
                              </div>
                            </div>
                            <DocumentList
                              documents={documents}
                              selectedId={selectedDocumentId}
                              checkedIds={highlightedDocumentIds}
                              onSelect={handleSelectDocument}
                              onDragDocumentStart={setDraggingDocumentId}
                              onDragDocumentEnd={() => setDraggingDocumentId(null)}
                              onDelete={handleDeleteDocument}
                              deletingDocumentId={deletingDocumentId}
                              pendingDeleteDocumentId={pendingDeleteDocumentId}
                            />
                          </section>
                          <section className="panel workspace-documents-upload-panel">
                            <div className="section-header workspace-section-header">
                              <h2>정책·지침 업로드</h2>
                              <p>새 문서를 등록하고 구조화 섹션을 생성합니다.</p>
                            </div>
                            <DocumentUploadForm
                              disabled={!session || !isSupabaseConfigured}
                              onUpload={handleUpload}
                              setStatus={setStatus}
                              disabledReason={getUploadDisabledReason(session, isSupabaseConfigured)}
                            />
                          </section>
                        </>
                      )}
                    </div>
                    <section className="panel panel-wide workspace-body-card workspace-document-viewer-panel">
                      <DocumentViewer
                        documentId={selectedDocumentId}
                        refreshKey={documentPreviewRefreshKey}
                        onDocumentSaved={handleDocumentSaved}
                      />
                    </section>
                  </div>
                ) : null}

                {activeWorkspaceSection === "comparison" ? (
                  <section
                    className={`workspace-body-plain workspace-comparison-layout ${selectedLawVersionIds[0] ? "has-law-preview" : "no-law-preview"}`.trim()}
                  >
                    <div className="workspace-comparison-main">
                      <LawSourcePanel
                        documents={documents}
                        targetDocumentIds={comparisonTargetDocumentIds}
                        referenceDocumentIds={comparisonReferenceDocumentIds}
                        draggingDocumentId={draggingDocumentId}
                        lawVersions={lawVersions}
                        selectedLawVersionIds={selectedLawVersionIds}
                        disabled={!session || !isSupabaseConfigured}
                        onAddLawVersion={handleAddLawVersion}
                        onRemoveLawVersion={handleRemoveLawVersion}
                        onDropTargetDocument={handleDropTargetDocument}
                        onRemoveTargetDocument={handleRemoveTargetDocument}
                        onDropReferenceDocument={handleDropReferenceDocument}
                        onRemoveReferenceDocument={handleRemoveReferenceDocument}
                        onDeleteLawSource={handleDeleteLawSource}
                        onReparseLawSource={handleReparseLawSource}
                        onRunComparison={handleRunComparison}
                        favorites={workspaceFavorites.map((item) => ({
                          id: item.id,
                          name: item.name,
                          updatedAt: item.updatedAt,
                        }))}
                        activeFavoriteId={
                          workspaceFavorites.find((item) =>
                            isSameWorkspaceSelection(
                              item.selection,
                              createWorkspaceSelectionSnapshot({
                                selectedDocumentId,
                                targetDocumentIds: comparisonTargetDocumentIds,
                                referenceDocumentIds: comparisonReferenceDocumentIds,
                                lawVersionIds: selectedLawVersionIds,
                              }),
                            ),
                          )?.id ?? null
                        }
                        onSaveFavorite={handleSaveWorkspaceFavorite}
                        onApplyFavorite={handleApplyWorkspaceFavorite}
                        onDeleteFavorite={handleDeleteWorkspaceFavorite}
                        disabledReason={getComparisonDisabledReason(session, isSupabaseConfigured)}
                        overview={comparisonOverview}
                      />
                    </div>
                    {selectedLawVersionIds[0] ? (
                      <aside className="workspace-comparison-side">
                        <LawVersionPreview
                          lawVersionId={selectedLawVersionIds[0] ?? null}
                          refreshKey={lawPreviewRefreshKey}
                        />
                      </aside>
                    ) : null}
                  </section>
                ) : null}

                {activeWorkspaceSection === "results" ? (
                  <section className="workspace-body-plain workspace-results-body">
                    <ComparisonReviewPanel
                      comparisonRunId={selectedComparisonRunId}
                      comparisonRunIds={activeComparisonRunIds}
                      selectedDocumentIds={comparisonTargetDocumentIds}
                      referenceDocumentIds={comparisonReferenceDocumentIds}
                      selectedLawVersionIds={selectedLawVersionIds}
                      openAiSettings={openAiSettings}
                      viewMode="results"
                      setStatus={setStatus}
                      onOverviewChange={setComparisonOverview}
                      analysisState={comparisonAnalysisState}
                    />
                  </section>
                ) : null}

                {activeWorkspaceSection === "history" ? (
                  <div className="stack">
                    <section className="panel workspace-body-card workspace-history-card">
                      <div className="workspace-history-heading">
                        <div>
                          <span>History</span>
                          <h2>검토 이력</h2>
                        </div>
                        <div className="workspace-history-counts" aria-label="검토 이력 요약">
                          <strong>{reviewExecutionHistory.length}</strong>
                          <span>실행 기록</span>
                          <strong>{reviewExecutionHistory.filter(hasAiOnlyHistoryResult).length}</strong>
                          <span>AI 리포트</span>
                        </div>
                      </div>
                      <div className="workspace-history-split">
                        <section className="workspace-history-section">
                          {reviewExecutionHistory.length ? (
                            <div className="review-history-list">
                              {reviewHistoryPageEntries.map((entry) => (
                                <article key={entry.id} className="review-history-item">
                                  <div className="review-history-main">
                                    <strong>{formatHistoryTitle(entry.targetTitles)}</strong>
                                    <p>{joinListForDisplay(entry.referenceTitles)}</p>
                                  </div>
                                  <dl className="review-history-meta">
                                    <div>
                                      <dt>기준</dt>
                                      <dd>{entry.referenceTitles.length}건</dd>
                                    </div>
                                    <div>
                                      <dt>일시</dt>
                                      <dd>{formatSavedHistoryTimestamp(entry.createdAt)}</dd>
                                    </div>
                                    <div>
                                      <dt>검토자</dt>
                                      <dd>{entry.reviewerEmail}</dd>
                                    </div>
                                  </dl>
                                  <div className="review-history-action">
                                    {hasDeterministicComparisonResult(entry) ? (
                                      <button
                                        type="button"
                                        className="button ghost"
                                        onClick={() => {
                                          setSelectedComparisonRunId(entry.comparisonRunIds[0] ?? null);
                                          setActiveWorkspaceSection("results");
                                        }}
                                      >
                                        결과 보기
                                      </button>
                                    ) : hasAiOnlyHistoryResult(entry) ? (
                                      <button
                                        type="button"
                                        className="history-status-badge history-status-badge-complete history-status-button"
                                        onClick={() => {
                                          setAiHistoryLoadRequest({
                                            requestId: Date.now(),
                                            aiReportHistoryId: entry.aiReportHistoryId,
                                            selectionSummary: getSelectionSummary(
                                              entry.targetTitles.length,
                                              entry.referenceTitles.length,
                                              0,
                                            ),
                                            selectionCounts: {
                                              leftDocumentCount: entry.targetTitles.length,
                                              rightDocumentCount: entry.referenceTitles.length,
                                              rightLawCount: 0,
                                            },
                                          });
                                        }}
                                      >
                                        AI 리포트 열기
                                      </button>
                                    ) : (
                                      <span className="history-status-badge history-status-badge-pending">
                                        진행 중
                                      </span>
                                    )}
                                  </div>
                                </article>
                              ))}
                              {reviewHistoryTotalPages > 1 ? (
                                <div className="comparison-history-pagination review-history-pagination">
                                  {Array.from({ length: reviewHistoryTotalPages }, (_, index) => index + 1).map(
                                    (pageNumber) => (
                                      <button
                                        key={pageNumber}
                                        type="button"
                                        className={`button ghost comparison-history-page-button ${
                                          pageNumber === reviewHistoryCurrentPage ? "is-active" : ""
                                        }`}
                                        onClick={() => setReviewHistoryPage(pageNumber)}
                                      >
                                        {pageNumber}
                                      </button>
                                    ),
                                  )}
                                </div>
                              ) : null}
                            </div>
                          ) : (
                            <div className="empty-state">
                              <strong>검토 실행 이력이 없습니다.</strong>
                              <p>비교 설정에서 검토 실행을 시작하면 이력이 이곳에 기록됩니다.</p>
                            </div>
                          )}
                        </section>
                        <section className="workspace-history-section">
                          <div className="compact-section-header">
                            <h3>저장된 AI 리포트</h3>
                          </div>
                          <ComparisonReviewPanel
                            comparisonRunId={selectedComparisonRunId}
                            comparisonRunIds={activeComparisonRunIds}
                            selectedDocumentIds={comparisonTargetDocumentIds}
                            referenceDocumentIds={comparisonReferenceDocumentIds}
                            selectedLawVersionIds={selectedLawVersionIds}
                            openAiSettings={openAiSettings}
                            viewMode="history"
                            autoLoadHistoryRequest={aiHistoryLoadRequest}
                            setStatus={setStatus}
                            onOverviewChange={setComparisonOverview}
                            analysisState={comparisonAnalysisState}
                          />
                        </section>
                      </div>
                    </section>
                  </div>
                ) : null}

                {activeWorkspaceSection === "settings" ? (
                  <section className="workspace-body-plain workspace-results-body">
                    <PromptSettingsPanel
                      securitySettings={securitySettings}
                      onSecuritySettingChange={(field, value) => {
                        securitySettingsDirtyRef.current = true;
                        setSecuritySettings((current) => ({
                          ...current,
                          [field]: value,
                        }));
                      }}
                      activePromptSlotByStage={activePromptSlotByStage}
                      onPromptSlotChange={(stage, index) => {
                        setActivePromptSlotByStage((current) => ({
                          ...current,
                          [stage]: index,
                        }));
                      }}
                      openAiSettings={openAiSettings}
                      onOpenAiSettingChange={(field, value) => {
                        openAiSettingsDirtyRef.current = true;
                        setOpenAiSettings((current) => ({
                          ...current,
                          [field]: value,
                        }));
                      }}
                      promptOverrides={promptOverrides}
                      onPromptChange={(stage, index, value) => {
                        setPromptOverrides((current) => ({
                          ...current,
                          [stage]: updatePromptSlot(current[stage], index, value),
                        }));
                      }}
                      onPromptReset={(stage, index) => {
                        setPromptOverrides((current) => ({
                          ...current,
                          [stage]: resetPromptSlots(stage, index),
                        }));
                      }}
                    />
                  </section>
                ) : null}
              </main>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function inferNoticeTone(message: string): NoticeTone {
  if (/오류|실패|missing|유효하지|찾지 못/i.test(message)) {
    return "danger";
  }
  if (/선택하세요|취소|대기|필요|비활성|차단/i.test(message)) {
    return "warning";
  }
  if (/완료|인증|불러왔습니다|생성했습니다/i.test(message)) {
    return "success";
  }
  return "info";
}

function inferNoticeDetail(message: string) {
  if (/Failed to fetch/.test(message)) {
    return "브라우저가 Supabase Edge Function에 일시적으로 연결하지 못했습니다. 네트워크, 세션, 웹뷰 연결 상태를 확인한 뒤 다시 시도하세요.";
  }
  if (/선택하세요/.test(message)) {
    return "필수 입력이 없어서 다음 단계로 진행하지 못했습니다.";
  }
  if (/완료|불러왔습니다|생성했습니다/.test(message)) {
    return "결과를 확인한 뒤 다음 작업으로 이어갈 수 있습니다.";
  }
  if (/오류|실패/.test(message)) {
    return "원인 메시지를 확인한 뒤 설정, 인증, 데이터 상태를 점검하세요.";
  }
  return undefined;
}

function inferNoticeActions(message: string) {
  if (/Failed to fetch/.test(message)) {
    return [
      "잠시 후 다시 시도하세요.",
      "같은 오류가 반복되면 다시 로그인한 뒤 재실행하세요.",
    ];
  }
  if (/선택하세요/.test(message)) {
    return ["누락된 입력이나 선택 항목을 먼저 채우세요."];
  }
  if (/오류|실패/.test(message)) {
    return ["세부 오류 메시지를 확인하고 다시 시도하세요."];
  }
  return undefined;
}

function isTransientFetchStatus(message: string) {
  return /Failed to fetch|Edge Function.*연결|Supabase Edge Function|네트워크 연결 또는 Supabase Function 접근/i.test(
    message,
  );
}

// Exact emails allowed to sign in (comma-separated in VITE_ALLOWED_EMAILS).
// When set, this overrides the domain-based check entirely.
const ALLOWED_EMAILS: string[] = (import.meta.env.VITE_ALLOWED_EMAILS ?? "")
  .split(",")
  .map((entry: string) => entry.trim().toLowerCase())
  .filter(Boolean);

function normalizeAllowedEmailDomain(domain: string) {
  return domain.trim().toLowerCase().replace(/^@/u, "") || DEFAULT_SECURITY_SETTINGS.allowedEmailDomain;
}

function normalizeSessionIdleTimeoutMinutes(minutes: number) {
  return Number.isFinite(minutes)
    ? Math.min(1440, Math.max(1, Math.round(minutes)))
    : DEFAULT_SECURITY_SETTINGS.sessionIdleTimeoutMinutes;
}

function getWorkspaceSelectionStorageKey(userId: string) {
  return `policy-revision-mgmt-workspace-selection:${userId}`;
}

function updatePromptSlot(slots: PromptSlotList, index: number, value: string): PromptSlotList {
  const next = [...slots] as PromptSlotList;
  next[index] = value;
  return next;
}

function selectActivePromptOverrides(
  prompts: AiRevisionPromptOverrides,
  activeSlots: Record<keyof AiRevisionPromptOverrides, PromptSlotIndex>,
) {
  return {
    left: prompts.left[activeSlots.left],
    right: prompts.right[activeSlots.right],
    final: prompts.final[activeSlots.final],
  };
}

function resetPromptSlots(
  stage: keyof AiRevisionPromptOverrides,
  index?: number,
): PromptSlotList {
  const defaultPrompt =
    stage === "left"
      ? LEFT_REPORT_INSTRUCTIONS
      : stage === "right"
        ? RIGHT_REPORT_INSTRUCTIONS
        : COMPARISON_REPORT_INSTRUCTIONS;

  if (typeof index !== "number") {
    return [defaultPrompt, "", ""];
  }

  const next: PromptSlotList = ["", "", ""];
  next[index] = index === 0 ? defaultPrompt : "";
  return next;
}

function readWorkspaceSelection(userId: string): PersistedWorkspaceSelection | null {
  if (typeof window === "undefined") {
    return null;
  }

  const raw = window.localStorage.getItem(getWorkspaceSelectionStorageKey(userId));
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<PersistedWorkspaceSelection>;
    return {
      selectedDocumentId:
        typeof parsed.selectedDocumentId === "string" ? parsed.selectedDocumentId : null,
      targetDocumentIds: Array.isArray(parsed.targetDocumentIds)
        ? parsed.targetDocumentIds.filter((entry): entry is string => typeof entry === "string")
        : [],
      referenceDocumentIds: Array.isArray(parsed.referenceDocumentIds)
        ? parsed.referenceDocumentIds.filter((entry): entry is string => typeof entry === "string")
        : [],
      lawVersionIds: Array.isArray(parsed.lawVersionIds)
        ? parsed.lawVersionIds.filter((entry): entry is string => typeof entry === "string")
        : [],
    };
  } catch {
    return null;
  }
}

function writeWorkspaceSelection(userId: string, selection: PersistedWorkspaceSelection) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(
    getWorkspaceSelectionStorageKey(userId),
    JSON.stringify(selection),
  );
}

function readWorkspaceSection(): WorkspaceSection | null {
  if (typeof window === "undefined") {
    return null;
  }

  const raw = window.localStorage.getItem(WORKSPACE_SECTION_STORAGE_KEY);
  return WORKSPACE_SECTIONS.includes(raw as WorkspaceSection)
    ? (raw as WorkspaceSection)
    : null;
}

function writeWorkspaceSection(section: WorkspaceSection) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(WORKSPACE_SECTION_STORAGE_KEY, section);
}

function getDocumentParserReparseStorageKey(userId: string) {
  return `policy-revision-mgmt-document-parser-reparse:${userId}`;
}

function readDocumentParserReparseVersion(userId: string) {
  if (typeof window === "undefined") {
    return null;
  }

  return window.localStorage.getItem(getDocumentParserReparseStorageKey(userId));
}

function writeDocumentParserReparseVersion(userId: string, version: string) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(getDocumentParserReparseStorageKey(userId), version);
}

function filterExistingIds<T extends { id: string }>(ids: string[], items: T[]) {
  const itemIds = new Set(items.map((item) => item.id));
  return ids.filter((id) => itemIds.has(id));
}

function createWorkspaceSelectionSnapshot(selection: PersistedWorkspaceSelection): PersistedWorkspaceSelection {
  return {
    selectedDocumentId: selection.selectedDocumentId,
    targetDocumentIds: Array.from(new Set(selection.targetDocumentIds)),
    referenceDocumentIds: Array.from(new Set(selection.referenceDocumentIds)),
    lawVersionIds: Array.from(new Set(selection.lawVersionIds)),
  };
}

function isSameWorkspaceSelection(
  left: PersistedWorkspaceSelection,
  right: PersistedWorkspaceSelection,
) {
  return (
    left.selectedDocumentId === right.selectedDocumentId &&
    isSameIdList(left.targetDocumentIds, right.targetDocumentIds) &&
    isSameIdList(left.referenceDocumentIds, right.referenceDocumentIds) &&
    isSameIdList(left.lawVersionIds, right.lawVersionIds)
  );
}

function isSameIdList(left: string[], right: string[]) {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}

function getWorkspaceActions(documentCount: number, lawCount: number) {
  if (documentCount === 0) {
    return ["정책 또는 지침 문서를 먼저 업로드하세요."];
  }
  if (lawCount === 0) {
    return ["법령을 추가하지 않았다면 우선 문서 간 비교부터 진행할 수 있습니다.", "법령 기반 비교가 필요하면 기준 법령을 등록하거나 선택하세요."];
  }
  return ["비교 대상과 기준을 구성한 뒤 비교를 실행하세요."];
}

function createReviewExecutionHistoryEntry(input: {
  reviewerEmail: string;
  targetTitles: string[];
  referenceTitles: string[];
}): ReviewExecutionHistoryEntry {
  return {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    reviewerEmail: input.reviewerEmail,
    targetTitles: input.targetTitles,
    referenceTitles: input.referenceTitles,
    comparisonRunIds: [],
    aiReportHistoryId: null,
    resultStatus: "pending",
  };
}

function joinListForDisplay(values: string[]) {
  return values.length ? values.join(", ") : "-";
}

function formatHistoryTitle(values: string[]) {
  if (values.length === 0) {
    return "-";
  }

  if (values.length === 1) {
    return values[0];
  }

  return `${values[0]} 외 ${values.length - 1}건`;
}

function getLatestRegisteredLaws(lawVersions: LawVersionSummary[]) {
  const latestBySourceId = new Map<string, LawVersionSummary>();

  lawVersions.forEach((lawVersion) => {
    const existing = latestBySourceId.get(lawVersion.law_source_id);

    if (!existing) {
      latestBySourceId.set(lawVersion.law_source_id, lawVersion);
      return;
    }

    const existingTime = new Date(existing.created_at).getTime();
    const nextTime = new Date(lawVersion.created_at).getTime();

    if (Number.isNaN(existingTime) || nextTime >= existingTime) {
      latestBySourceId.set(lawVersion.law_source_id, lawVersion);
    }
  });

  return [...latestBySourceId.values()].sort((left, right) => {
    const leftTime = new Date(left.created_at).getTime();
    const rightTime = new Date(right.created_at).getTime();

    if (Number.isNaN(leftTime) || Number.isNaN(rightTime)) {
      return 0;
    }

    return rightTime - leftTime;
  });
}

function getLawDashboardCategory(lawVersion: Pick<LawVersionSummary, "source_title" | "source_link">) {
  const candidates = [lawVersion.source_title, extractLawCategoryHint(lawVersion.source_link)];

  for (const candidate of candidates) {
    const category = getLawCategoryFromText(candidate);

    if (category) {
      return category;
    }
  }

  return null;
}

function getDashboardDocumentCategory(document: Pick<DocumentSummary, "document_type" | "title">) {
  const normalizedTitle = document.title.replace(/\s+/g, " ").trim();

  if (/(정책|policy)/i.test(normalizedTitle)) {
    return "정책";
  }

  if (/(지침|가이드라인|guideline)/i.test(normalizedTitle)) {
    return "지침";
  }

  return null;
}

function isLawLikeDocument(document: Pick<DocumentSummary, "title">) {
  return Boolean(getLawCategoryFromText(document.title));
}

function getLawCategoryFromText(value: string | null): LawDashboardCategory | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  const normalized = value
    .replace(/\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[·•]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const compact = normalized.replace(/\s+/g, "");
  const titleTail = compact
    .replace(/제\d+(?:조|항|호)$/u, "")
    .replace(/제\d+호(?:의\d+)?$/u, "")
    .replace(/\d{4}\.\d{1,2}\.\d{1,2}\.?$/u, "")
    .replace(/별표\d*(?:의\d+)?$/u, "")
    .replace(/별지\d*(?:의\d+)?$/u, "")
    .replace(/부칙$/u, "")
    .trim();

  if (/시행규칙(?:$|제\d)/u.test(titleTail) || titleTail.includes("시행규칙")) {
    return "시행규칙";
  }

  if (/시행령(?:$|제\d)/u.test(titleTail) || titleTail.includes("시행령")) {
    return "시행령";
  }

  if (/(기준|고시|훈령|예규|세칙|규정|조례|규칙)(?:$|제\d)/u.test(titleTail)) {
    return "기준";
  }

  if (/(법률|법)(?:$|제\d)/u.test(titleTail)) {
    return "법률";
  }

  return null;
}

function extractLawCategoryHint(sourceLink: string) {
  if (!sourceLink) {
    return null;
  }

  const lastSegment = sourceLink.split("/").pop() ?? "";
  const withoutQuery = lastSegment.split("?")[0] ?? "";
  const withoutExtension = withoutQuery.replace(/\.[^.]+$/, "");

  try {
    return decodeURIComponent(withoutExtension);
  } catch {
    return withoutExtension;
  }
}

function formatDashboardDate(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatSavedHistoryTimestamp(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function getWorkspaceSectionMeta(section: WorkspaceSection) {
  if (section === "dashboard") {
    return {
      kicker: "대시보드",
      title: "대시보드",
      description: "문서, 기준 법령, 비교 준비 상태와 최근 실행 결과를 한 화면에서 확인합니다.",
    };
  }

  if (section === "documents") {
    return {
      kicker: "문서 관리",
      title: "문서 관리",
      description: "문서 목록을 관리하고, 선택한 문서를 오른쪽에서 바로 검토합니다.",
    };
  }

  if (section === "comparison") {
    return {
      kicker: "비교 설정",
      title: "비교 설정",
      description: "비교 대상과 기준 문서, 기준 법률을 한 화면에서 배치하고 실행합니다.",
    };
  }

  if (section === "settings") {
    return {
      kicker: "설정",
      title: "설정",
      description: "단계별 프롬프트와 검토 실행 기본 설정을 관리합니다.",
    };
  }

  if (section === "history") {
    return {
      kicker: "검토 이력",
      title: "검토 이력",
      description: "검토 실행 기록을 시간순으로 확인합니다.",
    };
  }

  return {
    kicker: "검토 결과",
    title: "검토 결과",
    description: "1단계, 2단계, 3단계 결과를 프레임 단위로 검토합니다.",
  };
}

function getWorkspaceDataRequirements(section: WorkspaceSection): WorkspaceDataLoadState {
  switch (section) {
    case "dashboard":
      return {
        ...EMPTY_WORKSPACE_DATA_LOAD_STATE,
        documents: true,
        lawVersions: true,
        reviewExecutionHistory: true,
      };
    case "documents":
      return {
        ...EMPTY_WORKSPACE_DATA_LOAD_STATE,
        documents: true,
      };
    case "comparison":
      return {
        ...EMPTY_WORKSPACE_DATA_LOAD_STATE,
        documents: true,
        lawVersions: true,
        workspaceFavorites: true,
      };
    case "results":
      return {
        ...EMPTY_WORKSPACE_DATA_LOAD_STATE,
        comparisonRuns: true,
      };
    case "history":
      return {
        ...EMPTY_WORKSPACE_DATA_LOAD_STATE,
        reviewExecutionHistory: true,
      };
    case "settings":
    default:
      return EMPTY_WORKSPACE_DATA_LOAD_STATE;
  }
}

function getUploadDisabledReason(session: AppAuthSession | null, isSupabaseConfigured: boolean) {
  if (!isSupabaseConfigured) {
    return "Firebase 환경 변수가 없어 업로드를 시작할 수 없습니다.";
  }
  if (!session) {
    return "로그인 후에만 문서 업로드와 파싱을 실행할 수 있습니다.";
  }
  return null;
}

function buildXlsxContentRows(row: {
  행번호: number;
  문서명: string;
  장: string;
  조: string;
  항: string;
  호: string;
  목: string;
  내용: string;
}) {
  const chunks = splitTextForXlsxCell(row.내용);
  return chunks.map((chunk, index) => ({
    문서명: row.문서명,
    행번호: row.행번호,
    분할번호: index + 1,
    장: row.장,
    조: row.조,
    항: row.항,
    호: row.호,
    목: row.목,
    내용: chunk,
  }));
}

function buildImportedXlsxRows(rows: Array<Record<string, unknown>>) {
  const rowGroups = new Map<number, {
    order: number;
    chapterLabel: string;
    articleLabel: string;
    paragraphLabel: string;
    itemLabel: string;
    subItemLabel: string;
    chunks: Array<{ part: number; content: string }>;
  }>();

  rows.forEach((row, index) => {
    const rowNumber = parsePositiveInteger(row["행번호"]) ?? index + 1;
    const partNumber = parsePositiveInteger(row["분할번호"]) ?? 1;
    const current = rowGroups.get(rowNumber) ?? {
      order: index,
      chapterLabel: String(row["장"] ?? ""),
      articleLabel: String(row["조"] ?? ""),
      paragraphLabel: String(row["항"] ?? ""),
      itemLabel: String(row["호"] ?? ""),
      subItemLabel: String(row["목"] ?? ""),
      chunks: [],
    };

    current.chapterLabel ||= String(row["장"] ?? "");
    current.articleLabel ||= String(row["조"] ?? "");
    current.paragraphLabel ||= String(row["항"] ?? "");
    current.itemLabel ||= String(row["호"] ?? "");
    current.subItemLabel ||= String(row["목"] ?? "");
    current.chunks.push({
      part: partNumber,
      content: String(row["내용"] ?? ""),
    });
    rowGroups.set(rowNumber, current);
  });

  return [...rowGroups.entries()]
    .sort((left, right) => left[1].order - right[1].order || left[0] - right[0])
    .map(([, group]) => ({
      chapterLabel: group.chapterLabel,
      articleLabel: group.articleLabel,
      paragraphLabel: group.paragraphLabel,
      itemLabel: group.itemLabel,
      subItemLabel: group.subItemLabel,
      content: group.chunks
        .sort((left, right) => left.part - right.part)
        .map((chunk) => chunk.content)
        .join(""),
    }))
    .filter((row) => row.content.length > 0);
}

function splitTextForXlsxCell(value: string) {
  const maxLength = 30000;
  if (value.length <= maxLength) {
    return [value];
  }

  const chunks: string[] = [];
  for (let start = 0; start < value.length; start += maxLength) {
    chunks.push(value.slice(start, start + maxLength));
  }
  return chunks;
}

function parsePositiveInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function buildUniqueXlsxSheetName(value: string, usedNames: Set<string>) {
  const baseName = buildXlsxSheetName(value);
  let candidate = baseName;
  let index = 2;
  while (usedNames.has(candidate)) {
    const suffix = `-${index}`;
    candidate = `${baseName.slice(0, 31 - suffix.length)}${suffix}`;
    index += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

function readXlsxDocumentTitleMap(workbook: XLSX.WorkBook) {
  const worksheet = workbook.Sheets["문서 목록"];
  const titleBySheetName = new Map<string, string>();
  if (!worksheet) {
    return titleBySheetName;
  }

  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet, { defval: "" });
  for (const row of rows) {
    const sheetName = String(row["시트명"] ?? "").trim();
    const documentTitle = String(row["문서명"] ?? "").trim();
    if (sheetName && documentTitle) {
      titleBySheetName.set(sheetName, documentTitle);
    }
  }

  return titleBySheetName;
}

function buildXlsxSheetName(value: string) {
  const sanitized = value
    .replace(/[\[\]:*?/\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (sanitized || "문서").slice(0, 31);
}

function downloadWorkbookXlsx(workbook: XLSX.WorkBook, fileName: string) {
  const data = XLSX.write(workbook, { bookType: "xlsx", type: "array" });
  const blob = new Blob([data], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
}

function sanitizeFileName(value: string) {
  return value
    .replace(/[^\w.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    || "document";
}

function formatDateStamp(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${year}${month}${day}-${hour}${minute}`;
}

function buildAiReportHistoryTitle(selectionCounts: {
  leftDocumentCount: number;
  rightDocumentCount: number;
  rightLawCount: number;
}) {
  return `비교 대상 ${selectionCounts.leftDocumentCount}건 · 기준 문서 ${selectionCounts.rightDocumentCount}건 · 법령 ${selectionCounts.rightLawCount}건`;
}

function getComparisonDisabledReason(session: AppAuthSession | null, isSupabaseConfigured: boolean) {
  if (!isSupabaseConfigured) {
    return "Firebase 환경 변수가 없어 비교 기능이 잠겨 있습니다.";
  }
  if (!session) {
    return "로그인 후에만 비교 실행과 법령 변경 작업을 수행할 수 있습니다.";
  }
  return null;
}

const APP_STAGE_REQUEST_TIMEOUT_MS = 190_000;

function runComparisonStageWithTimeout<T>(label: string, promise: Promise<T>) {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      window.setTimeout(() => {
        reject(new Error(`${label} 응답이 ${Math.round(APP_STAGE_REQUEST_TIMEOUT_MS / 1000)}초를 넘겨 지연되고 있습니다.`));
      }, APP_STAGE_REQUEST_TIMEOUT_MS);
    }),
  ]);
}
