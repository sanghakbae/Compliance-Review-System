/**
 * Ported from supabase/functions/register-law-source/index.ts.
 *
 *   policy_law_sources   → lawSources/{lawId}
 *   policy_law_versions  → lawSources/{lawId}/versions/{verId}
 *   policy_law_sections  → lawSources/{lawId}/versions/{verId}/sections/{secId}
 *   storage              → R2 SOURCE_DOCUMENTS
 *
 * KNOWN GAP: legacy `.doc` (not `.docx`) server-side extraction used the Node
 * `word-extractor` package, which is unsafe under Workers. Clients send parsed
 * `rawText` for txt/md/docx; `.doc` without rawText now returns a clear error.
 */

import { parsePolicyText } from "../../../shared/policyParser";
import { Firestore } from "../firestore";
import type { VerifiedUser } from "../firebaseAuth";
import { buildSectionDocs, buildStoragePath, decodeBase64, writeAudit } from "./_common";

export interface RegisterLawSourceRequest {
  sourceType?: "url" | "file";
  sourceLink?: string;
  sourceTitle?: string;
  versionLabel?: string;
  effectiveDate?: string | null;
  originalFileName?: string;
  fileContentBase64?: string;
  contentType?: string;
  rawText?: string;
}

const ALLOWED_HOSTS = new Set(["law.go.kr", "www.law.go.kr", "elaw.klri.re.kr"]);

function validateInput(body: RegisterLawSourceRequest): void {
  const sourceType = body.sourceType === "file" ? "file" : "url";
  if (sourceType === "file") {
    if (!body.originalFileName?.trim()) throw new Error("originalFileName is required.");
    if (!/\.(txt|md|doc|docx)$/iu.test(body.originalFileName)) {
      throw new Error("Only .txt, .md, .doc, and .docx uploads are allowed.");
    }
    if (!body.fileContentBase64?.trim()) throw new Error("fileContentBase64 is required.");
    const requiresRawText = !/\.(doc)$/iu.test(body.originalFileName);
    if (requiresRawText && !body.rawText?.trim()) throw new Error("rawText is required.");
    return;
  }
  if (!body.sourceLink?.trim()) throw new Error("sourceLink is required.");
}

export async function registerLawSource(
  body: RegisterLawSourceRequest,
  user: VerifiedUser,
  db: Firestore,
  bucket: R2Bucket,
): Promise<Record<string, unknown>> {
  validateInput(body);
  const sourceType = body.sourceType === "file" ? "file" : "url";
  const extracted =
    sourceType === "file"
      ? await extractLawTextFromUpload(bucket, user.uid, body)
      : await extractLawTextFromUrl(body);

  const parseResult = parsePolicyText(extracted.rawText);

  const lawSourceId = crypto.randomUUID();
  const lawVersionId = crypto.randomUUID();
  const now = new Date();
  const retrievalTimestamp = now.toISOString();

  await db.set(`lawSources/${lawSourceId}`, {
    workspaceId: null,
    ownerUserId: user.uid,
    sourceLink: extracted.sourceLink,
    sourceTitle: body.sourceTitle?.trim() || extracted.title || null,
    retrievalTimestamp: now,
    versionEffectiveDate: body.effectiveDate || null,
    createdAt: now,
  });

  await db.set(`lawSources/${lawSourceId}/versions/${lawVersionId}`, {
    // Self id enables collection-group lookup by version id (no joins in Firestore).
    id: lawVersionId,
    lawSourceId,
    ownerUserId: user.uid,
    versionLabel: body.versionLabel?.trim() || null,
    effectiveDate: body.effectiveDate || null,
    rawText: extracted.rawText,
    parseWarnings: parseResult.warnings,
    createdAt: now,
  });

  const sectionDocs = await buildSectionDocs(
    parseResult.sections,
    lawVersionId,
    "lawVersionId",
    user.uid,
  );
  const sectionPrefix = `lawSources/${lawSourceId}/versions/${lawVersionId}/sections`;
  const writes = sectionDocs.map((s) => ({
    type: "set" as const,
    path: `${sectionPrefix}/${s.id}`,
    data: s.data,
  }));
  for (let i = 0; i < writes.length; i += 400) {
    await db.commit(writes.slice(i, i + 400));
  }

  await writeAudit(db, {
    actorUserId: user.uid,
    action: "LAW_SOURCE_REGISTERED",
    targetDocumentId: null,
    result: "SUCCESS",
    metadata: {
      lawSourceId,
      lawVersionId,
      sourceLink: extracted.sourceLink,
      sourceType,
      sectionCount: sectionDocs.length,
    },
  });

  return {
    status: "success",
    data: {
      lawSourceId,
      lawVersionId,
      sourceTitle: body.sourceTitle?.trim() || extracted.title || null,
      sectionCount: sectionDocs.length,
    },
    warnings: parseResult.warnings,
    confidence: 1,
    traceability: { sourceLink: extracted.sourceLink, sourceType, retrievalTimestamp },
  };
}

async function extractLawTextFromUrl(body: RegisterLawSourceRequest) {
  const sourceUrl = validateAllowedSourceUrl(body.sourceLink ?? "");
  const res = await fetch(sourceUrl.toString(), {
    method: "GET",
    redirect: "follow",
    headers: {
      "User-Agent": "policy-revision-mgmt-system/0.1",
      Accept: "text/html,text/plain,application/xhtml+xml",
    },
  });
  if (!res.ok) {
    throw new Error(`법령 URL을 가져오지 못했습니다. HTTP ${res.status}`);
  }
  const contentType = res.headers.get("content-type") ?? "";
  const extracted = extractLawText(await res.text(), contentType);
  if (!extracted.rawText.trim()) {
    throw new Error("법령 본문 텍스트를 추출하지 못했습니다.");
  }
  return { title: extracted.title, rawText: extracted.rawText, sourceLink: sourceUrl.toString() };
}

async function extractLawTextFromUpload(
  bucket: R2Bucket,
  userId: string,
  body: RegisterLawSourceRequest,
) {
  const originalFileName = body.originalFileName ?? "law-source.txt";
  const fileBytes = decodeBase64(body.fileContentBase64 ?? "");
  const storagePath = buildStoragePath(userId, originalFileName);
  await bucket.put(storagePath, fileBytes, {
    httpMetadata: { contentType: body.contentType || "application/octet-stream" },
  });

  let rawText = body.rawText?.trim() ?? "";
  if (!rawText && /\.(doc)$/iu.test(originalFileName)) {
    throw new Error(
      "Legacy .doc 본문 추출은 Worker에서 지원되지 않습니다. 클라이언트에서 rawText를 전송하세요.",
    );
  }
  if (!rawText.trim()) {
    throw new Error("법령 첨부파일에서 본문 텍스트를 추출하지 못했습니다.");
  }
  return {
    title: body.sourceTitle?.trim() || originalFileName,
    rawText,
    sourceLink: `r2://policy-revision-mgmt-system/${storagePath}`,
  };
}

function validateAllowedSourceUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("법령 URL은 HTTPS만 허용합니다.");
  if (!ALLOWED_HOSTS.has(url.hostname)) throw new Error("허용되지 않은 법령 도메인입니다.");
  return url;
}

function extractLawText(rawBody: string, contentType: string) {
  if (!contentType.includes("html")) {
    return { title: null, rawText: normalizeExtractedLawText(rawBody) };
  }
  const titleMatch = rawBody.match(/<title[^>]*>([\s\S]*?)<\/title>/iu);
  const title = titleMatch ? decodeHtml(titleMatch[1]).trim() : null;
  const withoutScripts = rawBody
    .replace(/<script[\s\S]*?<\/script>/giu, " ")
    .replace(/<style[\s\S]*?<\/style>/giu, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/giu, " ")
    .replace(/<svg[\s\S]*?<\/svg>/giu, " ")
    .replace(/<form[\s\S]*?<\/form>/giu, " ");
  const bodyCandidate = extractLawBodyCandidate(withoutScripts);
  const text = bodyCandidate
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<\/p>/giu, "\n")
    .replace(/<\/div>/giu, "\n")
    .replace(/<\/tr>/giu, "\n")
    .replace(/<\/td>/giu, " ")
    .replace(/<\/li>/giu, "\n")
    .replace(/<\/h[1-6]>/giu, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/giu, " ")
    .replace(/\r\n/g, "\n");
  return { title, rawText: normalizeExtractedLawText(decodeHtml(text)) };
}

function extractLawBodyCandidate(html: string): string {
  const candidates = [
    /<(?:div|section|article)[^>]+id=["']?(?:conTop|conScroll|con|contents|contentBody|content|lawBody|printArea|txt|viewwrap|subContents)["']?[^>]*>([\s\S]*?)<\/(?:div|section|article)>/iu,
    /<(?:div|section|article)[^>]+class=["'][^"']*(?:lawcon|law-content|lawTxt|viewTxt|tblwrap|article-body|contents|content-body)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|section|article)>/iu,
    /<body[^>]*>([\s\S]*?)<\/body>/iu,
  ];
  for (const pattern of candidates) {
    const match = html.match(pattern);
    if (match?.[1]) return match[1];
  }
  return html;
}

function normalizeExtractedLawText(value: string): string {
  return value
    .replace(/ /g, " ")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => isMeaningfulLawLine(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isMeaningfulLawLine(line: string): boolean {
  if (!line) return false;
  const noisePatterns = [
    /^본문\s*바로가기$/u, /^조문체계도버튼$/u, /^연혁$/u, /^생활법령버튼$/u,
    /^별표\/서식$/u, /^법령용어$/u, /^자치법규$/u, /^행정규칙$/u, /^판례$/u,
    /^법령해석례$/u, /^입법예고$/u, /^행정예고$/u, /^자치법규입법예고$/u,
    /^입법예고센터$/u, /^국가법령정보센터$/u, /^English$/u, /^화면\s*인쇄$/u,
    /^조문\s*인쇄$/u, /^공유하기$/u, /^닫기$/u, /^검색$/u, /^목차$/u, /^조문$/u, /^부칙$/u,
  ];
  if (noisePatterns.some((pattern) => pattern.test(line))) return false;
  if (line.length <= 1) return false;
  return true;
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'")
    .replace(/&#x27;/giu, "'");
}
