/**
 * Cloudflare Workers backend for policy-revision-mgmt-system.
 *
 * Replaces the Supabase Edge Functions + Storage. This scaffold wires up:
 *   - CORS + Firebase ID-token authentication (Phase 2)
 *   - R2-backed file upload/download/delete for source documents (Phase 2)
 *   - Stub routes for the 11 migrated Edge Functions (Phase 3 — to implement)
 */

import { corsHeaders, json, preflight } from "./cors";
import { extractBearerToken, verifyIdToken, type VerifiedUser } from "./firebaseAuth";
import { Firestore } from "./firestore";
import { manageDocument, type ManageDocumentRequest } from "./functions/manageDocument";
import { registerDocument, type RegisterDocumentRequest } from "./functions/registerDocument";
import { registerLawSource, type RegisterLawSourceRequest } from "./functions/registerLawSource";
import { manageLawSource, type ManageLawSourceRequest } from "./functions/manageLawSource";
import { runComparison, type RunComparisonRequest } from "./functions/runComparison";
import { runBulkComparison, type RunBulkComparisonRequest } from "./functions/runBulkComparison";
import { classifyRevision, type ClassifyRevisionRequest } from "./functions/classifyRevision";
import {
  adminDocumentMaintenance,
  type AdminMaintenanceRequest,
} from "./functions/adminDocumentMaintenance";
import {
  analyzeSelectedRevisions,
  type AnalyzeSelectedRevisionsRequest,
} from "./functions/analyzeSelectedRevisions";

export interface Env {
  SOURCE_DOCUMENTS: R2Bucket;
  FIREBASE_PROJECT_ID: string;
  ALLOWED_EMAIL_DOMAIN?: string;
  OPENAI_API_KEY?: string;
  /** Google service account JSON for Firestore Admin access. */
  FIREBASE_SERVICE_ACCOUNT?: string;
}

function getDb(env: Env): Firestore {
  if (!env.FIREBASE_SERVICE_ACCOUNT) {
    throw new HttpError(500, "FIREBASE_SERVICE_ACCOUNT secret is not configured.");
  }
  return Firestore.fromEnv(env.FIREBASE_SERVICE_ACCOUNT, env.FIREBASE_PROJECT_ID);
}

async function authenticate(request: Request, env: Env): Promise<VerifiedUser> {
  const token = extractBearerToken(request.headers.get("Authorization"));
  if (!token) {
    throw new HttpError(401, "Missing authorization token.");
  }
  try {
    return await verifyIdToken(token, env.FIREBASE_PROJECT_ID, env.ALLOWED_EMAIL_DOMAIN);
  } catch (error) {
    throw new HttpError(401, error instanceof Error ? error.message : "Unauthorized.");
  }
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// ---- R2 file routes -------------------------------------------------------
// Object key scheme mirrors Supabase storage: `${uid}/${documentId}/${fileName}`.
// A user may only touch keys under their own uid prefix.
function assertOwnsKey(user: VerifiedUser, key: string): void {
  if (!key || !key.startsWith(`${user.uid}/`)) {
    throw new HttpError(403, "Forbidden: object key outside your namespace.");
  }
}

async function handleFileRoute(
  request: Request,
  env: Env,
  user: VerifiedUser,
  key: string,
): Promise<Response> {
  assertOwnsKey(user, key);

  switch (request.method) {
    case "PUT": {
      const body = await request.arrayBuffer();
      await env.SOURCE_DOCUMENTS.put(key, body, {
        httpMetadata: {
          contentType: request.headers.get("content-type") ?? "application/octet-stream",
        },
      });
      return json({ key, size: body.byteLength });
    }
    case "GET": {
      const object = await env.SOURCE_DOCUMENTS.get(key);
      if (!object) {
        return json({ error: "Not found." }, 404);
      }
      const headers = new Headers(corsHeaders);
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      return new Response(object.body, { headers });
    }
    case "DELETE": {
      await env.SOURCE_DOCUMENTS.delete(key);
      return json({ key, deleted: true });
    }
    default:
      return json({ error: "Method not allowed." }, 405);
  }
}

// ---- migrated Edge Function endpoints (Phase 3) ---------------------------
// Each maps 1:1 to a supabase/functions/* directory. Implement incrementally.
const FUNCTION_ROUTES = new Set([
  "register-document",
  "manage-document",
  "admin-document-maintenance",
  "register-law-source",
  "manage-law-source",
  "run-comparison",
  "run-bulk-comparison",
  "classify-revision",
  "analyze-selected-revisions",
]);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return preflight();
    }

    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);

    // Public health check.
    if (segments[0] === "health") {
      return json({ ok: true, service: "policy-revision-mgmt-system" });
    }

    try {
      const user = await authenticate(request, env);

      // /files/<objectKey...>
      if (segments[0] === "files") {
        const key = decodeURIComponent(segments.slice(1).join("/"));
        return await handleFileRoute(request, env, user, key);
      }

      // /functions/<name>
      if (segments[0] === "functions") {
        const name = segments[1];
        const db = getDb(env);
        const bucket = env.SOURCE_DOCUMENTS;

        switch (name) {
          case "register-document":
            return json(
              await registerDocument(
                (await request.json()) as RegisterDocumentRequest,
                user,
                db,
                bucket,
              ),
            );
          case "manage-document":
            return json(
              await manageDocument(
                (await request.json()) as ManageDocumentRequest,
                user,
                db,
                bucket,
              ),
            );
          case "admin-document-maintenance":
            return json(
              await adminDocumentMaintenance(
                (await request.json()) as AdminMaintenanceRequest,
                user,
                db,
                bucket,
              ),
            );
          case "register-law-source":
            return json(
              await registerLawSource(
                (await request.json()) as RegisterLawSourceRequest,
                user,
                db,
                bucket,
              ),
            );
          case "manage-law-source":
            return json(
              await manageLawSource(
                (await request.json()) as ManageLawSourceRequest,
                user,
                db,
              ),
            );
          case "run-comparison":
            return json(
              await runComparison((await request.json()) as RunComparisonRequest, user, db),
            );
          case "run-bulk-comparison":
            return json(
              await runBulkComparison(
                (await request.json()) as RunBulkComparisonRequest,
                user,
                db,
              ),
            );
          case "classify-revision":
            return json(
              await classifyRevision(
                (await request.json()) as ClassifyRevisionRequest,
                user,
                db,
                env,
              ),
            );
          case "analyze-selected-revisions":
            return json(
              await analyzeSelectedRevisions(
                (await request.json()) as AnalyzeSelectedRevisionsRequest,
                user,
                db,
                env,
              ),
            );
          default:
            if (FUNCTION_ROUTES.has(name)) {
              return json(
                { error: `Function '${name}' not yet implemented (Phase 3).`, uid: user.uid },
                501,
              );
            }
        }
      }

      return json({ error: "Not found." }, 404);
    } catch (error) {
      if (error instanceof HttpError) {
        return json({ error: error.message }, error.status);
      }
      const status =
        error && typeof (error as { status?: unknown }).status === "number"
          ? (error as { status: number }).status
          : 500;
      return json(
        { status: "error", error: error instanceof Error ? error.message : "Internal error." },
        status,
      );
    }
  },
};
