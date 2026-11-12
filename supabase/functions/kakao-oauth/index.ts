/**
 * Supabase Edge Function: kakao-oauth
 *
 * 카카오 로그인 인가 코드(code)를 액세스 토큰으로 바꿔 준다.
 * REST API 키 / Client Secret 은 브라우저에 노출되면 안 되므로 이 함수의 비밀값으로만 둔다.
 *
 *   POST /functions/v1/kakao-oauth
 *   요청: { "code": "<인가 코드>", "redirectUri": "<카카오 로그인에 쓴 redirect URI>" }
 *   응답: { "access_token": "...", "expires_in": 21599, "refresh_token": "..."? }
 *         실패 시 { "error": "...", "error_description": "..." } (HTTP 400/500)
 *
 * 비밀값 (supabase secrets set ...):
 *   KAKAO_REST_API_KEY      필수 — 카카오 앱 REST API 키
 *   KAKAO_CLIENT_SECRET     선택 — [카카오 로그인 > 보안]에서 Client Secret 을 '사용함'으로 켰을 때만
 *   ALLOWED_ORIGINS         필수 — 쉼표로 구분한 허용 Origin (예: https://etaeho.github.io,http://localhost:3000)
 *   KAKAO_REDIRECT_URIS     선택 — 허용할 redirect URI 목록(쉼표 구분). 비우면 검사하지 않음
 *
 * 배포: supabase functions deploy kakao-oauth --no-verify-jwt
 *   (브라우저는 Supabase 로그인 없이 호출하므로 JWT 검증을 끈다. 이 함수는 인가 코드 교환만 한다.)
 *
 * 토큰 엔드포인트: POST https://kauth.kakao.com/oauth/token
 *   (application/x-www-form-urlencoded; grant_type=authorization_code, client_id, redirect_uri, code, client_secret?)
 */

// 이 파일은 Deno 에서 실행되지만 저장소의 `tsc --noEmit` 에도 포함되므로 필요한 Deno 전역만 선언한다.
declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (req: Request) => Response | Promise<Response>): unknown;
};

const KAKAO_TOKEN_URL = "https://kauth.kakao.com/oauth/token";

const list = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = list(Deno.env.get("ALLOWED_ORIGINS"));
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (origin && allowed.includes(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function json(body: unknown, status: number, cors: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("Origin");
  const cors = corsHeaders(origin);
  const originAllowed = !!cors["Access-Control-Allow-Origin"];

  if (req.method === "OPTIONS") {
    return new Response(null, { status: originAllowed ? 204 : 403, headers: cors });
  }
  if (req.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405, cors);
  }
  if (!originAllowed) {
    return json({ error: "origin_not_allowed", error_description: "ALLOWED_ORIGINS 에 없는 출처입니다." }, 403, cors);
  }

  const restApiKey = Deno.env.get("KAKAO_REST_API_KEY");
  if (!restApiKey) {
    return json({ error: "server_misconfigured", error_description: "KAKAO_REST_API_KEY 가 설정되지 않았습니다." }, 500, cors);
  }

  let code = "";
  let redirectUri = "";
  try {
    const body = (await req.json()) as { code?: unknown; redirectUri?: unknown };
    code = typeof body.code === "string" ? body.code : "";
    redirectUri = typeof body.redirectUri === "string" ? body.redirectUri : "";
  } catch {
    /* 아래에서 처리 */
  }
  if (!code || !redirectUri || code.length > 1024 || redirectUri.length > 2048) {
    return json({ error: "invalid_request", error_description: "code 와 redirectUri 가 필요합니다." }, 400, cors);
  }
  const allowedRedirects = list(Deno.env.get("KAKAO_REDIRECT_URIS"));
  if (allowedRedirects.length > 0 && !allowedRedirects.includes(redirectUri.replace(/\/+$/, ""))) {
    return json({ error: "invalid_request", error_description: "허용되지 않은 redirectUri 입니다." }, 400, cors);
  }

  const form = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: restApiKey,
    redirect_uri: redirectUri,
    code,
  });
  const clientSecret = Deno.env.get("KAKAO_CLIENT_SECRET");
  if (clientSecret) form.set("client_secret", clientSecret);

  let res: Response;
  try {
    res = await fetch(KAKAO_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
      body: form.toString(),
    });
  } catch (e) {
    console.error("kakao token request failed", e);
    return json({ error: "upstream_unreachable" }, 502, cors);
  }

  let data: Record<string, unknown> = {};
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    /* 무시 */
  }
  if (!res.ok || typeof data.access_token !== "string") {
    // 카카오 오류 예: { error: "invalid_grant", error_description: "authorization code not found ...", error_code: "KOE320" }
    return json(
      {
        error: typeof data.error === "string" ? data.error : "token_exchange_failed",
        error_description: typeof data.error_description === "string" ? data.error_description : undefined,
        error_code: typeof data.error_code === "string" ? data.error_code : undefined,
      },
      400,
      cors,
    );
  }

  return json(
    {
      access_token: data.access_token,
      expires_in: typeof data.expires_in === "number" ? data.expires_in : undefined,
      ...(typeof data.refresh_token === "string" ? { refresh_token: data.refresh_token } : {}),
      ...(typeof data.scope === "string" ? { scope: data.scope } : {}),
    },
    200,
    cors,
  );
});

export {};
