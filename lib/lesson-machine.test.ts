import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Actor, LessonState } from "../types/calendar";
import {
  addComment,
  approveRequest,
  cancelRequest,
  createOpenSlot,
  deleteOpenSlot,
  getSlotViews,
  LessonError,
  moveOpenSlot,
  planDrop,
  rejectRequest,
  requestBooking,
  requestChange,
  requestChangeToNewTime,
  type MachineContext,
} from "./lesson-machine.ts";

const teacher: Actor = { userId: "t1", role: "INSTRUCTOR" };
const me: Actor = { userId: "s1", role: "STUDENT" };
const other: Actor = { userId: "s2", role: "STUDENT" };

function makeCtx(): MachineContext {
  let n = 0;
  return { now: () => "2026-01-01T00:00:00.000Z", id: (p) => `${p}-${++n}` };
}

const at = (day: number, hour: number) =>
  new Date(Date.UTC(2026, 0, day, hour)).toISOString();

function seed(): LessonState {
  return {
    slots: [
      { id: "open1", start: at(5, 10), end: at(5, 11), status: "OPEN", threadId: "t-open1" },
      { id: "open2", start: at(6, 10), end: at(6, 11), status: "OPEN", threadId: "t-open2" },
      {
        id: "mine",
        start: at(7, 10),
        end: at(7, 11),
        status: "CONFIRMED",
        studentId: "s1",
        lessonType: "REGULAR",
        threadId: "t-mine",
      },
      {
        id: "theirs",
        start: at(8, 10),
        end: at(8, 11),
        status: "CONFIRMED",
        studentId: "s2",
        lessonType: "REGULAR",
        threadId: "t-theirs",
      },
    ],
    requests: [],
    comments: [],
  };
}

const slot = (s: LessonState, id: string) => s.slots.find((x) => x.id === id)!;
const throwsCode = (fn: () => unknown, code: string) =>
  assert.throws(fn, (e) => e instanceof LessonError && e.code === code);

describe("슬롯 오픈", () => {
  it("강사만 생성할 수 있고 겹치는 시간은 거부한다", () => {
    const ctx = makeCtx();
    const { state, slot: created } = createOpenSlot(
      seed(),
      teacher,
      { start: at(9, 10), end: at(9, 11) },
      ctx,
    );
    assert.equal(created.status, "OPEN");
    assert.equal(state.slots.length, 5);
    throwsCode(() => createOpenSlot(seed(), me, { start: at(9, 10), end: at(9, 11) }, ctx), "FORBIDDEN");
    throwsCode(() => createOpenSlot(seed(), teacher, { start: at(5, 10), end: at(5, 12) }, ctx), "OVERLAP");
    throwsCode(() => createOpenSlot(seed(), teacher, { start: at(9, 11), end: at(9, 10) }, ctx), "INVALID_RANGE");
  });

  it("OPEN 슬롯만 삭제할 수 있다", () => {
    assert.equal(deleteOpenSlot(seed(), teacher, "open1").slots.length, 3);
    throwsCode(() => deleteOpenSlot(seed(), teacher, "mine"), "INVALID_STATE");
    throwsCode(() => deleteOpenSlot(seed(), me, "open1"), "FORBIDDEN");
  });
});

describe("보강 신청 (OPEN → PENDING_BOOKING → CONFIRMED | OPEN)", () => {
  it("신청 후 강사가 승인하면 확정된다", () => {
    const ctx = makeCtx();
    let s = requestBooking(seed(), me, "open1", ctx, "이 시간 가능할까요?");
    assert.equal(slot(s, "open1").status, "PENDING_BOOKING");
    assert.equal(slot(s, "open1").studentId, "s1");
    const req = s.requests[0];
    assert.equal(req.status, "PENDING");
    // 요청 메시지는 메신저(댓글)가 아니라 요청에 붙는다
    assert.equal(req.message, "이 시간 가능할까요?");
    assert.equal(s.comments.filter((c) => c.kind === "USER").length, 0);

    // 신청한 본인이나 다른 레슨생은 승인할 수 없다
    throwsCode(() => approveRequest(s, me, req.id, ctx), "FORBIDDEN");
    throwsCode(() => approveRequest(s, other, req.id, ctx), "FORBIDDEN");

    s = approveRequest(s, teacher, req.id, ctx);
    assert.equal(slot(s, "open1").status, "CONFIRMED");
    assert.equal(slot(s, "open1").lessonType, "MAKEUP");
    assert.equal(slot(s, "open1").requestId, undefined);
    assert.equal(s.requests[0].status, "APPROVED");
    throwsCode(() => approveRequest(s, teacher, req.id, ctx), "INVALID_STATE");
  });

  it("거절하면 OPEN 으로 돌아가고 사유가 기록되며 이전 대화는 노출되지 않는다", () => {
    const ctx = makeCtx();
    let s = requestBooking(seed(), me, "open1", ctx, "부탁드립니다");
    const oldThread = slot(s, "open1").threadId;
    s = rejectRequest(s, teacher, s.requests[0].id, ctx, "그 시간은 어렵습니다");
    assert.equal(slot(s, "open1").status, "OPEN");
    assert.equal(slot(s, "open1").studentId, undefined);
    assert.notEqual(slot(s, "open1").threadId, oldThread);
    assert.equal(s.requests[0].status, "REJECTED");
    assert.equal(s.requests[0].rejectReason, "그 시간은 어렵습니다");
    // 다시 다른 레슨생이 신청할 수 있다
    s = requestBooking(s, other, "open1", ctx);
    assert.equal(slot(s, "open1").studentId, "s2");
  });

  it("이미 점유된 슬롯은 신청할 수 없고, 신청자는 직접 취소할 수 있다", () => {
    const ctx = makeCtx();
    let s = requestBooking(seed(), me, "open1", ctx);
    throwsCode(() => requestBooking(s, other, "open1", ctx), "INVALID_STATE");
    throwsCode(() => requestBooking(seed(), teacher, "open1", ctx), "FORBIDDEN");
    throwsCode(() => cancelRequest(s, other, s.requests[0].id, ctx), "FORBIDDEN");
    s = cancelRequest(s, me, s.requests[0].id, ctx);
    assert.equal(slot(s, "open1").status, "OPEN");
    assert.equal(s.requests[0].status, "CANCELLED");
  });
});

describe("일정 변경 (CONFIRMED+OPEN → PENDING_CHANGE → swap | 유지)", () => {
  it("레슨생 요청 → 강사 승인 시 기존 슬롯은 OPEN, 신규 슬롯은 CONFIRMED", () => {
    const ctx = makeCtx();
    let s = requestChange(seed(), me, "mine", "open2", ctx, "출장이 있어요");
    assert.equal(slot(s, "mine").status, "PENDING_CHANGE");
    assert.equal(slot(s, "open2").status, "PENDING_CHANGE");
    assert.equal(slot(s, "open2").threadId, "t-mine");
    const req = s.requests[0];
    assert.equal(req.fromSlotId, "mine");
    assert.equal(req.toSlotId, "open2");
    throwsCode(() => approveRequest(s, me, req.id, ctx), "FORBIDDEN");

    s = approveRequest(s, teacher, req.id, ctx);
    assert.equal(slot(s, "mine").status, "OPEN");
    assert.equal(slot(s, "mine").studentId, undefined);
    assert.notEqual(slot(s, "mine").threadId, "t-mine");
    assert.equal(slot(s, "open2").status, "CONFIRMED");
    assert.equal(slot(s, "open2").studentId, "s1");
    assert.equal(slot(s, "open2").lessonType, "REGULAR");
    assert.equal(s.requests[0].message, "출장이 있어요");
    // 대화 스레드는 새 슬롯이 이어받는다
    assert.equal(slot(s, "open2").threadId, "t-mine");
  });

  it("강사 요청은 해당 레슨생의 동의가 필요하다", () => {
    const ctx = makeCtx();
    let s = requestChange(seed(), teacher, "mine", "open2", ctx);
    const req = s.requests[0];
    assert.equal(req.requestedBy, "INSTRUCTOR");
    throwsCode(() => approveRequest(s, teacher, req.id, ctx), "FORBIDDEN");
    throwsCode(() => approveRequest(s, other, req.id, ctx), "FORBIDDEN");
    s = approveRequest(s, me, req.id, ctx);
    assert.equal(slot(s, "open2").status, "CONFIRMED");
    // 강사가 제안한 변경이므로 기존 시간은 다시 열리지 않고 사라진다
    assert.equal(s.slots.some((x) => x.id === "mine"), false);
    assert.ok(s.comments.some((c) => c.body.startsWith("레슨생이 일정 변경에 동의했습니다")));
  });

  it("거절하면 기존 일정이 유지되고 사유가 댓글로 남는다", () => {
    const ctx = makeCtx();
    let s = requestChange(seed(), me, "mine", "open2", ctx);
    s = rejectRequest(s, teacher, s.requests[0].id, ctx, "공연 일정");
    assert.equal(slot(s, "mine").status, "CONFIRMED");
    assert.equal(slot(s, "mine").requestId, undefined);
    assert.equal(slot(s, "open2").status, "OPEN");
    assert.equal(slot(s, "open2").studentId, undefined);
    assert.notEqual(slot(s, "open2").threadId, "t-mine");
    assert.ok(s.comments.some((c) => c.threadId === "t-mine" && c.body.includes("공연 일정")));
  });

  it("남의 레슨, 확정되지 않은 레슨, 빈 슬롯이 아닌 대상은 거부한다", () => {
    const ctx = makeCtx();
    throwsCode(() => requestChange(seed(), me, "theirs", "open2", ctx), "FORBIDDEN");
    throwsCode(() => requestChange(seed(), me, "open1", "open2", ctx), "INVALID_STATE");
    throwsCode(() => requestChange(seed(), me, "mine", "theirs", ctx), "INVALID_STATE");
    const s = requestChange(seed(), me, "mine", "open2", ctx);
    throwsCode(() => requestChange(s, me, "mine", "open1", ctx), "INVALID_STATE");
  });
});

describe("댓글 · 마스킹", () => {
  it("본인 레슨에만 댓글을 남길 수 있다", () => {
    const ctx = makeCtx();
    assert.equal(addComment(seed(), me, "mine", " 안녕하세요 ", ctx).comments[0].body, "안녕하세요");
    assert.equal(addComment(seed(), teacher, "theirs", "네", ctx).comments.length, 1);
    throwsCode(() => addComment(seed(), me, "theirs", "?", ctx), "FORBIDDEN");
    throwsCode(() => addComment(seed(), me, "open1", "?", ctx), "INVALID_STATE");
  });

  it("레슨생에게 다른 레슨생의 슬롯은 마감됨으로 마스킹된다", () => {
    const ctx = makeCtx();
    const s = requestChange(requestBooking(seed(), other, "open1", ctx), me, "mine", "open2", ctx);
    const views = new Map(getSlotViews(s, me).map((v) => [v.slot.id, v]));
    for (const id of ["theirs", "open1"]) {
      const v = views.get(id)!;
      assert.equal(v.display, "CLOSED");
      assert.equal(v.masked, true);
      assert.equal(v.slot.studentId, undefined);
      assert.equal(v.slot.requestId, undefined);
      assert.equal(v.request, undefined);
    }
    assert.equal(views.get("mine")!.display, "PENDING_CHANGE_FROM");
    assert.equal(views.get("open2")!.display, "PENDING_CHANGE_TO");
    assert.equal(views.get("mine")!.mine, true);

    const teacherViews = getSlotViews(s, teacher);
    assert.ok(teacherViews.every((v) => !v.masked));
    assert.equal(teacherViews.find((v) => v.slot.id === "open1")!.display, "PENDING_BOOKING");
  });
});

describe("드래그 앤 드롭", () => {
  const NOW = at(1, 0);

  it("강사는 빈 슬롯을 겹치지 않는 시간으로 옮길 수 있다", () => {
    const s = moveOpenSlot(seed(), teacher, "open1", { start: at(5, 13), end: at(5, 14) });
    assert.equal(slot(s, "open1").start, at(5, 13));
    assert.equal(slot(s, "open1").threadId, "t-open1");
    throwsCode(() => moveOpenSlot(seed(), teacher, "open1", { start: at(6, 10), end: at(6, 11) }), "OVERLAP");
    throwsCode(() => moveOpenSlot(seed(), me, "open1", { start: at(5, 13), end: at(5, 14) }), "FORBIDDEN");
    throwsCode(() => moveOpenSlot(seed(), teacher, "mine", { start: at(5, 13), end: at(5, 14) }), "INVALID_STATE");
  });

  it("강사가 확정 레슨을 새 시간으로 옮기면 슬롯이 열리고 레슨생 동의를 기다린다", () => {
    const ctx = makeCtx();
    let s = requestChangeToNewTime(seed(), teacher, "mine", { start: at(9, 15), end: at(9, 16) }, ctx, "공연 때문에요");
    const req = s.requests[0];
    const target = slot(s, req.toSlotId);
    assert.equal(target.start, at(9, 15));
    assert.equal(target.status, "PENDING_CHANGE");
    assert.equal(req.requestedBy, "INSTRUCTOR");
    s = approveRequest(s, me, req.id, ctx);
    assert.equal(slot(s, req.toSlotId).status, "CONFIRMED");
    assert.equal(s.slots.some((x) => x.id === "mine"), false);
    throwsCode(() => requestChangeToNewTime(seed(), me, "mine", { start: at(9, 15), end: at(9, 16) }, ctx), "FORBIDDEN");
    throwsCode(() => requestChangeToNewTime(seed(), teacher, "mine", { start: at(8, 10), end: at(8, 11) }, ctx), "OVERLAP");
  });

  it("planDrop 은 역할과 놓은 위치에 따라 처리 방식을 고른다", () => {
    const st = seed();
    assert.equal(planDrop(st, teacher, "open1", at(5, 10), NOW).kind, "none");
    assert.equal(planDrop(st, teacher, "open1", at(5, 14), NOW).kind, "move");
    assert.equal(planDrop(st, teacher, "open1", at(6, 10), NOW).kind, "invalid");
    assert.equal(planDrop(st, me, "open1", at(5, 14), NOW).kind, "invalid");

    // 빈 슬롯 위(30분 어긋나도)에 놓으면 그 슬롯으로 변경 요청
    const onSlot = planDrop(st, me, "mine", new Date(Date.UTC(2026, 0, 6, 10, 30)).toISOString(), NOW);
    assert.equal(onSlot.kind, "change");
    assert.ok(onSlot.kind === "change" && onSlot.toSlotId === "open2" && onSlot.start === at(6, 10));

    // 빈 시간: 레슨생은 불가, 강사는 새 시간 변경 요청
    assert.equal(planDrop(st, me, "mine", at(9, 15), NOW).kind, "invalid");
    assert.equal(planDrop(st, teacher, "mine", at(9, 15), NOW).kind, "change-new");
    assert.equal(planDrop(st, teacher, "mine", at(8, 10), NOW).kind, "invalid");
    // 남의 레슨, 지난 시간
    assert.equal(planDrop(st, me, "theirs", at(6, 10), NOW).kind, "invalid");
    assert.equal(planDrop(st, teacher, "open1", at(1, 0), at(3, 0)).kind, "invalid");
  });
});

describe("지난 시간 차단", () => {
  // 지금 = 1월 6일 12:00 (open1 = 1/5 지난 슬롯, open2 = 1/6 10:00 지난 슬롯, mine = 1/7 미래)
  const lateCtx = (): MachineContext => {
    let n = 0;
    return { now: () => at(6, 12), id: (p) => `${p}-${++n}` };
  };

  it("지난 시간에는 슬롯 열기·보강 신청·변경 대상 지정이 안 된다", () => {
    const ctx = lateCtx();
    throwsCode(() => createOpenSlot(seed(), teacher, { start: at(6, 9), end: at(6, 10) }, ctx), "INVALID_RANGE");
    throwsCode(() => requestBooking(seed(), me, "open1", ctx), "INVALID_STATE");
    throwsCode(() => requestChange(seed(), me, "mine", "open2", ctx), "INVALID_STATE");
  });

  it("이미 끝난 레슨은 변경 요청할 수 없다", () => {
    const ctx: MachineContext = { now: () => at(8, 0), id: (p) => `${p}-x` };
    const st = createOpenSlot(seed(), teacher, { start: at(9, 10), end: at(9, 11) }, ctx).state;
    const target = st.slots.find((x) => x.start === at(9, 10))!;
    throwsCode(() => requestChange(st, me, "mine", target.id, ctx), "INVALID_STATE");
    assert.equal(planDrop(st, me, "mine", at(9, 10), at(8, 0)).kind, "invalid");
  });

  it("레슨생 동의/승인 문구와 진행 기록 조사가 맞다", () => {
    const ctx = makeCtx();
    const s = requestChange(seed(), teacher, "mine", "open2", ctx);
    assert.ok(s.comments.some((c) => c.body.endsWith("레슨생 동의를 기다리는 중입니다.")));
    const s2 = requestChange(seed(), me, "mine", "open2", ctx);
    assert.ok(s2.comments.some((c) => c.body.endsWith("강사 승인을 기다리는 중입니다.")));
  });
});
