/**
 * Ported from supabase/functions/classify-revision/index.ts.
 *
 *   policy_comparison_runs     → comparisonRuns/{runId}
 *   policy_comparison_results  → comparisonRuns/{runId}/results/{id}
 *   policy_revision_decisions  → comparisonRuns/{runId}/decisions/{id}
 *
 * Calls the OpenAI Responses API (unless the deterministic bypass applies).
 */

import {
  buildClassificationInput,
  buildDeterministicNoChangeDecision,
  getRevisionDecisionSchema,
  normalizeRevisionDecision,
  shouldBypassAi,
  type DiffForClassification,
} from "../../../shared/revisionClassifier";
import { Firestore } from "../firestore";
import type { VerifiedUser } from "../firebaseAuth";
import { writeAudit } from "./_common";

export interface ClassifyRevisionRequest {
  comparisonRunId: string;
  openAiApiKey?: string;
  openAiModel?: string;
}

interface OpenAIResponsesApiResponse {
  output_parsed?: unknown;
  output_text?: string;
}

interface DiffPayload {
  diffs: DiffForClassification[];
  warnings: string[];
}

export async function classifyRevision(
  body: ClassifyRevisionRequest,
  user: VerifiedUser,
  db: Firestore,
  env: { OPENAI_API_KEY?: string; OPENAI_REVISION_MODEL?: string },
): Promise<Record<string, unknown>> {
  if (!body.comparisonRunId?.trim()) {
    throw new Error("comparisonRunId is required.");
  }
  const openAiApiKey = body.openAiApiKey?.trim() || env.OPENAI_API_KEY;
  const openAiModel = body.openAiModel?.trim() || env.OPENAI_REVISION_MODEL || "gpt-5.2";

  const runPath = `comparisonRuns/${body.comparisonRunId}`;
  const run = await db.get(runPath);
  if (!run || run.fields.actorUserId !== user.uid) {
    throw new Error("Comparison run not found or access denied.");
  }
  const resultDocs = await db.query({
    parent: runPath,
    collectionId: "results",
    orderBy: { field: "affectedPath", direction: "ASCENDING" },
  });

  const diffPayload: DiffPayload = {
    diffs: resultDocs.map((r): DiffForClassification => ({
      id: r.id,
      affectedPath: (r.fields.affectedPath as string) ?? "",
      hierarchyType: r.fields.hierarchyType as DiffForClassification["hierarchyType"],
      matchType: r.fields.matchType as DiffForClassification["matchType"],
      diffType: r.fields.diffType as DiffForClassification["diffType"],
      confidence: Number(r.fields.confidence ?? 0),
      beforeText: (r.fields.beforeText as string) ?? "",
      afterText: (r.fields.afterText as string) ?? "",
      explanation: (r.fields.explanation as string) ?? "",
      reasoningTrace: Array.isArray(r.fields.reasoningTrace)
        ? (r.fields.reasoningTrace as unknown[]).filter((v): v is string => typeof v === "string")
        : [],
    })),
    warnings: Array.isArray(run.fields.warningMessages)
      ? (run.fields.warningMessages as unknown[]).filter((v): v is string => typeof v === "string")
      : [],
  };

  const useDeterministicOnly = shouldBypassAi(diffPayload);
  const requestPurpose =
    "Classify revision necessity and generate a concise explanation from deterministic structural diff results.";

  const decision = useDeterministicOnly
    ? buildDeterministicNoChangeDecision()
    : await classifyWithOpenAi({ apiKey: openAiApiKey, model: openAiModel, requestPurpose, diffPayload });

  const apiCallCount = useDeterministicOnly ? 0 : 1;
  const cumulativeApiCallCount = await getCumulativeOpenAiApiCallCount(db, user.uid, apiCallCount);

  const revisionDecisionId = crypto.randomUUID();
  await db.set(`${runPath}/decisions/${revisionDecisionId}`, {
    comparisonRunId: body.comparisonRunId,
    status: decision.status,
    rationale: decision.explanation,
    confidence: decision.confidence,
    aiUsed: !useDeterministicOnly,
    humanReviewRequired: decision.humanReviewRequired,
    modelName: useDeterministicOnly ? null : openAiModel,
    requestPurpose,
    outputUsedInRecommendation: true,
    openaiApiCallCount: cumulativeApiCallCount,
    createdAt: new Date(),
  });

  await writeAudit(db, {
    actorUserId: user.uid,
    action: "REVISION_CLASSIFIED",
    targetDocumentId: null,
    result: "SUCCESS",
    metadata: {
      revisionDecisionId,
      comparisonRunId: body.comparisonRunId,
      aiUsed: !useDeterministicOnly,
      modelName: useDeterministicOnly ? null : openAiModel,
      apiCallCount,
      cumulativeApiCallCount,
    },
  });

  return {
    status: "success",
    data: {
      revisionDecisionId,
      decision: {
        status: decision.status,
        explanation: decision.explanation,
        confidence: decision.confidence,
        humanReviewRequired: decision.humanReviewRequired,
        aiUsed: !useDeterministicOnly,
        citedDiffIds: decision.citedDiffIds,
      },
    },
    warnings: diffPayload.warnings,
    confidence: decision.confidence,
    traceability: {
      comparisonRunId: body.comparisonRunId,
      aiUsed: !useDeterministicOnly,
      model: useDeterministicOnly ? null : openAiModel,
      requestPurpose,
    },
  };
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

async function classifyWithOpenAi(input: {
  apiKey: string | undefined;
  model: string;
  requestPurpose: string;
  diffPayload: DiffPayload;
}) {
  if (!input.apiKey) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${input.apiKey}` },
    body: JSON.stringify({
      model: input.model,
      instructions: [
        "You classify whether an internal policy should be revised based only on deterministic structural diff evidence between the policy and an updated law.",
        "Do not invent unseen clauses or unsupported legal conclusions.",
        "Use LOW_CONFIDENCE_REVIEW if the evidence is ambiguous, low-confidence, or insufficient.",
        "The explanation must reference the cited diff ids and summarize the structural/text changes that support the classification.",
      ].join(" "),
      input: JSON.stringify({
        request_purpose: input.requestPurpose,
        diff_summary: buildClassificationInput(input.diffPayload),
      }),
      text: { format: { type: "json_schema", ...getRevisionDecisionSchema() } },
    }),
  });
  if (!response.ok) {
    throw new Error(`OpenAI API request failed: ${response.status} ${await response.text()}`);
  }
  const payload = (await response.json()) as OpenAIResponsesApiResponse;
  const rawDecision = payload.output_parsed ?? parseOutputText(payload.output_text);
  return normalizeRevisionDecision(rawDecision);
}

function parseOutputText(outputText: string | undefined) {
  if (!outputText) throw new Error("OpenAI response did not include structured output.");
  return JSON.parse(outputText);
}
