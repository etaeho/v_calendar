/**
 * 외부 캘린더 연동 공통 오류.
 *
 * 모든 실제 연동(구글/카카오)은 실패 시 CalendarIntegrationError 를 던진다.
 * `message` 는 사용자에게 그대로 보여 줄 수 있는 한국어 문장이다.
 */
import type { ExternalProvider } from "../../types/calendar";

export type IntegrationErrorCode =
  /** 환경 변수(클라이언트 ID 등)가 빌드에 없음 */
  | "NOT_CONFIGURED"
  /** 아직 계정을 연결하지 않음 */
  | "NOT_CONNECTED"
  /** 액세스 토큰 만료/무효 (HTTP 401) → 다시 연결 필요 */
  | "TOKEN_EXPIRED"
  /** 권한 없음 (HTTP 403: 동의 항목 누락, API 미사용 설정 등) */
  | "FORBIDDEN"
  /** 호출 한도 초과 (HTTP 429, 또는 403 rateLimitExceeded) */
  | "RATE_LIMITED"
  /** 로그인 스크립트(SDK) 로드 실패 — CSP/네트워크 차단 */
  | "SCRIPT_LOAD_FAILED"
  /** 팝업 차단 (connect 를 클릭 핸들러 밖에서 호출한 경우 등) */
  | "POPUP_BLOCKED"
  /** 사용자가 로그인/동의를 취소 */
  | "CANCELLED"
  /** 네트워크 오류 (fetch 자체 실패) */
  | "NETWORK"
  /** 그 밖의 API 오류 */
  | "API";

export class CalendarIntegrationError extends Error {
  readonly provider: ExternalProvider;
  readonly code: IntegrationErrorCode;
  /** HTTP 상태 코드 (있을 때만) */
  readonly status?: number;
  /** 제공자가 돌려준 원본 오류 정보 (디버깅용) */
  readonly detail?: unknown;

  constructor(
    provider: ExternalProvider,
    code: IntegrationErrorCode,
    message: string,
    extra: { status?: number; detail?: unknown } = {},
  ) {
    super(message);
    this.name = "CalendarIntegrationError";
    this.provider = provider;
    this.code = code;
    this.status = extra.status;
    this.detail = extra.detail;
  }
}

export const isIntegrationError = (e: unknown): e is CalendarIntegrationError =>
  e instanceof CalendarIntegrationError;

const providerLabel = (p: ExternalProvider) => (p === "GOOGLE" ? "구글" : "카카오");

/** 알 수 없는 예외를 CalendarIntegrationError 로 감싼다 */
export function toIntegrationError(provider: ExternalProvider, e: unknown): CalendarIntegrationError {
  if (e instanceof CalendarIntegrationError) return e;
  if (e instanceof TypeError) {
    // fetch 는 네트워크/CORS 실패를 TypeError 로 알린다
    return new CalendarIntegrationError(
      provider,
      "NETWORK",
      `${providerLabel(provider)} 서버에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.`,
      { detail: String(e) },
    );
  }
  return new CalendarIntegrationError(
    provider,
    "API",
    `${providerLabel(provider)} 캘린더 처리 중 오류가 발생했습니다.`,
    { detail: e instanceof Error ? e.message : e },
  );
}

/* ── 오류 구독 ──────────────────────────────────────────────
 * 스토어는 pushLesson/removeLesson 결과를 기다리지 않으므로(실패해도 레슨 확정은 유지)
 * 레지스트리 래퍼가 실패를 삼키고 여기로 알린다. UI 는 구독해서 토스트를 띄울 수 있다.
 */
type Listener = (error: CalendarIntegrationError, context: string) => void;
const listeners = new Set<Listener>();

export function subscribeIntegrationErrors(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function reportIntegrationError(
  provider: ExternalProvider,
  e: unknown,
  context: string,
): CalendarIntegrationError {
  const error = toIntegrationError(provider, e);
  console.warn(`[calendar-sync] ${provider} ${context} 실패:`, error.code, error.message, error.detail ?? "");
  for (const l of listeners) {
    try {
      l(error, context);
    } catch {
      /* 리스너 오류는 무시 */
    }
  }
  return error;
}
