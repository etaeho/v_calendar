/**
 * 외부 캘린더 연동 공개 API (UI 에서 쓰는 것들).
 *
 * - integrationStatus()        : 메뉴/설정 화면에 "실제 연동 / 가상 일정(이유)" 표시
 * - calendarSyncServices[p].connect(userId) : **버튼 클릭 핸들러 안에서** 호출 (구글=팝업, 카카오=페이지 이동)
 * - completeKakaoLogin()       : 앱 첫 로드 시 한 번 호출 → { status: "connected", userId } 면 syncCalendar("KAKAO")
 * - preloadIntegrations()      : 앱 마운트 시 호출하면 로그인 스크립트를 미리 받아 팝업 차단을 줄인다
 * - subscribeIntegrationErrors : 백그라운드 Push 실패 등을 토스트로 알리고 싶을 때
 */
import type { ExternalProvider } from "../../types/calendar";
import type { CalendarSyncService } from "../services/calendar-sync";
import { integrationConfig, isRealMode } from "./config.ts";
import { GoogleCalendarSyncService } from "./google-calendar.ts";
import { KakaoCalendarSyncService } from "./kakao-calendar.ts";

export {
  integrationStatus,
  integrationConfig,
  isRealMode,
  type IntegrationMode,
  type IntegrationStatusMap,
  type ProviderIntegrationStatus,
} from "./config.ts";
export {
  CalendarIntegrationError,
  isIntegrationError,
  subscribeIntegrationErrors,
  type IntegrationErrorCode,
} from "./errors.ts";
export { completeKakaoLogin, type KakaoLoginResult } from "./kakao-calendar.ts";
export { GoogleCalendarSyncService } from "./google-calendar.ts";
export { KakaoCalendarSyncService } from "./kakao-calendar.ts";

let google: GoogleCalendarSyncService | undefined;
let kakao: KakaoCalendarSyncService | undefined;

/** 실제 연동 서비스 싱글턴 (설정 여부와 무관하게 만든다 — 선택은 레지스트리가 한다) */
export function getRealCalendarService(provider: ExternalProvider): CalendarSyncService & { preload(): Promise<void> } {
  if (provider === "GOOGLE") {
    return (google ??= new GoogleCalendarSyncService({ clientId: integrationConfig.googleClientId }));
  }
  return (kakao ??= new KakaoCalendarSyncService());
}

/** 실제 모드인 제공자의 로그인 스크립트를 미리 불러온다. 실패해도 throw 하지 않는다 */
export async function preloadIntegrations(): Promise<void> {
  const providers: ExternalProvider[] = ["GOOGLE", "KAKAO"];
  await Promise.all(
    providers
      .filter((p) => isRealMode(p))
      .map((p) => getRealCalendarService(p).preload().catch(() => undefined)),
  );
}
