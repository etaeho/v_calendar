/**
 * Solapi 카카오 알림톡 발송 — 요청 만들기·서명·응답 해석 (순수 함수, Web Crypto 만 사용).
 *
 * 형식은 Solapi 공식 Node SDK(solapi@6.1.0) 소스와 맞춰 확인했다:
 *  - Authorization: `HMAC-SHA256 apiKey=<키>, date=<ISO 8601>, salt=<랜덤 문자열>, signature=<hex>`
 *    signature = HMAC-SHA256(apiSecret, date + salt) 의 16진수 문자열
 *  - 메시지: { to, from?, type: "ATA", kakaoOptions: { pfId, templateId, variables: {"#{변수}": 값}, disableSms } }
 *  - 응답: { groupInfo, failedMessageList: [{ to, statusCode, statusMessage, ... }], messageList? }
 * (developers.solapi.com 문서 자체는 이 작업 환경에서 열 수 없었다 — docs/SETUP-SUPABASE.md 참고)
 */
import type { NotificationKind } from "../notifications.ts";

export const SOLAPI_SEND_URL = "https://api.solapi.com/messages/v4/send-many/detail";

/** 알림톡 템플릿에 넣는 변수 이름 (템플릿 본문에 똑같이 써야 한다) */
export const TEMPLATE_VARIABLES = { title: "#{제목}", body: "#{내용}" } as const;

export interface SolapiConfig {
  apiKey: string;
  apiSecret: string;
  pfId: string;
  /** 알림 종류별 템플릿 id (없으면 SOLAPI_TEMPLATE_DEFAULT) */
  templates: Partial<Record<NotificationKind, string>>;
  /** 발신번호 (선택 — 알림톡 실패 시 문자 대체발송을 쓰지 않으므로 없어도 된다) */
  sender?: string;
}

const KINDS: NotificationKind[] = ["REQUEST", "RESOLVED", "MESSAGE"];

/** 환경 변수(시크릿)에서 설정을 읽는다. 필수 값이 없으면 config 없이 missing 목록만 */
export function readSolapiConfig(env: (name: string) => string | undefined): {
  config: SolapiConfig | null;
  missing: string[];
} {
  const get = (k: string) => env(k)?.trim() || undefined;
  const missing = ["SOLAPI_API_KEY", "SOLAPI_API_SECRET", "SOLAPI_PFID"].filter((k) => !get(k));
  const fallback = get("SOLAPI_TEMPLATE_DEFAULT");
  const templates: SolapiConfig["templates"] = {};
  for (const kind of KINDS) {
    const id = get(`SOLAPI_TEMPLATE_${kind}`) ?? fallback;
    if (id) templates[kind] = id;
  }
  if (missing.length > 0) return { config: null, missing };
  return {
    config: {
      apiKey: get("SOLAPI_API_KEY")!,
      apiSecret: get("SOLAPI_API_SECRET")!,
      pfId: get("SOLAPI_PFID")!,
      templates,
      sender: get("SOLAPI_SENDER")?.replace(/\D/g, ""),
    },
    missing: [],
  };
}

/** 국내 휴대폰 번호를 Solapi 형식(숫자만, 010…)으로. 형식이 아니면 undefined */
export function normalizeKrPhone(phone: string | null | undefined): string | undefined {
  if (!phone) return undefined;
  let digits = phone.replace(/[^\d+]/g, "");
  if (digits.startsWith("+82")) digits = `0${digits.slice(3)}`;
  digits = digits.replace(/\D/g, "");
  return /^01\d{8,9}$/.test(digits) ? digits : undefined;
}

export interface DispatchNotification {
  kind: string;
  title: string;
  body: string;
}

export interface DispatchRecipient {
  phone: string | null;
  kakaoOptIn: boolean;
}

export type DispatchPlan =
  | { action: "SEND"; to: string; templateId: string; variables: Record<string, string> }
  | { action: "SKIP"; reason: string };

/** 이 알림을 알림톡으로 보낼지, 안 보낸다면 이유 */
export function planDispatch(
  n: DispatchNotification,
  recipient: DispatchRecipient | null,
  config: SolapiConfig | null,
  missing: string[] = [],
): DispatchPlan {
  if (!config) return { action: "SKIP", reason: `알림톡 설정 없음 (${missing.join(", ") || "SOLAPI_*"})` };
  const templateId = config.templates[n.kind as NotificationKind];
  if (!templateId) return { action: "SKIP", reason: `템플릿 없음 (SOLAPI_TEMPLATE_${n.kind})` };
  if (!recipient) return { action: "SKIP", reason: "받는 사람(멤버)을 찾을 수 없음" };
  if (!recipient.kakaoOptIn) return { action: "SKIP", reason: "알림톡 수신 동의 안 함" };
  const to = normalizeKrPhone(recipient.phone);
  if (!to) return { action: "SKIP", reason: "휴대폰 번호 없음 또는 형식 오류" };
  return {
    action: "SEND",
    to,
    templateId,
    variables: { [TEMPLATE_VARIABLES.title]: n.title, [TEMPLATE_VARIABLES.body]: n.body },
  };
}

const SALT_ALPHABET = "1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

export function randomSalt(length = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (const b of bytes) out += SALT_ALPHABET[b % SALT_ALPHABET.length];
  return out;
}

export async function hmacSha256Hex(secret: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Solapi API Key 인증 헤더 값 */
export async function solapiAuthorization(apiKey: string, apiSecret: string, date: string, salt: string): Promise<string> {
  const signature = await hmacSha256Hex(apiSecret, date + salt);
  return `HMAC-SHA256 apiKey=${apiKey}, date=${date}, salt=${salt}, signature=${signature}`;
}

export interface SolapiHttpRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

/** 알림톡 1건 발송 요청 (date·salt 는 주입 — 테스트에서 결정적으로) */
export async function buildSolapiRequest(
  config: SolapiConfig,
  message: { to: string; templateId: string; variables: Record<string, string> },
  date: string = new Date().toISOString(),
  salt: string = randomSalt(),
): Promise<SolapiHttpRequest> {
  const payload = {
    messages: [
      {
        to: message.to,
        ...(config.sender ? { from: config.sender } : {}),
        type: "ATA",
        kakaoOptions: {
          pfId: config.pfId,
          templateId: message.templateId,
          variables: message.variables,
          // 알림톡 실패 시 문자(SMS)로 대신 보내지 않는다 (비용·발신번호 등록 불필요)
          disableSms: true,
        },
      },
    ],
  };
  return {
    url: SOLAPI_SEND_URL,
    method: "POST",
    headers: {
      Authorization: await solapiAuthorization(config.apiKey, config.apiSecret, date, salt),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  };
}

/** 발송 응답 해석: 접수 성공이면 ok, 아니면 저장할 오류 문자열 */
export function interpretSolapiResponse(status: number, json: unknown): { ok: true } | { ok: false; error: string } {
  const obj = (typeof json === "object" && json !== null ? json : {}) as Record<string, unknown>;
  if (status < 200 || status >= 300) {
    const code = typeof obj.errorCode === "string" ? obj.errorCode : `HTTP ${status}`;
    const msg = typeof obj.errorMessage === "string" ? obj.errorMessage : "";
    return { ok: false, error: `${code}${msg ? `: ${msg}` : ""}` };
  }
  const failed = Array.isArray(obj.failedMessageList) ? (obj.failedMessageList as Record<string, unknown>[]) : [];
  if (failed.length > 0) {
    const f = failed[0];
    return { ok: false, error: `${String(f.statusCode ?? "FAILED")}: ${String(f.statusMessage ?? "")}`.trim() };
  }
  return { ok: true };
}
