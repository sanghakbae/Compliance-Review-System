// CORS helper for the Cloudflare Workers backend.
// Ported from supabase/functions/_shared/cors.ts (kept permissive; tighten the
// allowed origin before production if the frontend origin is fixed).
export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, x-client-info",
  "Access-Control-Max-Age": "86400",
};

export function preflight(): Response {
  return new Response("ok", { headers: corsHeaders });
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}
