import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import {
  buildSolapiRequest,
  interpretSolapiResponse,
  normalizeKrPhone,
  planDispatch,
  randomSalt,
  readSolapiConfig,
  SOLAPI_SEND_URL,
  solapiAuthorization,
  type SolapiConfig,
} from "./solapi.ts";

const config: SolapiConfig = {
  apiKey: "NCSTESTKEY",
  apiSecret: "TESTSECRET",
  pfId: "KA01PF000",
  templates: { REQUEST: "TPL_REQ", RESOLVED: "TPL_RES" },
};

describe("Solapi 알림톡", () => {
  it("인증 헤더: HMAC-SHA256(apiSecret, date+salt) 의 hex", async () => {
    const date = "2026-11-12T00:00:00.000Z";
    const salt = "abcdefghijklmnopqrstuvwxyz012345";
    const expected = createHmac("sha256", "TESTSECRET").update(date + salt).digest("hex");
    const header = await solapiAuthorization("NCSTESTKEY", "TESTSECRET", date, salt);
    assert.equal(header, `HMAC-SHA256 apiKey=NCSTESTKEY, date=${date}, salt=${salt}, signature=${expected}`);
    assert.match(header, /^HMAC-SHA256 apiKey=[^,]+, date=[^,]+, salt=[0-9A-Za-z]+, signature=[0-9a-f]{64}$/);
  });

  it("salt 는 32자 영숫자", () => {
    const s = randomSalt();
    assert.match(s, /^[0-9A-Za-z]{32}$/);
    assert.notEqual(s, randomSalt());
  });

  it("발송 요청 본문", async () => {
    const req = await buildSolapiRequest(
      config,
      { to: "01012345678", templateId: "TPL_REQ", variables: { "#{제목}": "제목", "#{내용}": "내용" } },
      "2026-11-12T00:00:00.000Z",
      "salt",
    );
    assert.equal(req.url, SOLAPI_SEND_URL);
    assert.equal(req.url, "https://api.solapi.com/messages/v4/send-many/detail");
    assert.equal(req.method, "POST");
    assert.equal(req.headers["Content-Type"], "application/json");
    assert.ok(req.headers.Authorization.startsWith("HMAC-SHA256 apiKey=NCSTESTKEY, date=2026-11-12T00:00:00.000Z, salt=salt, signature="));
    assert.deepEqual(JSON.parse(req.body), {
      messages: [
        {
          to: "01012345678",
          type: "ATA",
          kakaoOptions: { pfId: "KA01PF000", templateId: "TPL_REQ", variables: { "#{제목}": "제목", "#{내용}": "내용" }, disableSms: true },
        },
      ],
    });
  });

  it("보낼지 결정: 설정·템플릿·동의·번호가 모두 있어야 SEND", () => {
    const n = { kind: "REQUEST", title: "김하은의 보강 요청", body: "11/20(금) 15:00" };
    const ok = { phone: "010-1234-5678", kakaoOptIn: true };
    assert.equal(planDispatch(n, ok, null, ["SOLAPI_API_KEY"]).action, "SKIP");
    assert.equal(planDispatch({ ...n, kind: "MESSAGE" }, ok, config).action, "SKIP");
    assert.equal(planDispatch(n, null, config).action, "SKIP");
    assert.equal(planDispatch(n, { ...ok, kakaoOptIn: false }, config).action, "SKIP");
    assert.equal(planDispatch(n, { ...ok, phone: null }, config).action, "SKIP");
    assert.deepEqual(planDispatch(n, ok, config), {
      action: "SEND",
      to: "01012345678",
      templateId: "TPL_REQ",
      variables: { "#{제목}": n.title, "#{내용}": n.body },
    });
  });

  it("설정 읽기 · 번호 정규화 · 응답 해석", () => {
    const env: Record<string, string> = { SOLAPI_API_KEY: "k", SOLAPI_API_SECRET: "s", SOLAPI_PFID: "p", SOLAPI_TEMPLATE_DEFAULT: "D", SOLAPI_TEMPLATE_MESSAGE: "M" };
    const r = readSolapiConfig((k) => env[k]);
    assert.deepEqual(r.config?.templates, { REQUEST: "D", RESOLVED: "D", MESSAGE: "M" });
    assert.deepEqual(readSolapiConfig(() => undefined).missing, ["SOLAPI_API_KEY", "SOLAPI_API_SECRET", "SOLAPI_PFID"]);
    assert.equal(normalizeKrPhone("+82 10-1234-5678"), "01012345678");
    assert.equal(normalizeKrPhone("02-123-4567"), undefined);
    assert.deepEqual(interpretSolapiResponse(200, { groupInfo: {}, failedMessageList: [] }), { ok: true });
    assert.deepEqual(interpretSolapiResponse(200, { failedMessageList: [{ statusCode: "3104", statusMessage: "템플릿 불일치" }] }), {
      ok: false,
      error: "3104: 템플릿 불일치",
    });
    assert.deepEqual(interpretSolapiResponse(401, { errorCode: "SignatureDoesNotMatch", errorMessage: "bad" }), {
      ok: false,
      error: "SignatureDoesNotMatch: bad",
    });
  });
});
