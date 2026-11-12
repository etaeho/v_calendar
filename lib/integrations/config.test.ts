import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import {
  integrationStatus,
  markProviderUnreachable,
  resetProviderReachability,
  type IntegrationConfig,
  type RuntimeEnv,
} from "./config.ts";

const full: IntegrationConfig = {
  googleClientId: "cid.apps.googleusercontent.com",
  kakaoJsKey: "js",
  kakaoRedirectUri: "https://etaeho.github.io/v_calendar/",
  supabaseUrl: "https://proj.supabase.co",
  supabaseAnonKey: "",
};
const empty: IntegrationConfig = { googleClientId: "", kakaoJsKey: "", kakaoRedirectUri: "", supabaseUrl: "", supabaseAnonKey: "" };
const browser: RuntimeEnv = { isBrowser: true, isSecureContext: true, opaqueOrigin: false };

afterEach(() => resetProviderReachability());

it("설정이 없으면 mock, 빠진 환경 변수를 이유로 알려 준다", () => {
  const status = integrationStatus(empty, browser);
  assert.equal(status.GOOGLE.configured, false);
  assert.equal(status.GOOGLE.mode, "mock");
  assert.match(status.GOOGLE.reason!, /NEXT_PUBLIC_GOOGLE_CLIENT_ID/);
  assert.match(status.KAKAO.reason!, /NEXT_PUBLIC_KAKAO_JS_KEY.*NEXT_PUBLIC_KAKAO_REDIRECT_URI.*NEXT_PUBLIC_SUPABASE_URL/);
});

it("설정이 있고 보안 컨텍스트 브라우저면 real", () => {
  assert.deepEqual(integrationStatus(full, browser), {
    GOOGLE: { configured: true, mode: "real" },
    KAKAO: { configured: true, mode: "real" },
  });
});

it("서버 렌더링 / 미리보기(sandbox) / http 에서는 설정이 있어도 mock", () => {
  assert.equal(integrationStatus(full, { isBrowser: false, isSecureContext: false, opaqueOrigin: false }).GOOGLE.mode, "mock");
  assert.equal(integrationStatus(full, { ...browser, opaqueOrigin: true }).GOOGLE.mode, "mock");
  assert.equal(integrationStatus(full, { ...browser, isSecureContext: false }).KAKAO.mode, "mock");
});

it("스크립트 로드 실패로 닿을 수 없다고 기록되면 mock", () => {
  markProviderUnreachable("KAKAO", "카카오 SDK 차단");
  const status = integrationStatus(full, browser);
  assert.equal(status.GOOGLE.mode, "real");
  assert.deepEqual(status.KAKAO, { configured: true, mode: "mock", reason: "카카오 SDK 차단" });
});
