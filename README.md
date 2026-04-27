# Policy Revision Management System

내부 정책/지침과 외부 법령을 함께 검토해서, 현재 회사 정책에 무엇을 추가해야 하는지 또는 어떤 내용이 불필요한지 검토하기 위한 시스템입니다.

배포는 `main` 브랜치 push 시 GitHub Actions로 실행됩니다.

프론트엔드는 `React + Vite`, 백엔드는 `Supabase(Auth, Postgres, Storage, Edge Functions)`, AI 분석은 `OpenAI API`를 사용합니다.

이 시스템은 법률 자문 시스템이 아닙니다.  
결정론적 구조화와 저장을 우선하고, OpenAI는 사람이 검토할 수 있는 `개정 가이드` 생성에만 사용합니다.

## 핵심 기능

- 정책/지침 문서 업로드
- 문서를 `장/조/항/호/목` 단위로 구조화
- 구조화 섹션을 DB에 저장
- 법령 URL 등록 및 본문 구조화
- 선택한 정책/지침과 선택한 법령을 기준으로 AI 종합 비교
- 우측 하단 리포트에 다음 두 가지 출력
  - 현행 정책에 추가해야 할 내용 및 근거
  - 현행 정책에 불필요한 내용 및 근거

## 현재 구현 범위

### 내부 문서

- `docx`, `txt`, `md` 업로드 지원
- 문서 제목 기준으로 `POLICY` / `GUIDELINE` 분류
- 구조화 단위:
  - 장
  - 조
  - 항
  - 호
  - 목

현재 파서 규칙의 주요 기준:

- `제 n 장` → 장
- `제 n 조` → 조
- `①` → 항
- `1.` → 호
- `가.` → 목

### 법령

- 허용된 URL 도메인에서만 등록
  - `law.go.kr`
  - `www.law.go.kr`
  - `elaw.klri.re.kr`
- HTML이면 본문 텍스트를 추출
- 텍스트가 직접 내려오면 그대로 사용
- 등록 시 원문과 구조화 섹션을 함께 저장

### AI 분석

- 선택된 모든 정책/지침 + 선택된 모든 법령을 한 번의 프롬프트로 OpenAI에 전달
- 결과는 문서별 가이드로 반환
  - 어느 정책/지침에 반영해야 하는지
  - 어느 위치에 넣거나 빼야 하는지
  - 정책/지침 근거 위치
  - 법령 근거 위치
  - 조치 가이드
  - 신뢰도

추가로 현재 리포트에는 다음도 표시합니다.

- 사용 모델명
- OpenAI API 호출 건수

## 기술 스택

### Frontend

- React 19
- Vite
- TypeScript

### Backend

- Supabase Auth
- Supabase Postgres
- Supabase Storage
- Supabase Edge Functions

### AI

- OpenAI Responses API

## 주요 디렉터리

```text
src/
  components/
  lib/
  styles.css
  App.tsx

shared/
  policyParser.ts
  comparisonEngine.ts
  revisionClassifier.ts
  sectionHierarchyColumns.ts

supabase/
  migrations/
  functions/
```

## 주요 모듈

### 프론트엔드

- [src/App.tsx](/Users/shbae-pc/Tools/policy-revision-mgmt-system/src/App.tsx)
  - 전체 화면 상태 관리
- [src/components/DocumentList.tsx](/Users/shbae-pc/Tools/policy-revision-mgmt-system/src/components/DocumentList.tsx)
  - 정책/지침 선택 토글
- [src/components/DocumentViewer.tsx](/Users/shbae-pc/Tools/policy-revision-mgmt-system/src/components/DocumentViewer.tsx)
  - 구조화 섹션 테이블
- [src/components/LawSourcePanel.tsx](/Users/shbae-pc/Tools/policy-revision-mgmt-system/src/components/LawSourcePanel.tsx)
  - 법령 URL 등록 및 선택
- [src/components/ComparisonReviewPanel.tsx](/Users/shbae-pc/Tools/policy-revision-mgmt-system/src/components/ComparisonReviewPanel.tsx)
  - AI 비교 결과 리포트
- [src/lib/documentService.ts](/Users/shbae-pc/Tools/policy-revision-mgmt-system/src/lib/documentService.ts)
  - Supabase / Edge Function 호출

### 구조 파서

- [shared/policyParser.ts](/Users/shbae-pc/Tools/policy-revision-mgmt-system/shared/policyParser.ts)
  - 결정론적 구조 파서

### Edge Functions

- [register-document](/Users/shbae-pc/Tools/policy-revision-mgmt-system/supabase/functions/register-document/index.ts)
  - 내부 문서 등록
- [register-law-source](/Users/shbae-pc/Tools/policy-revision-mgmt-system/supabase/functions/register-law-source/index.ts)
  - 법령 URL 등록
- [run-comparison](/Users/shbae-pc/Tools/policy-revision-mgmt-system/supabase/functions/run-comparison/index.ts)
  - 결정론적 비교 실행
- [run-bulk-comparison](/Users/shbae-pc/Tools/policy-revision-mgmt-system/supabase/functions/run-bulk-comparison/index.ts)
  - 기존 경로 보존용 함수
- [classify-revision](/Users/shbae-pc/Tools/policy-revision-mgmt-system/supabase/functions/classify-revision/index.ts)
  - 비교 실행 단위 AI 분류
- [analyze-selected-revisions](/Users/shbae-pc/Tools/policy-revision-mgmt-system/supabase/functions/analyze-selected-revisions/index.ts)
  - 선택된 정책/지침 + 법령 종합 AI 리포트

## 데이터 모델 요약

현재 스키마는 `policy_` 접두사를 사용합니다.

주요 테이블:

- `policy_documents`
- `policy_document_versions`
- `policy_document_sections`
- `policy_law_sources`
- `policy_law_versions`
- `policy_law_sections`
- `policy_comparison_runs`
- `policy_comparison_results`
- `policy_revision_decisions`
- `policy_audit_logs`

구조화 섹션은 기본적으로 다음 정보를 가집니다.

- `hierarchy_type`
- `hierarchy_label`
- `hierarchy_order`
- `original_text`
- `normalized_text`
- `path_display`

추가로 명시적 계층 컬럼을 사용하는 마이그레이션도 포함되어 있습니다.

- `chapter_label`, `chapter_text`
- `article_label`, `article_text`
- `paragraph_label`, `paragraph_text`
- `item_label`, `item_text`
- `sub_item_label`, `sub_item_text`

## 환경 변수

### 프론트엔드 `.env`

```bash
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
```

`.env.example`를 복사해서 사용하면 됩니다.

```bash
cp .env.example .env
```

## Supabase 설정

### 1. Google OAuth

이 프로젝트는 현재 Google OAuth 로그인 기준으로 동작합니다.

Supabase Dashboard에서:

- `Authentication > Providers > Google`
- Google Client ID / Secret 등록
- Redirect URL 허용

로컬 개발 기준 예:

- `http://127.0.0.1:5173`

### 2. OpenAI 시크릿

OpenAI 키는 프론트 `.env`에 넣지 않습니다.  
반드시 Supabase Edge Function secret으로 등록해야 합니다.

필수 시크릿:

```bash
OPENAI_API_KEY=...
OPENAI_REVISION_MODEL=gpt-5.2
```

CLI 예:

```bash
supabase secrets set OPENAI_API_KEY=... --project-ref <project-ref>
supabase secrets set OPENAI_REVISION_MODEL=gpt-5.2 --project-ref <project-ref>
```

## 설치 및 실행

### 1. 의존성 설치

```bash
npm install
```

### 2. 프론트 환경 변수 설정

```bash
cp .env.example .env
```

`.env`에 실제 값을 채웁니다.

### 3. Supabase 마이그레이션 적용

```bash
supabase db push
```

### 4. Edge Function 배포

```bash
supabase functions deploy register-document --no-verify-jwt
supabase functions deploy register-law-source --no-verify-jwt
supabase functions deploy run-comparison --no-verify-jwt
supabase functions deploy classify-revision --no-verify-jwt
supabase functions deploy analyze-selected-revisions --no-verify-jwt
```

참고:

- 현재 일부 함수는 게이트웨이 JWT 검증 대신 함수 내부 인증 검증을 사용합니다.
- 그래서 `--no-verify-jwt`로 배포하는 경로를 사용하고 있습니다.

### 5. 로컬 개발 서버 실행

```bash
npm run dev
```

기본 접속:

- `http://127.0.0.1:5173/`

## GitHub Pages 배포

이 저장소는 GitHub Actions로 GitHub Pages 배포가 가능하도록 설정되어 있습니다.

워크플로우:

- `.github/workflows/deploy-pages.yml`

필수 GitHub Repository Secrets:

```bash
VITE_SUPABASE_URL
VITE_SUPABASE_ANON_KEY
```

배포 조건:

- `main` 브랜치 push 시 자동 배포
- 또는 `workflow_dispatch`로 수동 실행

예상 배포 주소:

- `https://policy.sanghak.kr/`

GitHub Pages가 아직 안 뜨면 아래를 확인해야 합니다.

- Repository `Settings > Pages`
- Source가 `GitHub Actions`인지 확인
- Custom domain이 `policy.sanghak.kr`로 설정되어 있는지 확인
- Repository Secrets에 `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`가 등록되어 있는지 확인

## 검증 명령

```bash
npm run lint
npm run typecheck
npm run test
npm run build
```

## 사용 흐름

### 1. 로그인

- Google OAuth 로그인

### 2. 정책/지침 업로드

- `docx`, `txt`, `md` 업로드
- 구조화 섹션 생성
- 문서 목록에 추가

### 3. 법령 등록

- 법령 URL 입력
- 본문 수집 및 구조화
- 법령 목록에 추가

### 4. 비교 대상 선택

- 문서 목록에서 정책/지침 카드 토글 선택
- 법령 목록에서 비교할 법령 선택

### 5. 비교 실행

- `선택 정책·지침과 법령 비교 실행`

이 버튼은 현재:

- 선택된 정책/지침
- 선택된 법령

조합을 기준으로 결정론 비교를 실행하고,
우측 하단 리포트는 선택 상태를 기준으로 OpenAI 종합 분석을 표시합니다.

### 6. 결과 확인

우측 하단 리포트에서 확인 가능한 항목:

- 현행 정책에 추가해야 할 내용 및 근거
- 현행 정책에 불필요한 내용 및 근거
- 반영 위치
- 정책/지침 근거 위치
- 법령 근거 위치
- 조치 가이드
- 신뢰도
- 사용 모델
- OpenAI API 호출 건수

## OpenAI 사용 원칙

이 프로젝트에서 OpenAI는 다음에만 사용합니다.

- 선택된 정책/지침과 법령의 종합 개정 가이드 생성
- 개정 필요성 설명
- 불확실한 사례에 대한 저신뢰 메모

다음에는 사용하지 않습니다.

- 기본 구조 파싱
- 원문 저장
- 버전 저장
- 구조 자체의 주 저장 로직

현재 프롬프트는 다음 기준을 강제합니다.

- 일반 민간회사 기준
- 정부기관/공공기관 전용 의무는 제외
- 제공된 정책/지침과 법령 텍스트만 근거로 사용
- 문서별 가이드 생성
- 저신뢰 시 명시적으로 표시

## 현재 UI 기준

### 문서 목록

- 카드 클릭으로 선택 토글
- 선택된 문서는 문서 보기에도 표시

### 문서 보기

- 구조화 섹션만 표시
- 테이블 컬럼:
  - 장
  - 조
  - 항
  - 호
  - 목
  - 내용

계층 컬럼 값이 있는 셀은:

- 검은색 배경
- 흰색 글씨

### 비교 검토

- 상단 요약:
  - 선택 정책 및 지침 x건
  - VS
  - 법령 이름
- 하단:
  - AI 비교 결과
  - 추가해야 할 내용 및 근거
  - 불필요한 내용 및 근거

## 현재 제약 사항

- PDF 파서는 붙어 있지 않습니다.
- 구조 파서는 한국어 규정 문서 형식에 맞춘 규칙 기반입니다.
- 동일 법령 중복 제거는 추가 정리가 더 필요합니다.
- 비교 검토 UI는 현재 AI 리포트 중심입니다.
- 거대한 문서 집합을 한 번에 분석하면 OpenAI 입력 길이 제약에 걸릴 수 있습니다.

## 주의 사항

- OpenAI 키를 프론트에 넣지 마십시오.
- Supabase service role key를 프론트에 넣지 마십시오.
- 법령 URL은 허용된 도메인만 사용합니다.
- 이 시스템의 출력은 최종 법률 판단이 아니라 내부 검토 가이드입니다.

## 향후 개선 포인트

- 동일 법령명 + 시행일 기준 중복 제거
- PDF 수집 및 안정적 텍스트 추출
- 구조화 재파싱 워크플로우
- AI 리포트 결과 저장 및 이력 관리
- 선택된 법령 집합별 분석 결과 캐싱
- 대형 문서 분석 시 chunking 전략
