/**
 * Edge Function: notify-dispatch — 쌓인 알림(notifications.alimtalk_status = PENDING)을
 * 카카오 알림톡(Solapi)으로 보낸다. pg_cron + pg_net 으로 몇 분마다 호출한다 (docs/SETUP-SUPABASE.md).
 *
 * 보내는 조건: SOLAPI_API_KEY / SOLAPI_API_SECRET / SOLAPI_PFID / 종류별 템플릿 id 시크릿이 있고,
 * 받는 멤버에게 phone 과 kakao_opt_in=true 가 있을 것. 아니면 SKIPPED (+ 이유).
 *
 * 호출 인증: 헤더 `x-dispatch-secret` 가 시크릿 DISPATCH_SECRET 과 같아야 한다.
 */
import { env, jsonResponse, serve, serviceClient } from "../_shared/runtime.ts";
import {
  buildSolapiRequest,
  interpretSolapiResponse,
  planDispatch,
  readSolapiConfig,
  type DispatchRecipient,
} from "../_shared/solapi.ts";

const BATCH = 50;

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

type Row = Record<string, unknown>;

serve(async (req: Request) => {
  const secret = env("DISPATCH_SECRET");
  if (!secret) return jsonResponse(500, { ok: false, error: "DISPATCH_SECRET 시크릿이 설정되지 않았습니다." });
  if (!safeEqual(req.headers.get("x-dispatch-secret") ?? "", secret))
    return jsonResponse(401, { ok: false, error: "unauthorized" });

  const db = serviceClient();
  const { config, missing } = readSolapiConfig(env);

  const { data: claimed, error } = await db.rpc("claim_pending_notifications", { p_limit: BATCH });
  if (error) return jsonResponse(500, { ok: false, error: error.message });
  const rows = (claimed ?? []) as Row[];

  const recipients = new Map<string, DispatchRecipient | null>();
  async function recipientOf(studioId: string, appKey: string) {
    const key = `${studioId}/${appKey}`;
    if (!recipients.has(key)) {
      const { data, error } = await db
        .from("members")
        .select("phone, kakao_opt_in")
        .eq("studio_id", studioId)
        .eq("app_key", appKey)
        .maybeSingle();
      if (error) throw new Error(error.message);
      const r = data as Row | null;
      recipients.set(key, r ? { phone: (r.phone as string | null) ?? null, kakaoOptIn: r.kakao_opt_in === true } : null);
    }
    return recipients.get(key) ?? null;
  }

  async function finish(id: string, status: "SENT" | "FAILED" | "SKIPPED", reason: string | null) {
    const { error } = await db
      .from("notifications")
      .update({ alimtalk_status: status, alimtalk_error: reason })
      .eq("id", id);
    if (error) console.error("notify-dispatch: 상태 저장 실패", id, error.message);
  }

  const summary = { claimed: rows.length, sent: 0, failed: 0, skipped: 0 };
  for (const row of rows) {
    const id = String(row.id);
    try {
      const recipient = await recipientOf(String(row.studio_id), String(row.recipient_app_key));
      const plan = planDispatch(
        { kind: String(row.kind), title: String(row.title), body: String(row.body) },
        recipient,
        config,
        missing,
      );
      if (plan.action === "SKIP") {
        summary.skipped += 1;
        await finish(id, "SKIPPED", plan.reason);
        continue;
      }
      const request = await buildSolapiRequest(config!, plan);
      const res = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body });
      const json = await res.json().catch(() => null);
      const result = interpretSolapiResponse(res.status, json);
      if (result.ok) {
        summary.sent += 1;
        await finish(id, "SENT", null);
      } else {
        summary.failed += 1;
        await finish(id, "FAILED", result.error.slice(0, 500));
      }
    } catch (e) {
      summary.failed += 1;
      await finish(id, "FAILED", String(e instanceof Error ? e.message : e).slice(0, 500));
    }
  }
  return jsonResponse(200, { ok: true, ...summary });
});
