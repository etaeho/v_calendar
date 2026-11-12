import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LessonSlot } from "../../types/calendar";
import { CalendarIntegrationError } from "./errors.ts";
import {
  buildGoogleLessonEvent,
  buildGoogleListUrl,
  buildGoogleLessonLookupUrl,
  GOOGLE_EVENTS_URL,
  GoogleCalendarSyncService,
  googleErrorFromResponse,
  listGoogleEvents,
  mapGoogleEvent,
  upsertGoogleLessonEvent,
} from "./google-calendar.ts";
import { mockFetch } from "./test-utils.ts";

const lesson: LessonSlot = {
  id: "slot-1",
  start: "2026-11-20T09:00:00.000Z",
  end: "2026-11-20T10:00:00.000Z",
  status: "CONFIRMED",
  studentId: "s1",
  lessonType: "REGULAR",
  threadId: "t1",
};

const range = { start: new Date("2026-11-01T00:00:00Z"), end: new Date("2026-12-01T00:00:00Z") };

describe("구글 캘린더 요청 빌드", () => {
  it("목록 URL 에 기간/단일 일정/정렬/최대 개수를 넣는다", () => {
    const url = new URL(buildGoogleListUrl(range, "next-token"));
    assert.equal(url.origin + url.pathname, GOOGLE_EVENTS_URL);
    assert.equal(url.searchParams.get("timeMin"), "2026-11-01T00:00:00.000Z");
    assert.equal(url.searchParams.get("timeMax"), "2026-12-01T00:00:00.000Z");
    assert.equal(url.searchParams.get("singleEvents"), "true");
    assert.equal(url.searchParams.get("orderBy"), "startTime");
    assert.equal(url.searchParams.get("maxResults"), "250");
    assert.equal(url.searchParams.get("pageToken"), "next-token");
  });

  it("레슨 검색은 privateExtendedProperty=vcalLessonId=<id> 로 한다", () => {
    const url = new URL(buildGoogleLessonLookupUrl("slot-1"));
    assert.equal(url.searchParams.get("privateExtendedProperty"), "vcalLessonId=slot-1");
  });

  it("레슨 일정 본문: 제목, 서울 시간대, 비공개 확장 속성", () => {
    const body = buildGoogleLessonEvent(lesson);
    assert.equal(body.summary, "바이올린 레슨");
    assert.deepEqual(body.start, { dateTime: "2026-11-20T09:00:00.000Z", timeZone: "Asia/Seoul" });
    assert.deepEqual(body.end, { dateTime: "2026-11-20T10:00:00.000Z", timeZone: "Asia/Seoul" });
    assert.deepEqual(body.extendedProperties, { private: { vcalLessonId: "slot-1" } });
    assert.equal(buildGoogleLessonEvent({ ...lesson, lessonType: "MAKEUP" }).summary, "보강 레슨");
  });
});

describe("구글 일정 매핑", () => {
  it("시간 일정과 종일 일정을 ExternalEvent 로 바꾼다", () => {
    assert.deepEqual(
      mapGoogleEvent(
        {
          id: "a",
          summary: "치과",
          location: "강남",
          start: { dateTime: "2026-11-05T14:00:00+09:00" },
          end: { dateTime: "2026-11-05T15:00:00+09:00" },
        },
        "u1",
      ),
      {
        id: "google-a",
        provider: "GOOGLE",
        ownerId: "u1",
        title: "치과",
        start: "2026-11-05T05:00:00.000Z",
        end: "2026-11-05T06:00:00.000Z",
        location: "강남",
      },
    );
    const allDay = mapGoogleEvent({ id: "b", start: { date: "2026-11-07" }, end: { date: "2026-11-08" } }, "u1");
    assert.equal(allDay?.title, "(제목 없음)");
    assert.equal(allDay?.start, new Date(2026, 10, 7).toISOString());
    assert.equal(allDay?.end, new Date(2026, 10, 8).toISOString());
    assert.equal(allDay?.location, undefined);
  });

  it("앱이 만든 레슨 일정과 취소된 일정은 제외한다", () => {
    const base = { start: { dateTime: "2026-11-05T14:00:00Z" }, end: { dateTime: "2026-11-05T15:00:00Z" } };
    assert.equal(
      mapGoogleEvent({ id: "c", ...base, extendedProperties: { private: { vcalLessonId: "slot-1" } } }, "u1"),
      null,
    );
    assert.equal(mapGoogleEvent({ id: "d", status: "cancelled", ...base }, "u1"), null);
  });
});

describe("구글 REST 호출", () => {
  it("페이지를 따라가며 목록을 모으고 Bearer 토큰을 보낸다", async () => {
    const fetch = mockFetch([
      {
        body: {
          items: [{ id: "1", summary: "A", start: { dateTime: "2026-11-02T01:00:00Z" }, end: { dateTime: "2026-11-02T02:00:00Z" } }],
          nextPageToken: "p2",
        },
      },
      {
        body: {
          items: [
            { id: "2", summary: "B", start: { dateTime: "2026-11-03T01:00:00Z" }, end: { dateTime: "2026-11-03T02:00:00Z" } },
            {
              id: "3",
              start: { dateTime: "2026-11-04T01:00:00Z" },
              end: { dateTime: "2026-11-04T02:00:00Z" },
              extendedProperties: { private: { vcalLessonId: "x" } },
            },
          ],
        },
      },
    ]);
    const events = await listGoogleEvents({ fetch, accessToken: "tok" }, "u1", range);
    assert.deepEqual(events.map((e) => e.id), ["google-1", "google-2"]);
    assert.equal(fetch.calls.length, 2);
    assert.equal(fetch.calls[0].headers.Authorization, "Bearer tok");
    assert.equal(new URL(fetch.calls[1].url).searchParams.get("pageToken"), "p2");
  });

  it("기존 일정이 없으면 생성(POST), 있으면 수정(PATCH) — 멱등", async () => {
    const create = mockFetch([{ body: { items: [] } }, { body: { id: "g-new" } }]);
    assert.equal(await upsertGoogleLessonEvent({ fetch: create, accessToken: "t" }, lesson), "g-new");
    assert.deepEqual(create.calls.map((c) => c.method), ["GET", "POST"]);
    assert.equal(create.calls[1].url, GOOGLE_EVENTS_URL);
    assert.equal(JSON.parse(create.calls[1].body!).extendedProperties.private.vcalLessonId, "slot-1");

    const update = mockFetch([
      {
        body: {
          items: [
            { id: "g-1", extendedProperties: { private: { vcalLessonId: "slot-1" } } },
            { id: "g-dup", extendedProperties: { private: { vcalLessonId: "slot-1" } } },
          ],
        },
      },
      { status: 204 },
      { body: { id: "g-1" } },
    ]);
    assert.equal(await upsertGoogleLessonEvent({ fetch: update, accessToken: "t" }, lesson), "g-1");
    assert.deepEqual(
      update.calls.map((c) => `${c.method} ${c.url.replace(GOOGLE_EVENTS_URL, "")}`),
      [`GET ${update.calls[0].url.replace(GOOGLE_EVENTS_URL, "")}`, "DELETE /g-dup", "PATCH /g-1"],
    );
  });

  it("HTTP 오류를 한국어 메시지의 타입 오류로 바꾼다", () => {
    assert.equal(googleErrorFromResponse(401, {}).code, "TOKEN_EXPIRED");
    assert.equal(googleErrorFromResponse(429, {}).code, "RATE_LIMITED");
    assert.equal(
      googleErrorFromResponse(403, { error: { errors: [{ reason: "rateLimitExceeded" }] } }).code,
      "RATE_LIMITED",
    );
    const forbidden = googleErrorFromResponse(403, { error: { errors: [{ reason: "insufficientPermissions" }] } });
    assert.equal(forbidden.code, "FORBIDDEN");
    assert.match(forbidden.message, /권한/);
    assert.match(googleErrorFromResponse(403, { error: { errors: [{ reason: "accessNotConfigured" }] } }).message, /사용 설정/);
  });
});

describe("GoogleCalendarSyncService", () => {
  /** GIS 토큰 클라이언트 흉내 */
  const fakeOAuth2 = (response: Record<string, unknown>) => ({
    initTokenClient: (cfg: { callback: (r: Record<string, unknown>) => void }) => ({
      requestAccessToken: () => cfg.callback(response),
    }),
    hasGrantedAllScopes: () => true,
    revoke: () => {},
  });

  it("connect 로 받은 토큰의 만료를 확인하고, 401 이면 연결을 끊는다", async () => {
    let now = 1_000_000;
    const fetch = mockFetch([{ status: 401, body: { error: { message: "Invalid Credentials" } } }]);
    const service = new GoogleCalendarSyncService({
      clientId: "cid",
      fetchImpl: fetch,
      now: () => now,
      loadOAuth2: async () => fakeOAuth2({ access_token: "tok", expires_in: 3600 }),
    });
    assert.equal(await service.isConnected("u1"), false);
    await service.connect("u1");
    assert.equal(await service.isConnected("u1"), true);

    await assert.rejects(service.fetchEvents("u1", range), (e: unknown) => {
      assert.ok(e instanceof CalendarIntegrationError);
      assert.equal(e.code, "TOKEN_EXPIRED");
      return true;
    });
    assert.equal(await service.isConnected("u1"), false);

    await service.connect("u1");
    now += 3600 * 1000;
    assert.equal(await service.isConnected("u1"), false, "만료된 토큰");
  });

  it("연결되지 않은 상태의 pushLesson 은 팝업 없이 NOT_CONNECTED", async () => {
    const service = new GoogleCalendarSyncService({
      clientId: "cid",
      fetchImpl: mockFetch([]),
      loadOAuth2: async () => {
        throw new Error("팝업을 띄우면 안 됨");
      },
    });
    await assert.rejects(service.pushLesson("u1", lesson), { code: "NOT_CONNECTED" });
  });

  it("같은 레슨을 동시에 두 번 Push 해도 순서대로 처리되어 한 번만 생성된다", async () => {
    // 두 번째 Push 의 검색은 첫 번째 Push 가 만든 일정을 찾는다
    const fetch = mockFetch([
      { body: { items: [] } },
      { body: { id: "g-1" } },
      { body: { items: [{ id: "g-1", extendedProperties: { private: { vcalLessonId: "slot-1" } } }] } },
      { body: { id: "g-1" } },
    ]);
    const service = new GoogleCalendarSyncService({
      clientId: "cid",
      fetchImpl: fetch,
      loadOAuth2: async () => fakeOAuth2({ access_token: "tok", expires_in: 3600 }),
    });
    await service.connect("u1");
    await service.connect("u2");
    const ids = await Promise.all([service.pushLesson("u1", lesson), service.pushLesson("u2", lesson)]);
    assert.deepEqual(ids, ["g-1", "g-1"]);
    assert.deepEqual(fetch.calls.map((c) => c.method), ["GET", "POST", "GET", "PATCH"]);
  });

  it("팝업 차단을 POPUP_BLOCKED 로 알린다", async () => {
    const service = new GoogleCalendarSyncService({
      clientId: "cid",
      loadOAuth2: async () => ({
        initTokenClient: (cfg: { error_callback?: (e: { type: string }) => void }) => ({
          requestAccessToken: () => cfg.error_callback?.({ type: "popup_failed_to_open" }),
        }),
        hasGrantedAllScopes: () => true,
        revoke: () => {},
      }),
    });
    await assert.rejects(service.connect("u1"), { code: "POPUP_BLOCKED" });
  });
});
