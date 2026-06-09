# 플랫폼 이전 계획: Supabase → Firebase + Cloudflare

> 대상: `policy-revision-mgmt-system` (준거성 검토 시스템)
> 작성: 2026-06-09 · 상태: **계획 수립 단계**

---

## 1. 목표 아키텍처

| 영역 | 현재 (As-Is) | 목표 (To-Be) |
|---|---|---|
| 인증 | Supabase Auth (Google OAuth, `hd` 도메인 제한) | **Firebase Auth** (project `compliance-review-system`) |
| 데이터베이스 | Supabase Postgres (15+ 테이블, RLS, 뷰) | **Cloud Firestore** (컬렉션 재설계) |
| 파일 스토리지 | Supabase Storage 버킷 `source-documents` | **Cloudflare R2** |
| 백엔드 함수 | Supabase Edge Functions (Deno, 11개) | **Cloudflare Workers** |
| 프론트엔드 | React 19 + Vite + TS | 변경 없음 (클라이언트 SDK만 교체) |

---

## 2. 핵심 문제: 토큰 결합 (Token Coupling)

현재 `session.access_token`(Supabase JWT) 하나가 **세 가지 역할**을 동시에 한다:

1. **DB 접근 인증** — Postgres RLS 정책이 JWT의 `auth.uid()`로 행 단위 권한을 검사.
2. **Storage 접근 인증** — 버킷 RLS 정책 (`source-documents`).
3. **Edge Function 호출 인증** — `Authorization: Bearer ${access_token}` ([documentService.ts:2231](../src/lib/documentService.ts)).

→ `src/lib/documentService.ts`에서 `ensureAuthenticatedUser(session.access_token)`가 **약 40곳**에서 호출됨.

**결론:** Auth만 단독 교체 불가. Firebase ID 토큰은 Supabase의 DB/Storage/함수가 거부하므로, **Auth + DB + Storage + 함수는 하나의 "데이터 평면(data plane)"으로 함께 이전**해야 한다. 새 토큰 = Firebase ID 토큰으로 통일하고, 검증 주체를 Firestore Security Rules(DB) + Cloudflare Worker의 Firebase Admin 토큰 검증(함수)으로 옮긴다.

```
[Firebase Auth] --ID token--> ┌─ Firestore (Security Rules로 검증)
                              ├─ Cloudflare Worker (Admin SDK로 verifyIdToken)
                              └─ R2 (Worker가 중개, 직접 노출 안 함)
```

---

## 3. 데이터 모델 설계 (Postgres → Firestore)

### 3.1 현재 엔티티 관계

```
workspaces ─┬─< workspace_members (user_id)
            └─< documents ─< document_versions ─< document_sections (self-ref: parent_section_id)
                          └ (audit_logs ← actor/target)

law_sources ─< law_versions ─< law_sections
comparison_runs ─< comparison_results
+ 부가: workspace_favorites, review_execution_history, ai_report_history, user_settings, security_settings
```

테이블(실사용 prefix `policy_*`): `policy_documents`, `policy_document_versions`, `policy_document_sections`, `policy_audit_logs`, `policy_law_versions`, `policy_law_sections`, `policy_comparison_runs`, `policy_comparison_results`, `policy_workspace_favorites`, `policy_review_execution_history`, `policy_ai_report_history`, `policy_user_settings`, `policy_security_settings` + 뷰(`*_summary_view`, `*_review_detail/overview`).

### 3.2 Firestore 컬렉션 설계 (제안)

서브컬렉션으로 계층을, 비정규화로 목록 뷰를 대체한다.

```
workspaces/{wsId}
  ├─ members/{uid}                      # workspace_members
  └─ documents/{docId}                  # policy_documents (+ ownerUserId, 비정규화 latestVersion 요약)
       └─ versions/{verId}              # policy_document_versions (+ effectiveDate)
            └─ sections/{secId}         # policy_document_sections (parentSectionId 필드로 self-ref)

lawSources/{lawId}
  └─ versions/{verId}
       └─ sections/{secId}

comparisonRuns/{runId}                  # 상위 컬렉션 (워크스페이스 교차 조회 위해)
  └─ results/{resultId}                 # policy_comparison_results

users/{uid}
  ├─ settings/openai                    # policy_user_settings
  ├─ settings/security                  # policy_security_settings
  ├─ favorites/{favId}                  # policy_workspace_favorites
  ├─ reviewHistory/{histId}             # policy_review_execution_history (최신만 유지 로직 유의)
  └─ aiReportHistory/{reportId}         # policy_ai_report_history

auditLogs/{logId}                       # append-only
```

**뷰 대체 전략:** Postgres 뷰(`policy_document_summary_view` 등)는 Firestore에 없음 → (a) 문서 작성 시 요약 필드를 부모 문서에 **비정규화**하거나, (b) Worker가 집계해서 반환. 목록 화면은 (a) 우선.

**주의 — 마이그레이션 시 재현해야 할 비즈니스 로직:**
- `keep_latest_review_execution_history` (최신 이력만 유지) → 쓰기 시 정리 로직 또는 Worker.
- `link_review_history_to_ai_report` (이력↔리포트 연결) → 참조 필드.
- 정렬/소유자 인덱스(`add_owner_and_order_indexes`) → Firestore 복합 인덱스로 재정의.

### 3.3 Security Rules 매핑

RLS 정책 → Firestore Rules로 1:1 번역:
- "owners and members can read documents" → `documents` read: `request.auth.uid == resource.data.ownerUserId || isMember(wsId)`.
- "authenticated users read/upload their own source files" → R2는 Rules 대상 아님 → **Worker에서 소유권 검사** 후 서명 URL 발급.

---

## 4. 파일 스토리지: Supabase Storage → Cloudflare R2

- 버킷 `source-documents` → R2 버킷 **`policy-revision-mgmt-system`** (생성 완료 2026-06-09, account `totoriverce@gmail.com` / `02f0426678a5977483be4b2210cdf293`).
  - Worker 바인딩 스니펫:
    ```jsonc
    "r2_buckets": [
      { "bucket_name": "policy-revision-mgmt-system", "binding": "policy_revision_mgmt_system" }
    ]
    ```
- 업로드/다운로드는 **클라이언트가 R2에 직접 접근하지 않는다.** Cloudflare Worker가 Firebase ID 토큰 검증 → 소유권 확인 → R2 presigned URL 또는 프록시 스트리밍.
- 키 스킴 유지: `{ownerUserId}/{documentId}/{filename}` 형태로 RLS 경로 의미 보존.
- `documentService.ts`의 `supabase.storage.from("source-documents").upload/download/remove` 3종 호출부를 R2 Worker 엔드포인트 호출로 교체.

---

## 5. 백엔드 함수: Edge Functions → Cloudflare Workers

11개 함수, Deno → Workers (둘 다 web-standard `fetch` 핸들러라 이식 용이):

| 함수 | 역할 | 비고 |
|---|---|---|
| `register-document` / `manage-document` / `admin-document-maintenance` | 문서 등록/관리/정리 | Firestore 쓰기로 전환 |
| `register-law-source` / `manage-law-source` | 법령 출처 등록/관리 | 〃 |
| `run-comparison` / `run-bulk-comparison` | 비교 실행 | `_shared/comparisonEngine.ts` 재사용 |
| `classify-revision` | 개정 분류 | **OpenAI 호출** |
| `analyze-selected-revisions` | 선택 개정 AI 분석 (1007줄) | **OpenAI 호출**, 가장 큼 |

**공통 작업:**
- `_shared/cors.ts` → Workers CORS로 이식.
- 인증: Supabase JWT 검증 → **Firebase Admin SDK `verifyIdToken`** (Workers에서 `firebase-admin` 또는 REST 토큰 검증).
- DB 접근: Supabase client → Firestore Admin SDK.
- 시크릿(OpenAI 키 등): Supabase secrets → Wrangler secrets / `wrangler.toml` 바인딩.
- `_shared/*.ts`는 `shared/`와 중복 → 단일 소스로 통합 검토.

---

## 6. 단계별 이전 순서 (의존성 기준)

```
Phase 0  기반 (완료)        firebase 설치 · firebaseClient/firebaseAuth · env
Phase 1  Firestore 설계 확정  컬렉션 스키마 · Security Rules · 복합 인덱스 정의
Phase 2  Cloudflare 골격     R2 버킷 · Worker 프로젝트(wrangler) · Firebase Admin 토큰검증 미들웨어
Phase 3  함수 이식          11개 Edge Function → Workers (DB는 아직 Supabase 병행 가능)
Phase 4  데이터 ETL         Postgres → Firestore 덤프/변환/적재 스크립트 · Storage → R2 복사
Phase 5  클라이언트 컷오버   documentService.ts · App.tsx · AuthPanel.tsx 를 Firebase/R2/Worker로 전환
Phase 6  검증 & 폐기        병렬 검증 · Supabase 의존성 제거 · 롤백창 후 종료
```

**핵심 의존성:** Phase 5(클라이언트 컷오버)는 Phase 1~4가 모두 준비된 뒤 **한 번에** 수행해야 토큰 결합 문제로 인한 앱 중단을 최소화한다. Phase 3까지는 기존 앱이 정상 동작한다.

---

## 7. 데이터 마이그레이션 (ETL)

1. Postgres 덤프: 테이블별 JSON export (Supabase SQL 또는 `pg_dump` → 변환).
2. UUID 키 → Firestore 문서 ID로 그대로 사용 (충돌 없음).
3. 관계 평탄화: FK → 서브컬렉션 경로 + 참조 필드.
4. 비정규화 요약 필드 생성 (목록 뷰용).
5. Storage 객체 → R2 복사 (키 스킴 보존, `rclone` 또는 Worker 일괄).
6. 검증: 행 수·체크섬 대조, 샘플 문서 라운드트립.

---

## 8. 리스크 & 롤백

| 리스크 | 완화 |
|---|---|
| Firestore는 SQL 조인/뷰 없음 | 비정규화 + Worker 집계, 쿼리 패턴 사전 검증 |
| RLS의 세밀한 권한 → Rules 누락 | 정책 1:1 체크리스트, Rules 에뮬레이터 테스트 |
| `access_token` 동기 사용처 → Firebase는 비동기 `getIdToken` | `firebaseAuth.ts`가 세션 캐싱, 토큰 갱신 구독 제공 |
| Firestore 비용(읽기 과금) | 목록 비정규화로 읽기 최소화 |
| 대용량 AI 분석 함수 이식 | Workers CPU/시간 한도 확인, 필요시 Queues/Durable Objects |
| 컷오버 중 데이터 정합성 | 읽기전용 동결창 → ETL → 검증 → 전환 |
| **⚠️ Firebase uid ≠ Supabase user.id** | 모든 `ownerUserId`가 Supabase auth UUID 참조. Firebase는 새 uid 발급 → 마이그레이션된 소유권이 어긋남. **완화: Firebase Auth 사용자 가져오기 API로 UID 보존 임포트, 또는 ETL 전 uid 리맵 패스 실행.** Phase 5 전 필수 해결 |

**롤백:** Phase 5 전까지는 Supabase가 진실원본(source of truth). 컷오버는 env 플래그(`VITE_AUTH_MODE`)와 배포 롤백으로 되돌릴 수 있도록 단일 커밋/PR로 구성.

---

## 9. 진행 체크리스트

- [x] **Phase 0** firebase 설치, `firebaseClient.ts`, `firebaseAuth.ts`, env 추가
- [x] **Phase 1** Firestore 스키마 [`src/lib/firestore/schema.ts`](../src/lib/firestore/schema.ts) + [`firestore.rules`](../firestore.rules) + [`firestore.indexes.json`](../firestore.indexes.json)
- [x] **Phase 2** R2 버킷 ✅ + Worker 스캐폴드 [`workers/`](../workers/) (wrangler.jsonc·라우터·R2 파일 라우트·Firebase ID 토큰 검증, dry-run 검증 완료) — *남음: 배포 + `wrangler secret put` (OPENAI_API_KEY, 서비스계정) + Worker→Firestore Admin 접근*
- [x] **Phase 3** Edge Function → Worker 이식 — **완료 (9/9)** ([`workers/src/functions/`](../workers/src/functions/))
  - [x] Worker용 Firestore Admin REST 클라이언트 [`workers/src/firestore.ts`](../workers/src/firestore.ts) (서비스계정 OAuth2 + 값 코덱 + get/query/queryGroup/commit/deleteCollection)
  - [x] `register-document`, `manage-document`, `admin-document-maintenance`
  - [x] `register-law-source`, `manage-law-source`
  - [x] `run-comparison`, `run-bulk-comparison`
  - [x] `classify-revision`, `analyze-selected-revisions` (OpenAI Responses API)
  - 알려진 갭: legacy `.doc` 서버 추출(word-extractor, Node 전용) 미지원 → 클라이언트 rawText 전송 필요. 모두 `tsc` + `wrangler --dry-run` 검증 (번들 120KiB).
  - 미배포: `wrangler deploy` + `wrangler secret put`(FIREBASE_SERVICE_ACCOUNT, OPENAI_API_KEY) 필요
- [x] **Phase 4** ETL 스크립트 [`scripts/migration/`](../scripts/migration/) — `migrateData.ts`(Postgres→Firestore), `migrateStorage.ts`(Storage→R2), `verify.ts`(카운트 대조), DRY_RUN 지원·멱등성. tsc 통과. *실행 전제: Firestore 프로비저닝 + R2 자격증명*
- [~] **Phase 5** 클라이언트 컷오버 — **진행 중**
  - [x] uid 선결: [`scripts/migration/src/importAuthUsers.ts`](../scripts/migration/src/importAuthUsers.ts) — Supabase UUID를 Firebase uid로 보존 임포트
  - [x] 클라이언트 토대: [`src/lib/firebaseDb.ts`](../src/lib/firebaseDb.ts)(Firestore web SDK), [`src/lib/workerApi.ts`](../src/lib/workerApi.ts)(Worker /functions·/files 호출)
  - [x] [`AuthPanel.tsx`](../src/components/AuthPanel.tsx) Firebase Auth 전환 (팝업 로그인)
  - [x] [`App.tsx`](../src/App.tsx) 인증 전환: 부트스트랩/세션감지(onAppAuthChange)/유휴타임아웃/로그아웃/env 체크 — tsc 통과
  - [x] `VITE_WORKER_API_URL` env 추가
  - [ ] **`documentService.ts`(2,892줄)** — 핵심 남은 작업: `.from()` 61곳→Firestore, storage 4곳→Worker R2, 쓰기 작업→Worker `/functions` 호출. *앱 실행 검증 필요해 증분 진행 권장.*
- [ ] **Phase 6** 병렬 검증 → Supabase 의존성 제거
```
