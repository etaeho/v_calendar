/**
 * 외부 캘린더 연동 설정.
 *
 * 공개(NEXT_PUBLIC_*) 환경 변수는 `next build` 시점에 번들에 문자열로 박힌다.
 * (Next.js 는 `process.env.NEXT_PUBLIC_X` 를 그대로 쓴 곳만 치환하므로 동적 조회 금지)
 * 값이 없거나, 브라우저가 아니거나, 제공자에 닿을 수 없는 환경(claude.ai 미리보기 등)이면
 * 해당 제공자는 Mock(가상 일정)으로 동작한다.
 */
import type { ExternalProvider } from "../../types/calendar";

/**
 * esbuild 로 묶는 단일 HTML 미리보기에는 `process` 가 없어서 ReferenceError 가 난다.
 * 읽기를 함수로 감싸 예외를 빈 값으로 바꾼다. (Next.js 빌드에서는 함수 안의 참조도 문자열로 치환된다)
 */
function readEnv(read: () => string | undefined): string {
  try {
    return (read() ?? "").trim();
  } catch {
    return "";
  }
}

export interface IntegrationConfig {
  /** Google OAuth 클라이언트 ID (공개 값) */
  googleClientId: string;
  /** 카카오 JavaScript 키 (공개 값) */
  kakaoJsKey: string;
  /** 카카오 로그인 Redirect URI — 카카오 개발자 콘솔에 등록한 값과 정확히 같아야 한다 */
  kakaoRedirectUri: string;
  /** Supabase 프로젝트 URL — 카카오 토큰 교환 Edge Function(kakao-oauth) 호출에 사용 */
  supabaseUrl: string;
  /** (선택) Supabase anon/publishable 키 — 함수가 JWT 검증을 켠 채 배포된 경우 필요 */
  supabaseAnonKey: string;
}

export const integrationConfig: IntegrationConfig = {
  googleClientId: readEnv(() => process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID),
  kakaoJsKey: readEnv(() => process.env.NEXT_PUBLIC_KAKAO_JS_KEY),
  kakaoRedirectUri: readEnv(() => process.env.NEXT_PUBLIC_KAKAO_REDIRECT_URI),
  supabaseUrl: readEnv(() => process.env.NEXT_PUBLIC_SUPABASE_URL).replace(/\/+$/, ""),
  supabaseAnonKey: readEnv(() => process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
};

/** 카카오 인가 코드 → 토큰 교환 함수 주소 */
export const kakaoTokenExchangeUrl = (config: IntegrationConfig = integrationConfig) =>
  config.supabaseUrl ? `${config.supabaseUrl}/functions/v1/kakao-oauth` : "";

export type IntegrationMode = "real" | "mock";

export interface ProviderIntegrationStatus {
  /** 필요한 환경 변수가 모두 빌드에 들어 있는지 */
  configured: boolean;
  /** 실제로 쓰이는 구현 */
  mode: IntegrationMode;
  /** mock 인 이유 (사용자에게 보여 줄 수 있는 한국어) */
  reason?: string;
}

export type IntegrationStatusMap = Record<ExternalProvider, ProviderIntegrationStatus>;

/** 런타임 환경 요약 — 테스트에서 주입할 수 있게 분리 */
export interface RuntimeEnv {
  isBrowser: boolean;
  /** https 또는 localhost (OAuth 는 보안 컨텍스트에서만 동작) */
  isSecureContext: boolean;
  /** sandbox iframe 등 origin 이 "null" 인 환경 (claude.ai 미리보기 등) */
  opaqueOrigin: boolean;
}

export function detectRuntime(): RuntimeEnv {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return { isBrowser: false, isSecureContext: false, opaqueOrigin: false };
  }
  let opaqueOrigin = false;
  try {
    opaqueOrigin = window.location.origin === "null" || window.location.protocol === "file:";
  } catch {
    opaqueOrigin = true;
  }
  return { isBrowser: true, isSecureContext: !!window.isSecureContext, opaqueOrigin };
}

/** 스크립트 로드 실패 등으로 실제 연동이 불가능하다고 판정된 제공자 */
const unreachable: Partial<Record<ExternalProvider, string>> = {};

/** 런타임에 제공자에 닿을 수 없음을 기록 → 이후 integrationStatus 는 mock 으로 보고한다 */
export function markProviderUnreachable(provider: ExternalProvider, reason: string) {
  unreachable[provider] = reason;
}

/** 테스트용 */
export function resetProviderReachability() {
  delete unreachable.GOOGLE;
  delete unreachable.KAKAO;
}

function missingKeys(provider: ExternalProvider, config: IntegrationConfig): string[] {
  if (provider === "GOOGLE") return config.googleClientId ? [] : ["NEXT_PUBLIC_GOOGLE_CLIENT_ID"];
  const missing: string[] = [];
  if (!config.kakaoJsKey) missing.push("NEXT_PUBLIC_KAKAO_JS_KEY");
  if (!config.kakaoRedirectUri) missing.push("NEXT_PUBLIC_KAKAO_REDIRECT_URI");
  if (!config.supabaseUrl) missing.push("NEXT_PUBLIC_SUPABASE_URL");
  return missing;
}

function statusOf(
  provider: ExternalProvider,
  config: IntegrationConfig,
  runtime: RuntimeEnv,
): ProviderIntegrationStatus {
  const missing = missingKeys(provider, config);
  if (missing.length > 0) {
    return { configured: false, mode: "mock", reason: `설정 없음 (${missing.join(", ")}) — 가상 일정으로 동작` };
  }
  if (!runtime.isBrowser) return { configured: true, mode: "mock", reason: "브라우저 환경이 아님" };
  if (runtime.opaqueOrigin) {
    return { configured: true, mode: "mock", reason: "미리보기 환경에서는 외부 로그인을 쓸 수 없어 가상 일정으로 동작" };
  }
  if (!runtime.isSecureContext) {
    return { configured: true, mode: "mock", reason: "https(또는 localhost)에서만 외부 캘린더에 연결할 수 있음" };
  }
  const blocked = unreachable[provider];
  if (blocked) return { configured: true, mode: "mock", reason: blocked };
  return { configured: true, mode: "real" };
}

/** 제공자별 연동 상태 (메뉴/설정 화면 표시용) */
export function integrationStatus(
  config: IntegrationConfig = integrationConfig,
  runtime: RuntimeEnv = detectRuntime(),
): IntegrationStatusMap {
  return {
    GOOGLE: statusOf("GOOGLE", config, runtime),
    KAKAO: statusOf("KAKAO", config, runtime),
  };
}

export const isRealMode = (provider: ExternalProvider) => integrationStatus()[provider].mode === "real";
