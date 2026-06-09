# Phase 5 마무리: `documentService.ts` 컷오버 지침

`src/lib/documentService.ts`(2,892줄)를 Supabase → Firebase/Cloudflare로 전환하는
함수별 매핑. **앱을 실행한 상태**(`npm run dev`)에서 그룹별로 바꾸고 화면에서 동작을
확인하며 진행할 것 — 직접 DB 읽기는 런타임 검증 없이 정확히 옮기기 어렵다.

도구: [`src/lib/firebaseDb.ts`](../src/lib/firebaseDb.ts)(`getDb()` Firestore web SDK),
[`src/lib/workerApi.ts`](../src/lib/workerApi.ts)(`invokeFunction`/`uploadFile`/`downloadFile`/`deleteFile`),
경로 헬퍼 [`src/lib/firestore/schema.ts`](../src/lib/firestore/schema.ts)의 `paths`.

## 0) 공통 헬퍼 교체 (먼저)

| 기존 (Supabase) | 교체 |
|---|---|
| `import { getSupabaseClient, clearSupabaseAuthStorage, normalizeSupabaseAuthError }` | 제거 |
| `ensureAuthenticatedSession()` | `getCurrentAppSession()` (firebaseAuth) → null이면 throw |
| `ensureAuthenticatedUser(accessToken)` | ID 토큰 JWT payload 디코드 → `{ id: sub, email }` (네트워크 불필요; Worker/Rules가 검증) |
| `invokeEdgeFunction(name, body, ctx?)` | `workerApi.invokeFunction(name, body)` |
| `getValidatedAccessToken()` | `getFreshIdToken()` |
| `supabase.storage.from("source-documents").upload/remove` | `workerApi.uploadFile(key, bytes, type)` / `deleteFile(key)` |
| 미사용화되는 헬퍼들 (`forceRefreshAuthenticatedSession`, `invokeEdgeFunctionHttp`, `fetchWithRetry`, `isJwtError`, `shouldRetry*`, `formatFunctionInvokeError`, `isSessionExpiredOrNearExpiry`, 재시도 상수 등) | 삭제 (noUnusedLocals) |

`buildAuthDebugMessage`는 메시지 포맷터라 유지 가능.

## 1) 백엔드 함수 위임 (invokeEdgeFunction 10곳 — 가장 쉬움)

이미 Worker에 구현됨. 본문을 `workerApi.invokeFunction(<name>, input)` 호출로 교체:

- `registerLawSource` → `register-law-source`
- `uploadLawDocument` → `register-law-source` (sourceType:"file")
- `updateLawSource` / `deleteLawSource` / `reparseLawSource` → `manage-law-source` (action별)
- `runComparison` → `run-comparison`
- `runBulkComparison` → `run-bulk-comparison`
- `classifyRevision` → `classify-revision`
- `analyzeSelectedRevisions` / `analyzeSelectedRevisionsStage` → `analyze-selected-revisions`

## 2) 문서 쓰기 (uploadDocument / uploadRawTextDocument / uploadStructuredRowsDocument / deleteDocument / reparseDocument)

**주의:** 클라이언트가 Worker `register-document`에 없는 추가 로직을 수행한다 —
`dedupeParsedSections`, `deleteSupersededDocumentsByTitle`(동일 제목 이전 문서 정리),
`buildFallbackDocumentSectionRow`. 두 가지 선택:

- **(A 권장)** Worker `register-document`/`manage-document`에 해당 로직을 추가하고 클라이언트는 `uploadFile`로 R2 업로드 후 `invokeFunction("register-document", {...})` 호출. → 서버 단일화.
- **(B)** 클라이언트에서 Firestore web SDK로 직접 쓰기 (`getDb()` + `setDoc`/`writeBatch`), 스키마는 `schema.ts` 그대로. 기존 클라이언트 로직 보존이 쉬움.

`deleteDocument`/`reparseDocument` → `invokeFunction("manage-document", {action})`로 단순화 가능
(단 클라이언트 `deleteSupersededDocumentsByTitle`는 Worker로 이전 필요).

## 3) 직접 읽기 → Firestore web SDK (가장 큰 작업, 검증 필수)

`.from(...).select()` 61곳을 `getDocs(query(collection(getDb(), ...), where(...), orderBy(...)))`로.
반환 타입(`DocumentSummary`, `DocumentDetail`, `LawDetail`, `ComparisonRunSummary` 등) 변환은 그대로 유지.

| 함수 | Postgres | Firestore |
|---|---|---|
| `listDocuments` | `policy_document_summary_view` | `documents` where `ownerUserId==uid` orderBy `createdAt` + `latest` 비정규화 필드 사용 |
| `getDocumentDetail` | documents+versions+sections 조인 | `documents/{id}` + 최신 version + `sections` 서브컬렉션 orderBy `hierarchyOrder` |
| `listLawVersions` | `policy_law_version_summary_view` | collection-group `versions`(id 필드) 또는 `lawSources` 순회 |
| `getLawDetail` | law version + sections | `lawSources/{id}/versions/{vid}` + sections |
| `listComparisonRuns` | `policy_comparison_runs` (+조인) | `comparisonRuns` where `actorUserId==uid` orderBy `createdAt` |
| `getComparisonReview` / `getAggregatedComparisonReview` | `policy_comparison_review_*` 뷰 | `comparisonRuns/{id}/results` + `decisions` 읽어 클라에서 집계 (뷰 없음) |
| `listWorkspaceFavorites` / `saveWorkspaceFavorite` / `deleteWorkspaceFavorite` | `policy_workspace_favorites` | `users/{uid}/favorites/*` |
| `list/saveReviewExecutionHistory`, `updateReviewExecutionHistoryStatus` | `policy_review_execution_history` | `users/{uid}/reviewHistory/*` (keep-latest 로직 유지) |
| `list/get/save/deleteAiReportHistory` | `policy_ai_report_history` | `users/{uid}/aiReportHistory/*` |
| `getPolicyUserOpenAiSettings` / `save…` | `policy_user_settings` | `users/{uid}/settings/openai` |
| `getPolicySecuritySettings` / `save…` | `policy_security_settings` | `users/{uid}/settings/security` |
| `saveStructuredSections` | sections 직접 쓰기 | `documents/{id}/versions/{vid}/sections/*` 배치 |

## 4) 검증 & 폐기 (Phase 6)

1. `wrangler deploy` + `wrangler secret put FIREBASE_SERVICE_ACCOUNT`, `OPENAI_API_KEY`.
2. `firebase deploy --only firestore:rules,firestore:indexes`.
3. ETL 실행: `scripts/migration` (import:auth → migrate:data → migrate:storage → verify).
4. `VITE_WORKER_API_URL`을 배포된 Worker URL로 설정.
5. 앱 실행 → 로그인/문서/비교/AI 전 기능 확인.
6. `@supabase/supabase-js` 의존성 + `src/lib/supabaseClient.ts` + `supabase/` 제거.
