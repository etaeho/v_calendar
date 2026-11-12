/**
 * Edge Function: lesson-api
 *
 * POST JSON { op, ... } + 헤더 `Authorization: Bearer <로그인 사용자 access token>`
 * 응답 JSON: 성공 { ok: true, ... } / 실패 { ok: false, error: { code, message } } (HTTP 4xx/5xx)
 * 동작은 모두 ../_shared/lesson-api-core.ts (lib/server/lesson-api-core.ts 의 복사본) 에 있다.
 *
 * 필요한 시크릿: TZ=Asia/Seoul, ALLOWED_ORIGINS (쉼표로 구분한 origin 목록)
 * 자동 제공: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */
import { handle, type AuthUser } from "../_shared/lesson-api-core.ts";
import { env, jsonResponse, serve, serviceClient } from "../_shared/runtime.ts";
import { PgStore } from "./pg-store.ts";

const allowedOrigins = (env("ALLOWED_ORIGINS") ?? "")
  .split(",")
  .map((s) => s.trim().replace(/\/+$/, ""))
  .filter(Boolean);

function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = { Vary: "Origin" };
  if (origin && (allowedOrigins.includes("*") || allowedOrigins.includes(origin))) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Methods"] = "POST, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "authorization, x-client-info, apikey, content-type";
    headers["Access-Control-Max-Age"] = "86400";
  }
  return headers;
}

const db = serviceClient();
const store = new PgStore(db);

async function authenticate(req: Request): Promise<AuthUser | null> {
  const header = req.headers.get("Authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return null;
  const { data, error } = await db.auth.getUser(match[1].trim());
  if (error || !data?.user) return null;
  return { userId: data.user.id, email: data.user.email ?? null };
}

serve(async (req: Request) => {
  const cors = corsHeaders(req.headers.get("Origin"));
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST")
    return jsonResponse(405, { ok: false, error: { code: "BAD_REQUEST", message: "POST 만 지원합니다." } }, cors);

  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    body = null; // handle 이 BAD_REQUEST 로 응답
  }
  try {
    const auth = await authenticate(req);
    const res = await handle(body, auth, store, () => new Date().toISOString());
    return jsonResponse(res.status, res.json, cors);
  } catch (e) {
    console.error("lesson-api fatal", e);
    return jsonResponse(500, { ok: false, error: { code: "INTERNAL", message: "서버 오류가 발생했습니다." } }, cors);
  }
});
