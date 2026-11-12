// 시간대를 가장 먼저 Asia/Seoul 로 (서버와 같은 조건)
import "./tz-seoul.ts";
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { LessonState } from "../../types/calendar.ts";
import type { AppNotification } from "../notifications.ts";
import { handle, type ApiResponse, type AuthUser } from "./lesson-api-core.ts";
import { holidayLookup } from "./holidays.ts";
import { MemoryStore } from "./memory-store.ts";

const local = (m: number, d: number, h: number) => new Date(2026, m - 1, d, h).toISOString();
const NOW = local(11, 12, 9);
const now = () => NOW;

const teacher: AuthUser = { userId: "u-teacher", email: "Teacher@Example.com" };
const alice: AuthUser = { userId: "u-alice", email: "alice@example.com" };
const bob: AuthUser = { userId: "u-bob", email: "BOB@example.com" };
const stranger: AuthUser = { userId: "u-stranger", email: "who@example.com" };

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const call = async (store: MemoryStore, auth: AuthUser | null, body: unknown) => {
  const r: ApiResponse = await handle(body, auth, store, now);
  return { status: r.status, body: r.json as Json };
};

/** 강사 생성 → 레슨생 2명 초대 → 둘 다 로그인 → 각자 수강 등록 */
async function setup() {
  const store = new MemoryStore();
  const boot = await call(store, teacher, { op: "bootstrap", studioName: "유진 바이올린", instructorName: "정유진" });
  assert.equal(boot.status, 200, JSON.stringify(boot.body));
  await call(store, teacher, { op: "addMember", name: "김하은", email: "Alice@example.com", phone: "010-1234-5678" });
  const added = await call(store, teacher, { op: "addMember", name: "박서준", email: "bob@example.com" });
  const keyOf = (name: string) => added.body.members.find((m: Json) => m.name === name).appKey as string;
  const aliceKey = keyOf("김하은");
  const bobKey = keyOf("박서준");
  await call(store, alice, { op: "me" });
  await call(store, bob, { op: "me" });
  for (const [studentId, weekday] of [
    [aliceKey, 2],
    [bobKey, 1],
  ] as const) {
    const r = await call(store, teacher, {
      op: "command",
      command: {
        type: "registerEnrollment",
        input: { studentId, startDate: "2026-11-13", endDate: "2026-12-31", times: [{ weekday, time: "19:00", durationMin: 60 }], weeks: [1, 2, 3, 4], changeDeadlineHours: 24, fee: weekday === 1 ? 300000 : 200000 },
      },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  const studioId = store.studios[0].id;
  return { store, studioId, aliceKey, bobKey, teacherKey: boot.body.member.appKey as string };
}

describe("lesson-api core", () => {
  beforeEach(() => assert.equal(new Date(2026, 0, 1).getTimezoneOffset(), -540));

  it("bootstrap → me: 강사 멤버와 빈 상태(version 0)가 만들어진다", async () => {
    const store = new MemoryStore();
    assert.deepEqual((await call(store, teacher, { op: "me" })).body, { ok: true, member: null });
    const boot = await call(store, teacher, { op: "bootstrap", studioName: "유진 바이올린", instructorName: "정유진" });
    assert.equal(boot.status, 200);
    const m = boot.body.member;
    assert.match(m.appKey, /^t-[0-9a-f]{8}$/);
    assert.equal(m.role, "INSTRUCTOR");
    assert.equal(m.studioName, "유진 바이올린");
    assert.deepEqual((await call(store, teacher, { op: "me" })).body.member, m);
    assert.equal(store.members[0].email, "teacher@example.com");
    const v = await call(store, teacher, { op: "view" });
    assert.equal(v.body.version, 0);
    assert.deepEqual(v.body.state, { enrollments: [], makeupAdjustments: [], slots: [], requests: [], comments: [] });
    // 두 번째 bootstrap 은 거절
    const again = await call(store, teacher, { op: "bootstrap", studioName: "x", instructorName: "y" });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, "CONFLICT");
  });

  it("초대된 레슨생은 처음 로그인할 때 이메일(대소문자 무시)로 연결된다", async () => {
    const store = new MemoryStore();
    await call(store, teacher, { op: "bootstrap", studioName: "S", instructorName: "T" });
    const added = await call(store, teacher, { op: "addMember", name: "박서준", email: "bob@example.com" });
    assert.equal(added.status, 200);
    const invited = added.body.members.find((m: Json) => m.role === "STUDENT");
    assert.match(invited.appKey, /^s-[0-9a-f]{8}$/);
    assert.equal(invited.linked, false);
    const me = await call(store, bob, { op: "me" });
    assert.equal(me.body.member.appKey, invited.appKey);
    assert.equal(me.body.member.role, "STUDENT");
    assert.equal(store.members.find((m) => m.appKey === invited.appKey)!.userId, bob.userId);
    // 같은 이메일 중복 추가는 CONFLICT
    const dup = await call(store, teacher, { op: "addMember", name: "중복", email: "Bob@Example.com" });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error.code, "CONFLICT");
  });

  it("전체 흐름: 등록 → 레슨생 보기 → 보강 신청 → 승인 → 알림 · 버전 · 이벤트", async () => {
    const { store, studioId, aliceKey, bobKey, teacherKey } = await setup();
    assert.equal(store.states.get(studioId)!.version, 2);
    assert.deepEqual(store.events.map((e) => e.version), [1, 2]);

    // 레슨생 보기: 자기 것만, 다른 레슨생 이름·id·수강료 없음
    const view = await call(store, alice, { op: "view" });
    assert.equal(view.status, 200);
    const text = JSON.stringify(view.body);
    assert.ok(!text.includes(bobKey), "다른 레슨생 id 노출");
    assert.ok(!text.includes("박서준"), "다른 레슨생 이름 노출");
    assert.ok(!text.includes("300000"), "다른 레슨생 수강료 노출");
    assert.deepEqual(
      view.body.members.map((m: Json) => [m.role, m.name]).sort(),
      [["INSTRUCTOR", "정유진"], ["STUDENT", "김하은"]],
    );
    assert.equal(view.body.members[0].email, undefined);
    assert.ok((view.body.state as LessonState).enrollments.every((e) => e.studentId === aliceKey));
    // 강사 보기: 전체
    const tview = await call(store, teacher, { op: "view" });
    assert.equal(tview.body.members.length, 3);
    assert.equal(tview.body.state.enrollments.length, 2);

    // 강사가 빈 슬롯을 열고, 레슨생이 보강 신청
    const open = await call(store, teacher, { op: "command", command: { type: "createOpenSlot", start: local(11, 20, 15), end: local(11, 20, 16) } });
    assert.equal(open.status, 200);
    const slotId = open.body.result.slotId as string;
    assert.ok(slotId.startsWith("slot-"));
    assert.equal(open.body.version, 3);

    const booking = await call(store, alice, {
      op: "command",
      // 클라이언트가 보낸 행위자 정보는 무시된다
      command: { type: "requestBooking", slotId, message: "보강 부탁드려요", actor: { userId: teacherKey, role: "INSTRUCTOR" } },
    });
    assert.equal(booking.status, 200, JSON.stringify(booking.body));
    const req = (booking.body.state as LessonState).requests.at(-1)!;
    assert.equal(req.studentId, aliceKey);
    assert.equal(req.status, "PENDING");

    // 강사 알림
    let tn = await call(store, teacher, { op: "notifications" });
    assert.equal(tn.body.notifications.length, 1);
    assert.equal(tn.body.notifications[0].kind, "REQUEST");
    assert.match(tn.body.notifications[0].title, /김하은의 보강 요청/);

    const approve = await call(store, teacher, { op: "command", command: { type: "approve", requestId: req.id } });
    assert.equal(approve.status, 200);
    assert.equal(approve.body.version, 5);
    assert.equal(approve.body.state.slots.find((s: Json) => s.id === slotId).status, "CONFIRMED");
    assert.deepEqual(store.events.map((e) => e.version), [1, 2, 3, 4, 5]);

    const an = await call(store, alice, { op: "notifications" });
    assert.deepEqual(an.body.notifications.map((n: AppNotification) => [n.recipient, n.kind, n.title]), [[aliceKey, "RESOLVED", "보강 승인됨"]]);
    // 다른 레슨생에게는 알림 없음
    assert.equal((await call(store, bob, { op: "notifications" })).body.notifications.length, 0);
    assert.ok(store.notifications.every((n) => n.alimtalkStatus === "PENDING"));

    // 읽음 처리: 남의 알림 id 는 무시
    const mr = await call(store, alice, { op: "markRead", ids: [an.body.notifications[0].id, tn.body.notifications[0].id] });
    assert.equal(mr.body.updated, 1);
    tn = await call(store, teacher, { op: "notifications" });
    assert.equal(tn.body.notifications[0].readAt, undefined);
    assert.equal((await call(store, alice, { op: "notifications" })).body.notifications[0].readAt, NOW);
  });

  it("규칙 위반(LessonError)은 저장하지 않는다", async () => {
    const { store, studioId, bobKey } = await setup();
    const before = store.states.get(studioId)!;
    const events = store.events.length;
    // 레슨생은 슬롯을 열 수 없다
    const r = await call(store, alice, { op: "command", command: { type: "createOpenSlot", start: local(11, 20, 15), end: local(11, 20, 16) } });
    assert.equal(r.status, 403);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.error.code, "FORBIDDEN");
    // 다른 레슨생 레슨에 보강 조정 (권한 없음)
    const r2 = await call(store, alice, { op: "command", command: { type: "adjustMakeup", studentId: bobKey, delta: 1, reason: "x" } });
    assert.equal(r2.body.error.code, "FORBIDDEN");
    // 없는 슬롯
    const r3 = await call(store, alice, { op: "command", command: { type: "requestBooking", slotId: "nope" } });
    assert.equal(r3.body.error.code, "NOT_FOUND");
    assert.equal(store.states.get(studioId), before);
    assert.equal(store.events.length, events);
    assert.equal(store.notifications.length, 0);
  });

  it("버전 충돌이면 다시 읽어 재실행한다 (CAS 재시도)", async () => {
    const { store, studioId } = await setup();
    let interfered = 0;
    store.beforeCommit = (id) => {
      if (interfered >= 2) return;
      interfered += 1;
      // 다른 요청이 먼저 저장한 것처럼 버전을 올린다
      const cur = store.states.get(id)!;
      store.states.set(id, { state: cur.state, version: cur.version + 1 });
    };
    const r = await call(store, teacher, { op: "command", command: { type: "createOpenSlot", start: local(11, 20, 15), end: local(11, 20, 16) } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(interfered, 2);
    assert.equal(r.body.version, 5); // 2 → (방해 3, 4) → 5
    assert.equal(store.states.get(studioId)!.state.slots.filter((s) => s.status === "OPEN").length, 1);

    // 계속 충돌하면 CONFLICT, 저장 없음
    store.beforeCommit = (id) => {
      const cur = store.states.get(id)!;
      store.states.set(id, { state: cur.state, version: cur.version + 1 });
    };
    const r2 = await call(store, teacher, { op: "command", command: { type: "createOpenSlot", start: local(11, 21, 15), end: local(11, 21, 16) } });
    assert.equal(r2.status, 409);
    assert.equal(r2.body.error.code, "CONFLICT");
    assert.equal(store.states.get(studioId)!.state.slots.filter((s) => s.status === "OPEN").length, 1);
  });

  it("권한: 비로그인 / 비멤버 / 레슨생의 addMember", async () => {
    const { store } = await setup();
    const anon = await call(store, null, { op: "view" });
    assert.equal(anon.status, 401);
    assert.equal(anon.body.error.code, "UNAUTHENTICATED");
    for (const op of ["view", "notifications", "addMember"]) {
      const r = await call(store, stranger, { op, name: "x", email: "x@example.com" });
      assert.equal(r.status, 403);
      assert.equal(r.body.error.code, "NOT_MEMBER");
    }
    assert.deepEqual((await call(store, stranger, { op: "me" })).body, { ok: true, member: null });
    const r = await call(store, alice, { op: "addMember", name: "침입자", email: "evil@example.com" });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, "FORBIDDEN");
    assert.equal(store.members.length, 3);
  });

  it("입력 검증: 알 수 없는 op / 명령 / 잘못된 필드 / 남의 스튜디오 레슨생", async () => {
    const { store } = await setup();
    const cases: [unknown, string][] = [
      [null, "BAD_REQUEST"],
      [{ op: "drop" }, "BAD_REQUEST"],
      [{ op: "command", command: { type: "hack" } }, "BAD_REQUEST"],
      [{ op: "command", command: { type: "createOpenSlot", start: "nope", end: local(11, 20, 16) } }, "BAD_REQUEST"],
      [{ op: "command", command: { type: "adjustMakeup", studentId: "s-00000000", delta: 1, reason: "x" } }, "BAD_REQUEST"],
      [{ op: "markRead", ids: "all" }, "BAD_REQUEST"],
      [{ op: "addMember", name: "x", email: "not-an-email" }, "BAD_REQUEST"],
    ];
    for (const [body, code] of cases) {
      const r = await call(store, teacher, body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.body.error.code, code);
    }
  });

  it("view 는 시간 경과(만료·공휴일)를 반영해 저장하고 만료 알림을 만든다", async () => {
    const { store, studioId, aliceKey } = await setup();
    const open = await call(store, teacher, { op: "command", command: { type: "createOpenSlot", start: local(11, 12, 15), end: local(11, 12, 16) } });
    await call(store, alice, { op: "command", command: { type: "requestBooking", slotId: open.body.result.slotId } });
    const version = store.states.get(studioId)!.version;
    // 다음 날: 응답 없이 시간이 지나 만료
    const later = await handle({ op: "view" }, alice, store, () => local(11, 13, 9));
    const body = later.json as Json;
    assert.equal(body.version, version + 1);
    assert.equal(body.state.requests.at(-1).status, "EXPIRED");
    const expired = store.notifications.filter((n) => n.title.includes("만료"));
    assert.deepEqual(expired.map((n) => n.recipient), [aliceKey]);
    // 다시 보기: 바뀐 것 없으면 저장하지 않는다
    await handle({ op: "view" }, alice, store, () => local(11, 13, 9));
    assert.equal(store.states.get(studioId)!.version, version + 1);
  });

  it("공휴일 조회는 현지 날짜 기준이고 등록 시 공휴일 레슨이 표시된다", async () => {
    assert.equal(holidayLookup(new Date(2026, 11, 25, 19)), "크리스마스");
    assert.equal(holidayLookup(new Date(2026, 11, 24, 23, 59)), undefined);
    const store = new MemoryStore();
    await call(store, teacher, { op: "bootstrap", studioName: "S", instructorName: "T" });
    const added = await call(store, teacher, { op: "addMember", name: "김하은", email: "alice@example.com" });
    const studentId = added.body.members.find((m: Json) => m.role === "STUDENT").appKey;
    const r = await call(store, teacher, {
      op: "command",
      command: { type: "registerEnrollment", input: { studentId, startDate: "2026-12-01", endDate: "2026-12-31", times: [{ weekday: 5, time: "19:00", durationMin: 60 }], weeks: [1, 2, 3, 4], changeDeadlineHours: 0 } },
    });
    assert.equal(r.body.result.created, 4);
    const xmas = (r.body.state as LessonState).slots.find((s) => s.holidayName);
    assert.equal(xmas?.holidayName, "크리스마스");
    assert.equal(new Date(xmas!.start).getDate(), 25);
  });

  it("서버 시간대가 Asia/Seoul 이 아니면 SERVER_TZ", async () => {
    const r = await handle({ op: "me" }, teacher, new MemoryStore(), now, { timezoneOffset: () => 0 });
    assert.equal(r.status, 500);
    assert.equal((r.json as Json).error.code, "SERVER_TZ");
  });

  it("updateProfile 로 본인 연락처·알림톡 동의를 바꾼다", async () => {
    const { store, aliceKey } = await setup();
    const r = await call(store, alice, { op: "updateProfile", phone: "010 9999 8888", kakaoOptIn: true });
    assert.equal(r.status, 200);
    const m = store.members.find((x) => x.appKey === aliceKey)!;
    assert.equal(m.phone, "01099998888");
    assert.equal(m.kakaoOptIn, true);
  });
});
