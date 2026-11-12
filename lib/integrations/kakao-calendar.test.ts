import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LessonSlot } from "../../types/calendar";
import type { IntegrationConfig } from "./config.ts";
import {
  buildKakaoCreateBody,
  buildKakaoLessonEvent,
  buildKakaoListUrls,
  completeKakaoLogin,
  KAKAO_CREATE_URL,
  KAKAO_DELETE_URL,
  KAKAO_OAUTH_STATE_KEY,
  KAKAO_TOKEN_KEY,
  KAKAO_UPDATE_URL,
  KakaoCalendarSyncService,
  KakaoPushedMap,
  kakaoErrorFromResponse,
  kakaoTime,
  listKakaoEvents,
  mapKakaoEvent,
  nextPageUrl,
  upsertKakaoLessonEvent,
} from "./kakao-calendar.ts";
import { MemoryStorage } from "./shared.ts";
import { mockFetch } from "./test-utils.ts";

const lesson: LessonSlot = {
  id: "slot-1",
  start: "2026-11-20T09:00:00.000Z",
  end: "2026-11-20T10:00:00.000Z",
  status: "CONFIRMED",
  studentId: "s1",
  lessonType: "MAKEUP",
  threadId: "t1",
};

const config: IntegrationConfig = {
  googleClientId: "",
  kakaoJsKey: "js",
  kakaoRedirectUri: "https://example.github.io/v_calendar/",
  supabaseUrl: "https://proj.supabase.co",
  supabaseAnonKey: "",
};

describe("카카오 요청 빌드", () => {
  it("시각을 UTC·초 단위·5분 단위로 맞춘다", () => {
    assert.equal(kakaoTime(new Date("2026-11-20T09:03:12.345Z")), "2026-11-20T09:00:00Z");
    assert.equal(kakaoTime(new Date("2026-11-20T09:03:12.345Z"), "ceil"), "2026-11-20T09:05:00Z");
    assert.equal(kakaoTime(new Date("2026-11-20T09:05:00.000Z"), "ceil"), "2026-11-20T09:05:00Z");
  });

  it("조회 기간을 31일 이하로 나눈다", () => {
    const urls = buildKakaoListUrls({
      start: new Date("2026-11-01T00:00:00Z"),
      end: new Date("2027-01-15T00:00:00Z"),
    }).map((u) => new URL(u));
    assert.equal(urls.length, 3);
    assert.deepEqual(
      urls.map((u) => [u.searchParams.get("from"), u.searchParams.get("to")]),
      [
        ["2026-11-01T00:00:00Z", "2026-12-02T00:00:00Z"],
        ["2026-12-02T00:00:00Z", "2027-01-02T00:00:00Z"],
        ["2027-01-02T00:00:00Z", "2027-01-15T00:00:00Z"],
      ],
    );
  });

  it("레슨 일정: 제목, 서울 시간대, 앱 표식이 붙은 설명, form 의 event 파라미터", () => {
    const event = buildKakaoLessonEvent(lesson);
    assert.equal(event.title, "보강 레슨");
    assert.deepEqual(event.time, {
      start_at: "2026-11-20T09:00:00Z",
      end_at: "2026-11-20T10:00:00Z",
      time_zone: "Asia/Seoul",
      all_day: false,
      lunar: false,
    });
    assert.match(event.description, /\[vcal:slot-1\]$/);
    const form = buildKakaoCreateBody(lesson);
    assert.deepEqual(JSON.parse(form.get("event")!), event);
  });

  it("다음 페이지는 kapi.kakao.com 주소만 따른다", () => {
    assert.equal(nextPageUrl("/v2/api/calendar/events?page_token=x"), "https://kapi.kakao.com/v2/api/calendar/events?page_token=x");
    assert.equal(nextPageUrl("https://evil.example.com/steal"), undefined);
    assert.equal(nextPageUrl(undefined), undefined);
  });
});

describe("카카오 일정 매핑", () => {
  it("시간 일정과 종일 일정을 ExternalEvent 로 바꾼다", () => {
    assert.deepEqual(
      mapKakaoEvent(
        {
          id: "k1",
          title: "가족 모임",
          time: { start_at: "2026-11-05T09:00:00Z", end_at: "2026-11-05T11:00:00Z", time_zone: "Asia/Seoul" },
          location: { name: "본가" },
        },
        "u1",
      ),
      {
        id: "kakao-k1",
        provider: "KAKAO",
        ownerId: "u1",
        title: "가족 모임",
        start: "2026-11-05T09:00:00.000Z",
        end: "2026-11-05T11:00:00.000Z",
        location: "본가",
      },
    );
    const allDay = mapKakaoEvent(
      { id: "k2", time: { start_at: "2026-11-07T00:00:00Z", end_at: "2026-11-07T00:00:00Z", all_day: true } },
      "u1",
    );
    assert.equal(allDay?.title, "(제목 없음)");
    assert.equal(allDay?.start, new Date(2026, 10, 7).toISOString());
    assert.equal(allDay?.end, new Date(2026, 10, 8).toISOString());
  });

  it("앱이 만든 일정(표식 또는 매핑된 id)과 시간 없는 일정은 제외한다", () => {
    const time = { start_at: "2026-11-05T09:00:00Z", end_at: "2026-11-05T10:00:00Z" };
    assert.equal(mapKakaoEvent({ id: "a", time, description: "…\n[vcal:slot-9]" }, "u1"), null);
    assert.equal(mapKakaoEvent({ id: "b", time }, "u1", new Set(["b"])), null);
    assert.equal(mapKakaoEvent({ id: "c" }, "u1"), null);
  });
});

describe("카카오 REST 호출", () => {
  it("구간별로 조회하고 after_url 을 따라가며 중복을 제거한다", async () => {
    const ev = (id: string, day: number) => ({
      id,
      title: id,
      time: { start_at: `2026-11-${String(day).padStart(2, "0")}T01:00:00Z`, end_at: `2026-11-${String(day).padStart(2, "0")}T02:00:00Z` },
    });
    const fetch = mockFetch([
      { body: { events: [ev("a", 3)], has_next_events: true, after_url: "https://kapi.kakao.com/v2/api/calendar/events?next=1" } },
      { body: { events: [ev("b", 4)], has_next_events: false } },
      { body: { events: [ev("b", 4), ev("c", 28)] } },
    ]);
    const events = await listKakaoEvents(
      { fetch, accessToken: "tok" },
      "u1",
      { start: new Date("2026-11-01T00:00:00Z"), end: new Date("2026-12-10T00:00:00Z") },
    );
    assert.deepEqual(events.map((e) => e.id), ["kakao-a", "kakao-b", "kakao-c"]);
    assert.equal(fetch.calls[0].headers.Authorization, "Bearer tok");
    assert.equal(fetch.calls[1].url, "https://kapi.kakao.com/v2/api/calendar/events?next=1");
  });

  it("매핑이 없으면 생성, 있으면 수정, 원본이 지워졌으면 다시 생성 (멱등)", async () => {
    const pushed = new KakaoPushedMap(new MemoryStorage(), "u1");
    const create = mockFetch([{ body: { event_id: "e1" } }]);
    assert.equal(await upsertKakaoLessonEvent({ fetch: create, accessToken: "t" }, pushed, lesson), "e1");
    assert.equal(create.calls[0].url, KAKAO_CREATE_URL);
    assert.equal(create.calls[0].headers["Content-Type"], "application/x-www-form-urlencoded;charset=utf-8");
    assert.equal(pushed.get("slot-1"), "e1");

    const update = mockFetch([{ body: { event_id: "e1" } }]);
    assert.equal(await upsertKakaoLessonEvent({ fetch: update, accessToken: "t" }, pushed, lesson), "e1");
    assert.equal(update.calls[0].url, KAKAO_UPDATE_URL);
    assert.equal(new URLSearchParams(update.calls[0].body).get("event_id"), "e1");

    const recreate = mockFetch([{ status: 400, body: { code: -2, msg: "event not found" } }, { body: { event_id: "e2" } }]);
    assert.equal(await upsertKakaoLessonEvent({ fetch: recreate, accessToken: "t" }, pushed, lesson), "e2");
    assert.deepEqual(recreate.calls.map((c) => c.url), [KAKAO_UPDATE_URL, KAKAO_CREATE_URL]);
  });

  it("오류 코드를 한국어 타입 오류로 바꾼다", () => {
    assert.equal(kakaoErrorFromResponse(401, { code: -401 }).code, "TOKEN_EXPIRED");
    assert.equal(kakaoErrorFromResponse(403, { code: -402 }).code, "FORBIDDEN");
    assert.match(kakaoErrorFromResponse(403, { code: -3 }).message, /사용 신청/);
    assert.equal(kakaoErrorFromResponse(429, {}).code, "RATE_LIMITED");
    assert.equal(kakaoErrorFromResponse(500, { msg: "x" }).code, "API");
  });
});

describe("카카오 로그인 완료 처리", () => {
  it("state 가 맞으면 함수로 코드를 교환하고 토큰을 저장한다", async () => {
    const storage = new MemoryStorage();
    storage.setItem(KAKAO_OAUTH_STATE_KEY, JSON.stringify({ nonce: "n1", userId: "u1" }));
    const fetch = mockFetch([{ body: { access_token: "kt", expires_in: 100, refresh_token: "r" } }]);
    const result = await completeKakaoLogin("https://example.github.io/v_calendar/?code=abc&state=n1", {
      fetchImpl: fetch,
      storage,
      config,
      now: () => 0,
    });
    assert.deepEqual(result, { status: "connected", userId: "u1" });
    assert.equal(fetch.calls[0].url, "https://proj.supabase.co/functions/v1/kakao-oauth");
    assert.deepEqual(JSON.parse(fetch.calls[0].body!), { code: "abc", redirectUri: config.kakaoRedirectUri });
    assert.deepEqual(JSON.parse(storage.getItem(KAKAO_TOKEN_KEY("u1"))!), { accessToken: "kt", expiresAt: 100_000 });
    assert.equal(storage.getItem(KAKAO_OAUTH_STATE_KEY), null, "state 는 한 번만 쓴다");

    const service = new KakaoCalendarSyncService({ config, sessionStorage: storage, localStorage: new MemoryStorage(), now: () => 0 });
    assert.equal(await service.isConnected("u1"), true);
    const later = new KakaoCalendarSyncService({ config, sessionStorage: storage, now: () => 100_000 });
    assert.equal(await later.isConnected("u1"), false, "만료");
  });

  it("code 가 없거나 state 가 다르면 아무것도 하지 않는다", async () => {
    const storage = new MemoryStorage();
    storage.setItem(KAKAO_OAUTH_STATE_KEY, JSON.stringify({ nonce: "n1", userId: "u1" }));
    const fetch = mockFetch([]);
    assert.deepEqual(await completeKakaoLogin("https://x.io/", { fetchImpl: fetch, storage, config }), { status: "none" });
    assert.deepEqual(await completeKakaoLogin("https://x.io/?code=a&state=zz", { fetchImpl: fetch, storage, config }), {
      status: "none",
    });
    assert.equal(fetch.calls.length, 0);
  });

  it("사용자가 동의를 취소하면 CANCELLED, 교환 실패면 API 오류", async () => {
    const storage = new MemoryStorage();
    storage.setItem(KAKAO_OAUTH_STATE_KEY, JSON.stringify({ nonce: "n1", userId: "u1" }));
    const cancelled = await completeKakaoLogin("https://x.io/?error=access_denied&state=n1", { storage, config });
    assert.equal(cancelled.status === "error" && cancelled.error.code, "CANCELLED");

    storage.setItem(KAKAO_OAUTH_STATE_KEY, JSON.stringify({ nonce: "n2", userId: "u1" }));
    const failed = await completeKakaoLogin("https://x.io/?code=a&state=n2", {
      storage,
      config,
      fetchImpl: mockFetch([{ status: 400, body: { error: "invalid_grant" } }]),
    });
    assert.equal(failed.status === "error" && failed.error.code, "API");
  });
});

describe("KakaoCalendarSyncService", () => {
  const connected = () => {
    const session = new MemoryStorage();
    session.setItem(KAKAO_TOKEN_KEY("u1"), JSON.stringify({ accessToken: "kt", expiresAt: Date.now() + 3_600_000 }));
    return session;
  };

  it("Push 한 일정은 목록에서 제외하고, 삭제는 매핑된 event_id 로 한다", async () => {
    const local = new MemoryStorage();
    const fetch = mockFetch([
      { body: { event_id: "e1" } },
      {
        body: {
          events: [
            { id: "e1", title: "보강 레슨", time: { start_at: "2026-11-20T09:00:00Z", end_at: "2026-11-20T10:00:00Z" } },
            { id: "x", title: "개인", time: { start_at: "2026-11-21T09:00:00Z", end_at: "2026-11-21T10:00:00Z" } },
          ],
        },
      },
      { body: { event_id: "e1" } },
    ]);
    const service = new KakaoCalendarSyncService({ config, fetchImpl: fetch, sessionStorage: connected(), localStorage: local });
    assert.equal(await service.pushLesson("u1", lesson), "e1");
    const events = await service.fetchEvents("u1", {
      start: new Date("2026-11-15T00:00:00Z"),
      end: new Date("2026-11-30T00:00:00Z"),
    });
    assert.deepEqual(events.map((e) => e.id), ["kakao-x"]);
    await service.removeLesson("u1", "slot-1");
    assert.equal(fetch.calls[2].method, "DELETE");
    assert.equal(fetch.calls[2].url, `${KAKAO_DELETE_URL}?event_id=e1`);
    await service.removeLesson("u1", "slot-1"); // 다시 지워도 요청 없음
    assert.equal(fetch.calls.length, 3);
  });

  it("401 이면 저장된 토큰을 지운다", async () => {
    const session = connected();
    const service = new KakaoCalendarSyncService({
      config,
      sessionStorage: session,
      localStorage: new MemoryStorage(),
      fetchImpl: mockFetch([{ status: 401, body: { code: -401, msg: "this access token does not exist" } }]),
      autoConnect: false,
    });
    await assert.rejects(service.pushLesson("u1", lesson), { code: "TOKEN_EXPIRED" });
    assert.equal(await service.isConnected("u1"), false);
  });

  it("연결 전 pushLesson 은 로그인 이동 없이 NOT_CONNECTED", async () => {
    const service = new KakaoCalendarSyncService({
      config,
      sessionStorage: new MemoryStorage(),
      localStorage: new MemoryStorage(),
      loadSdk: async () => {
        throw new Error("이동하면 안 됨");
      },
    });
    await assert.rejects(service.pushLesson("u1", lesson), { code: "NOT_CONNECTED" });
  });
});
