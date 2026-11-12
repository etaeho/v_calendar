import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Actor, LessonState } from "../types/calendar";
import {
  changeEnrollmentSchedule,
  changeImpact,
  countLessonsAfter,
  daysLeft,
  endEnrollment,
  extendEnrollment,
  lessonTimes,
  markHolidays,
  monthProgress,
  nextPaymentDate,
  planLabel,
  registerEnrollment,
  toDateKey,
  type EnrollmentInput,
  type HolidayLookup,
} from "./enrollment.ts";
import {
  adjustMakeup,
  approveRequest,
  cancelRequest,
  createOpenSlot,
  makeupSummary,
  proposeDefer,
  proposeHoliday,
  getSlotViews,
  LessonError,
  planDrop,
  requestBooking,
  requestChange,
  type MachineContext,
} from "./lesson-machine.ts";

const teacher: Actor = { userId: "t1", role: "INSTRUCTOR" };
const s1: Actor = { userId: "s1", role: "STUDENT" };
const s2: Actor = { userId: "s2", role: "STUDENT" };

/** 현지 시각 ISO */
const local = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).toISOString();
const NOW = local(2026, 11, 12, 9);

function makeCtx(now = NOW): MachineContext {
  let n = 0;
  return { now: () => now, id: (p) => `${p}-${++n}` };
}
/** 수강 등록은 10월에 한 것으로 (11월 지난 레슨 기록이 생기도록) */
const REG = local(2026, 10, 15, 9);
const regCtx = () => makeCtx(REG);
const noHoliday: HolidayLookup = () => undefined;
const christmas: HolidayLookup = (d) => (d.getMonth() === 11 && d.getDate() === 25 ? "크리스마스" : undefined);
const empty = (): LessonState => ({ enrollments: [], makeupAdjustments: [], slots: [], requests: [], comments: [] });
const days = (list: { start: Date }[]) => list.map((x) => toDateKey(x.start));
const throwsCode = (fn: () => unknown, code: string) =>
  assert.throws(fn, (e) => e instanceof LessonError && e.code === code);

const tue19 = { weekday: 2, time: "19:00", durationMin: 60 };
const fri16 = { weekday: 5, time: "16:00", durationMin: 60 };
const sat13 = { weekday: 6, time: "13:00", durationMin: 60 };
const weekly = [1, 2, 3, 4];

const input = (over: Partial<EnrollmentInput> = {}): EnrollmentInput => ({
  studentId: "s1",
  startDate: "2026-11-01",
  endDate: "2026-12-31",
  times: [tue19],
  weeks: weekly,
  changeDeadlineHours: 24,
  ...over,
});

describe("레슨 날짜 생성", () => {
  it("월 4회: 매주 진행하되 그 요일의 5번째 날은 쉰다", () => {
    const plan = { times: [tue19], weeks: weekly };
    assert.deepEqual(days(lessonTimes(plan, "2026-11-01", "2026-11-30")), [
      "2026-11-03",
      "2026-11-10",
      "2026-11-17",
      "2026-11-24",
    ]);
    // 12월은 화요일이 5번 (29일은 쉼)
    assert.deepEqual(days(lessonTimes(plan, "2026-12-01", "2026-12-31")), [
      "2026-12-01",
      "2026-12-08",
      "2026-12-15",
      "2026-12-22",
    ]);
    assert.equal(planLabel(plan), "주 1회 · 월 4회");
  });

  it("월 2회(격주)와 월 8회(주 2회)", () => {
    const biweekly = { times: [fri16], weeks: [2, 4] };
    assert.deepEqual(days(lessonTimes(biweekly, "2026-12-01", "2026-12-31")), ["2026-12-11", "2026-12-25"]);
    assert.equal(planLabel(biweekly), "격주 (2·4주) · 월 2회");

    const twice = { times: [tue19, sat13], weeks: weekly };
    const dec = lessonTimes(twice, "2026-12-01", "2026-12-31");
    assert.equal(dec.length, 8);
    assert.equal(planLabel(twice), "주 2회 · 월 8회");
    assert.equal(dec[0].start.getHours(), 19);
    assert.equal(dec[1].start.getHours(), 13);
  });

  it("기간 경계를 지킨다", () => {
    const plan = { times: [tue19], weeks: weekly };
    assert.deepEqual(days(lessonTimes(plan, "2026-11-10", "2026-11-17")), ["2026-11-10", "2026-11-17"]);
  });
});

describe("수강 등록", () => {
  it("기간 전체의 정규 레슨을 만들고 회차를 매긴다", () => {
    const { state, created, conflicts } = registerEnrollment(empty(), teacher, input(), regCtx(), noHoliday);
    assert.equal(created, 8);
    assert.equal(conflicts.length, 0);
    assert.ok(state.slots.every((s) => s.status === "CONFIRMED" && s.lessonType === "REGULAR" && s.enrollmentId));
    const views = getSlotViews(state, s1).filter((v) => new Date(v.slot.start).getMonth() === 10);
    assert.deepEqual(views.map((v) => v.seq), [1, 2, 3, 4].map((n) => ({ n, total: 4 })));
    assert.deepEqual(monthProgress(state, state.enrollments[0], NOW), { total: 4, done: 2, skipped: 0 });
    throwsCode(() => registerEnrollment(empty(), s1, input(), regCtx(), noHoliday), "FORBIDDEN");
    throwsCode(() => registerEnrollment(state, teacher, input({ startDate: "2026-12-15", endDate: "2027-02-28" }), regCtx(), noHoliday), "OVERLAP");
    throwsCode(() => registerEnrollment(empty(), teacher, input({ times: [] }), regCtx(), noHoliday), "INVALID_RANGE");
  });

  it("겹치는 빈 슬롯은 레슨으로 대체하고, 다른 레슨과 겹치면 만들지 않고 알려 준다", () => {
    const ctx = makeCtx();
    let st = createOpenSlot(empty(), teacher, { start: local(2026, 11, 17, 19), end: local(2026, 11, 17, 20) }, ctx).state;
    st = createOpenSlot(st, teacher, { start: local(2026, 11, 24, 19, 30), end: local(2026, 11, 24, 20, 30) }, ctx).state;
    const booked = st.slots[1].id;
    st = approveRequest(requestBooking(st, s2, booked, ctx), teacher, "req-5", ctx);
    const r = registerEnrollment(st, teacher, input({ endDate: "2026-11-30" }), regCtx(), noHoliday);
    assert.equal(r.created, 3);
    assert.deepEqual(r.conflicts.map((c) => c.start), [local(2026, 11, 24, 19)]);
    assert.equal(r.state.slots.filter((s) => s.status === "OPEN").length, 0);
  });

  it("미래의 공휴일 레슨은 '결정 필요'로 만든다", () => {
    const r = registerEnrollment(empty(), teacher, input({ studentId: "s4", times: [fri16], weeks: [2, 4] }), regCtx(), christmas);
    const xmas = r.state.slots.find((s) => s.holidayName)!;
    assert.equal(toDateKey(new Date(xmas.start)), "2026-12-25");
    assert.equal(xmas.holidayDecision, "UNDECIDED");
    assert.equal(getSlotViews(r.state, teacher).find((v) => v.slot.id === xmas.id)!.display, "HOLIDAY_DECISION");

    // 나중에 지정된 공휴일도 표시된다
    const plain = registerEnrollment(empty(), teacher, input({ times: [fri16] }), regCtx(), noHoliday).state;
    const marked = markHolidays(plain, christmas, NOW);
    assert.equal(marked.slots.filter((s) => s.holidayDecision === "UNDECIDED").length, 1);
    assert.equal(markHolidays(marked, christmas, NOW), marked);
  });
});

describe("연장 · 종료 · 고정 시간 변경", () => {
  it("연장하면 늘어난 기간만큼 레슨이 추가된다", () => {
    const ctx = makeCtx();
    const base = registerEnrollment(empty(), teacher, input({ endDate: "2026-11-30" }), regCtx(), noHoliday).state;
    const id = base.enrollments[0].id;
    const r = extendEnrollment(base, teacher, id, "2026-12-31", ctx, noHoliday);
    assert.equal(r.created, 4);
    assert.equal(r.state.enrollments[0].endDate, "2026-12-31");
    assert.equal(r.state.slots.length, 8);
    throwsCode(() => extendEnrollment(base, teacher, id, "2026-11-15", ctx, noHoliday), "INVALID_RANGE");
  });

  it("이번 달까지로 종료하면 이후 레슨과 걸려 있던 요청이 정리된다", () => {
    const ctx = makeCtx();
    let st = registerEnrollment(empty(), teacher, input(), regCtx(), noHoliday).state;
    const id = st.enrollments[0].id;
    // 12월 레슨을 12월 빈 슬롯으로 옮기려는 요청 + 11월 레슨을 12월로 옮기려는 요청
    st = createOpenSlot(st, teacher, { start: local(2026, 12, 3, 19), end: local(2026, 12, 3, 20) }, ctx).state;
    st = createOpenSlot(st, teacher, { start: local(2026, 12, 4, 19), end: local(2026, 12, 4, 20) }, ctx).state;
    const [openA, openB] = st.slots.filter((s) => s.status === "OPEN").map((s) => s.id);
    const dec1 = st.slots.find((s) => s.start === local(2026, 12, 1, 19))!.id;
    const nov24 = st.slots.find((s) => s.start === local(2026, 11, 24, 19))!.id;
    st = requestChange(st, s1, dec1, openA, ctx);
    st = requestChange(st, s1, nov24, openB, ctx);

    // 12월 정규 레슨 4건만 삭제 대상 (변경 희망 시간은 강사의 빈 슬롯이라 다시 열림)
    assert.equal(countLessonsAfter(st, id, "2026-11-30", NOW), 4);
    const r = endEnrollment(st, teacher, id, "2026-11-30", ctx);
    assert.equal(r.state.enrollments[0].endDate, "2026-11-30");
    assert.ok(r.state.requests.every((q) => q.status === "CANCELLED"));
    // 11월 레슨 4개는 남고(24일은 다시 확정), 12월 레슨은 사라지고 변경 희망 시간은 빈 슬롯으로 돌아간다
    const mine = r.state.slots.filter((s) => s.studentId === "s1");
    assert.equal(mine.length, 4);
    assert.ok(mine.every((s) => s.status === "CONFIRMED" && !s.requestId));
    const dec = r.state.slots.filter((s) => new Date(s.start).getMonth() === 11);
    assert.deepEqual(dec.map((s) => s.status), ["OPEN", "OPEN"]);
    // 지난 날짜로는 종료할 수 없다
    throwsCode(() => endEnrollment(st, teacher, id, "2026-11-05", ctx), "INVALID_RANGE");
    throwsCode(() => endEnrollment(st, teacher, id, "2027-01-31", ctx), "INVALID_RANGE");
    throwsCode(() => endEnrollment(st, s1, id, "2026-11-30", ctx), "FORBIDDEN");
  });

  it("고정 시간을 적용 시작일부터 바꾼다", () => {
    const ctx = makeCtx();
    const base = registerEnrollment(empty(), teacher, input(), regCtx(), noHoliday).state;
    const id = base.enrollments[0].id;
    const r = changeEnrollmentSchedule(base, teacher, id, { times: [sat13], weeks: weekly }, "2026-12-01", ctx, noHoliday);
    const nov = r.state.slots.filter((s) => new Date(s.start).getMonth() === 10);
    const dec = r.state.slots.filter((s) => new Date(s.start).getMonth() === 11);
    assert.ok(nov.every((s) => new Date(s.start).getDay() === 2));
    assert.equal(dec.length, 4);
    assert.ok(dec.every((s) => new Date(s.start).getDay() === 6 && new Date(s.start).getHours() === 13));
    throwsCode(() => changeEnrollmentSchedule(base, teacher, id, { times: [sat13], weeks: weekly }, "2026-11-01", ctx, noHoliday), "INVALID_RANGE");
  });
});

describe("등록 조건에 따른 일정 변경 제한", () => {
  const setup = (hours: number) => {
    const ctx = makeCtx();
    let st = registerEnrollment(empty(), teacher, input({ changeDeadlineHours: hours }), regCtx(), noHoliday).state;
    st = createOpenSlot(st, teacher, { start: local(2026, 11, 20, 19), end: local(2026, 11, 20, 20) }, ctx).state;
    st = createOpenSlot(st, teacher, { start: local(2026, 12, 3, 19), end: local(2026, 12, 3, 20) }, ctx).state;
    st = createOpenSlot(st, teacher, { start: local(2027, 1, 5, 19), end: local(2027, 1, 5, 20) }, ctx).state;
    const [near, dec, afterEnd] = st.slots.filter((s) => s.status === "OPEN").map((s) => s.id);
    const lesson = (m: number, d: number) => st.slots.find((s) => s.start === local(2026, m, d, 19))!;
    return { st, near, dec, afterEnd, lesson };
  };

  it("레슨생은 합의한 마감 시간 이후에는 변경을 요청할 수 없다 (강사는 가능)", () => {
    const { st, near, lesson } = setup(24);
    const late = makeCtx(local(2026, 11, 16, 20)); // 11/17 19:00 레슨 23시간 전
    throwsCode(() => requestChange(st, s1, lesson(11, 17).id, near, late), "INVALID_STATE");
    assert.equal(planDrop(st, s1, lesson(11, 17).id, local(2026, 11, 20, 19), late.now()).kind, "invalid");
    assert.equal(requestChange(st, teacher, lesson(11, 17).id, near, late).requests.length, 1);
    const early = makeCtx(local(2026, 11, 16, 18));
    assert.equal(requestChange(st, s1, lesson(11, 17).id, near, early).requests.length, 1);
    // 마감 0 = 제한 없음
    const free = setup(0);
    assert.equal(requestChange(free.st, s1, free.lesson(11, 17).id, free.near, late).requests.length, 1);
  });

  it("등록 종료일 이후로는 옮길 수 없고, 다른 달로 옮기면 월별 횟수 변화를 알려 준다", () => {
    const { st, near, dec, afterEnd, lesson } = setup(24);
    const ctx = makeCtx();
    throwsCode(() => requestChange(st, s1, lesson(11, 24).id, afterEnd, ctx), "INVALID_STATE");
    throwsCode(() => requestChange(st, teacher, lesson(11, 24).id, afterEnd, ctx), "INVALID_STATE");
    assert.equal(planDrop(st, teacher, lesson(11, 24).id, local(2027, 1, 5, 19), NOW).kind, "invalid");

    assert.equal(changeImpact(st, lesson(11, 24), st.slots.find((s) => s.id === near)!.start), undefined);
    assert.deepEqual(changeImpact(st, lesson(11, 24), st.slots.find((s) => s.id === dec)!.start), {
      fromMonth: 11,
      fromCount: 3,
      toMonth: 12,
      toCount: 5,
    });
    // 승인 후에도 등록 정보와 회차가 새 슬롯에 이어진다
    let moved = requestChange(st, s1, lesson(11, 24).id, dec, ctx);
    moved = approveRequest(moved, teacher, moved.requests[0].id, ctx);
    const target = moved.slots.find((s) => s.id === dec)!;
    assert.equal(target.enrollmentId, st.enrollments[0].id);
    assert.deepEqual(getSlotViews(moved, s1).find((v) => v.slot.id === dec)!.seq, { n: 2, total: 5 });
  });
});

describe("표시용 계산", () => {
  it("남은 기간과 다음 결제 예정일", () => {
    const e = { id: "e", ...input({ endDate: "2026-11-30", paymentDay: 25, fee: 200000 }) };
    assert.equal(daysLeft(e, NOW), 18);
    assert.equal(toDateKey(nextPaymentDate(e, NOW)!), "2026-11-25");
    assert.equal(nextPaymentDate(e, local(2026, 11, 26, 9)), undefined);
    const longer = { ...e, endDate: "2027-02-28", paymentDay: 31 };
    assert.equal(toDateKey(nextPaymentDate(longer, local(2026, 12, 1, 9))!), "2026-12-31");
    assert.equal(toDateKey(nextPaymentDate(longer, local(2027, 2, 1, 9))!), "2027-02-28");
    assert.equal(nextPaymentDate({ ...e, paymentDay: undefined }, NOW), undefined);
  });
});

describe("보강 관리", () => {
  it("공휴일 휴강 · 보강으로 미룸 · 미배정 · 강사 조정이 보강 필요로 집계된다", () => {
    const ctx = makeCtx();
    // 11/24 화요일 19:00 은 다른 레슨생 보강이 이미 있어 미배정
    let st = createOpenSlot(empty(), teacher, { start: local(2026, 11, 24, 19), end: local(2026, 11, 24, 20) }, ctx).state;
    st = approveRequest(requestBooking(st, s2, st.slots[0].id, ctx), teacher, "req-3", ctx);
    st = registerEnrollment(st, teacher, input(), regCtx(), christmas).state;
    const miss = st.slots.find((s) => s.status === "SKIPPED" && s.skipReason === "CONFLICT")!;
    assert.equal(miss.start, local(2026, 11, 24, 19));
    assert.equal(getSlotViews(st, s2).some((v) => v.slot.id === miss.id), false);
    assert.equal(makeupSummary(st, "s1", NOW).owed, 1);

    // 보강으로 미루기: 레슨생 요청 → 강사 동의
    const dec8 = st.slots.find((s) => s.start === local(2026, 12, 8, 19))!.id;
    st = proposeDefer(st, s1, dec8, ctx, "학교 행사");
    assert.equal(getSlotViews(st, s1).find((v) => v.slot.id === dec8)!.display, "PENDING_DEFER");
    throwsCode(() => approveRequest(st, s1, st.requests.at(-1)!.id, ctx), "FORBIDDEN");
    st = approveRequest(st, teacher, st.requests.at(-1)!.id, ctx);
    assert.equal(st.slots.find((s) => s.id === dec8)!.skipReason, "DEFERRED");

    // 강사 조정 +1 (결석), 보강 레슨 1회 확정 → 남은 보강 = 3 - 1
    st = adjustMakeup(st, teacher, "s1", 1, "11/10 결석", ctx);
    throwsCode(() => adjustMakeup(st, s1, "s1", 1, "x", ctx), "FORBIDDEN");
    throwsCode(() => adjustMakeup(st, teacher, "s1", 1, "  ", ctx), "INVALID_RANGE");
    st = createOpenSlot(st, teacher, { start: local(2026, 11, 20, 15), end: local(2026, 11, 20, 16) }, ctx).state;
    const open = st.slots.find((s) => s.status === "OPEN")!.id;
    st = requestBooking(st, s1, open, ctx);
    assert.equal(makeupSummary(st, "s1", NOW).requested, 1);
    st = approveRequest(st, teacher, st.requests.at(-1)!.id, ctx);
    const sum = makeupSummary(st, "s1", NOW);
    assert.deepEqual(
      { owed: sum.owed, done: sum.done, scheduled: sum.scheduled, requested: sum.requested, remaining: sum.remaining },
      { owed: 3, done: 0, scheduled: 1, requested: 0, remaining: 2 },
    );
    assert.deepEqual(sum.entries.map((e) => e.label), ["보강으로 미룸", "일정 겹침 · 미배정", "강사 조정 · 11/10 결석"]);
    // 레슨 시간이 지나면 완료로 바뀐다
    assert.equal(makeupSummary(st, "s1", local(2026, 11, 21, 9)).done, 1);
  });

  it("공휴일 휴강도 보강 필요가 되고, 미루기 요청은 취소·마감 규칙을 따른다", () => {
    const ctx = makeCtx();
    let st = registerEnrollment(
      empty(),
      teacher,
      input({ studentId: "s4", times: [fri16], weeks: [2, 4], changeDeadlineHours: 48 }),
      regCtx(),
      christmas,
    ).state;
    const xmas = st.slots.find((s) => s.holidayDecision === "UNDECIDED")!.id;
    st = proposeHoliday(st, teacher, xmas, "SKIP", ctx);
    st = approveRequest(st, { userId: "s4", role: "STUDENT" }, st.requests[0].id, ctx);
    assert.equal(makeupSummary(st, "s4", NOW).owed, 1);
    assert.equal(makeupSummary(st, "s4", NOW).entries[0].label, "공휴일 휴강 (크리스마스)");

    const s4: Actor = { userId: "s4", role: "STUDENT" };
    const next = st.slots.find((s) => s.start === local(2026, 11, 27, 16))!.id;
    let d = proposeDefer(st, teacher, next, ctx);
    throwsCode(() => proposeDefer(d, teacher, next, ctx), "INVALID_STATE");
    d = cancelRequest(d, teacher, d.requests.at(-1)!.id, ctx);
    assert.equal(d.slots.find((s) => s.id === next)!.status, "CONFIRMED");
    // 48시간 마감: 11/26 09:00 기준 11/27 16:00 은 31시간 전 → 레슨생은 불가, 강사는 가능
    const late = makeCtx(local(2026, 11, 26, 9));
    throwsCode(() => proposeDefer(st, s4, next, late), "INVALID_STATE");
    assert.equal(proposeDefer(st, teacher, next, late).requests.at(-1)!.kind, "DEFER");
  });
});

describe("QA 수정 사항", () => {
  it("이전 등록을 끝내도 다음 기간 등록의 레슨은 그대로 남는다", () => {
    let st = registerEnrollment(empty(), teacher, input({ endDate: "2026-11-30" }), regCtx(), noHoliday).state;
    const oldId = st.enrollments[0].id;
    const second: MachineContext = { now: () => NOW, id: (p) => `next-${p}` };
    st = registerEnrollment(st, teacher, input({ startDate: "2026-12-01", endDate: "2027-02-28" }), second, noHoliday).state;
    const ctx = makeCtx(local(2026, 11, 17, 9));
    const before = st.slots.filter((s) => s.start > local(2026, 11, 17, 23)).length;
    const r = endEnrollment(st, teacher, oldId, "2026-11-17", ctx);
    assert.equal(r.removed, 1); // 11/24 하나만
    assert.equal(r.state.slots.filter((s) => s.start > local(2026, 11, 17, 23)).length, before - 1);
  });

  it("종료할 때 걸려 있던 보강 신청의 빈 슬롯은 다시 열린다", () => {
    const ctx = makeCtx();
    let st = registerEnrollment(empty(), teacher, input(), regCtx(), noHoliday).state;
    st = createOpenSlot(st, teacher, { start: local(2026, 11, 19, 15), end: local(2026, 11, 19, 16) }, ctx).state;
    const open = st.slots.find((s) => s.status === "OPEN")!.id;
    st = requestBooking(st, s1, open, ctx);
    // 11/17·24, 12월 4건 = 6건 (보강 신청 걸린 빈 슬롯은 삭제가 아니라 다시 열림)
    assert.equal(countLessonsAfter(st, st.enrollments[0].id, "2026-11-12", NOW), 6);
    const r = endEnrollment(st, teacher, st.enrollments[0].id, "2026-11-12", ctx);
    assert.equal(r.state.slots.find((s) => s.id === open)!.status, "OPEN");
    assert.equal(r.state.requests.at(-1)!.status, "CANCELLED");
  });

  it("고정 시간을 바꿔도 이미 정한 보강(미룸·휴강) 기록은 남는다", () => {
    const ctx = makeCtx();
    let st = registerEnrollment(empty(), teacher, input(), regCtx(), noHoliday).state;
    const dec8 = st.slots.find((s) => s.start === local(2026, 12, 8, 19))!.id;
    st = proposeDefer(st, s1, dec8, ctx);
    st = approveRequest(st, teacher, st.requests.at(-1)!.id, ctx);
    assert.equal(makeupSummary(st, "s1", NOW).owed, 1);
    // 같은 시각을 유지하는 변경(진행 주차만 변경)에서도 중복 레슨이 생기지 않는다
    const id = st.enrollments[0].id;
    const r = changeEnrollmentSchedule(st, teacher, id, { times: [tue19], weeks: [1, 2, 3, 4, 5] }, "2026-12-01", ctx, noHoliday);
    assert.equal(makeupSummary(r.state, "s1", NOW).owed, 1);
    assert.equal(new Set(r.state.slots.map((s) => s.id)).size, r.state.slots.length);
    assert.equal(r.state.slots.filter((s) => s.start === local(2026, 12, 8, 19)).length, 1);
    assert.ok(r.state.slots.some((s) => s.start === local(2026, 12, 29, 19)));
  });

  it("보강 레슨에도 변경 마감과 등록 종료일이 적용된다", () => {
    const ctx = makeCtx();
    let st = registerEnrollment(empty(), teacher, input({ endDate: "2026-11-30", changeDeadlineHours: 48 }), regCtx(), noHoliday).state;
    st = createOpenSlot(st, teacher, { start: local(2026, 11, 13, 17), end: local(2026, 11, 13, 18) }, ctx).state;
    st = createOpenSlot(st, teacher, { start: local(2026, 11, 20, 17), end: local(2026, 11, 20, 18) }, ctx).state;
    st = createOpenSlot(st, teacher, { start: local(2026, 12, 2, 17), end: local(2026, 12, 2, 18) }, ctx).state;
    const [mk, nov20, dec2] = st.slots.filter((s) => s.status === "OPEN").map((s) => s.id);
    st = approveRequest(requestBooking(st, s1, mk, ctx), teacher, st.requests.length ? "x" : "req-7", ctx);
    assert.equal(st.slots.find((s) => s.id === mk)!.status, "CONFIRMED");
    // 11/12 09:00 → 11/13 17:00 은 32시간 전: 레슨생은 마감(48h) 지남
    throwsCode(() => requestChange(st, s1, mk, nov20, ctx), "INVALID_STATE");
    // 강사도 등록 종료일(11/30) 이후로는 못 옮긴다
    throwsCode(() => requestChange(st, teacher, mk, dec2, ctx), "INVALID_STATE");
    assert.equal(requestChange(st, teacher, mk, nov20, ctx).requests.at(-1)!.kind, "CHANGE");
  });

  it("보강 −1 은 0 아래로 내려가지 않고, 시작일은 오늘 이후여야 한다", () => {
    const ctx = makeCtx();
    throwsCode(() => adjustMakeup(empty(), teacher, "s1", -1, "정리", ctx), "INVALID_RANGE");
    throwsCode(() => registerEnrollment(empty(), teacher, input({ startDate: "2026-11-06" }), ctx, noHoliday), "INVALID_RANGE");
    // 오늘 시작이면 이미 지난 시간의 레슨은 만들지 않는다
    const r = registerEnrollment(empty(), teacher, input({ startDate: "2026-11-12", endDate: "2026-11-30" }), makeCtx(local(2026, 11, 12, 20)), noHoliday);
    assert.equal(r.created, 2);
  });
});
