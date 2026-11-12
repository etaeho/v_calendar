/**
 * 수강 등록(Enrollment) 로직 — 순수 함수.
 *
 * 등록하면 기간 전체의 정규 레슨이 같은 요일·시간에 생성된다.
 *  - 진행 주차(weeks): 그 달에서 해당 요일의 n번째 날만 진행 (5번째는 쉼)
 *  - 연장: 늘어난 기간만큼 레슨 추가
 *  - 종료: 종료일 이후의 레슨 삭제 + 걸려 있던 요청 취소
 *  - 고정 시간 변경: 적용 시작일 이후의 레슨을 새 시간으로 다시 생성
 * 날짜는 모두 현지 시간 기준이다.
 */
import type {
  Actor,
  Enrollment,
  LessonSlot,
  LessonState,
  WeeklyTime,
} from "../types/calendar";
import { enrollmentEndMs, LessonError, overlaps, type MachineContext } from "./lesson-machine.ts";

const pad = (n: number) => String(n).padStart(2, "0");
export const toDateKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseDate = (key: string) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const endOfDateMs = (key: string) => {
  const d = parseDate(key);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
};

/** 공휴일 조회 (쉬는 날이면 이름) — 데이터 소스와 분리하기 위해 주입한다 */
export type HolidayLookup = (day: Date) => string | undefined;

export interface EnrollmentInput {
  studentId: string;
  startDate: string;
  endDate: string;
  times: WeeklyTime[];
  weeks: number[];
  changeDeadlineHours: number;
  fee?: number;
  paymentDay?: number;
}

export interface GenerationConflict {
  start: string;
  end: string;
}

/** 등록 기간 [fromKey, toKey] 안의 레슨 시각 (시작순) */
export function lessonTimes(
  plan: Pick<Enrollment, "times" | "weeks">,
  fromKey: string,
  toKey: string,
): { start: Date; end: Date }[] {
  const out: { start: Date; end: Date }[] = [];
  const last = parseDate(toKey);
  for (const day = parseDate(fromKey); day <= last; day.setDate(day.getDate() + 1)) {
    // 그 달에서 이 요일의 몇 번째 날인가 (1~5)
    const nth = Math.ceil(day.getDate() / 7);
    if (!plan.weeks.includes(nth)) continue;
    for (const t of plan.times) {
      if (t.weekday !== day.getDay()) continue;
      const [h, m] = t.time.split(":").map(Number);
      const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
      out.push({ start, end: new Date(start.getTime() + t.durationMin * 60_000) });
    }
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}

function validate(input: Pick<EnrollmentInput, "startDate" | "endDate" | "times" | "weeks">) {
  if (!(input.startDate <= input.endDate))
    throw new LessonError("INVALID_RANGE", "종료일이 시작일보다 빠릅니다.");
  if (input.times.length === 0)
    throw new LessonError("INVALID_RANGE", "고정 레슨 시간을 하나 이상 정해 주세요.");
  if (input.weeks.length === 0 || input.weeks.some((w) => w < 1 || w > 5))
    throw new LessonError("INVALID_RANGE", "진행 주차를 확인해 주세요.");
  if (input.times.some((t) => !/^\d{2}:\d{2}$/.test(t.time) || t.durationMin < 15))
    throw new LessonError("INVALID_RANGE", "레슨 시간을 확인해 주세요.");
}

const requireInstructor = (actor: Actor) => {
  if (actor.role !== "INSTRUCTOR")
    throw new LessonError("FORBIDDEN", "수강 등록은 강사만 관리할 수 있습니다.");
};

const findEnrollment = (state: LessonState, id: string): Enrollment => {
  const e = state.enrollments.find((x) => x.id === id);
  if (!e) throw new LessonError("NOT_FOUND", "수강 등록을 찾을 수 없습니다.");
  return e;
};

/**
 * 기간 [fromKey, toKey] 의 정규 레슨을 만든다.
 * 겹치는 빈 슬롯(OPEN)은 레슨으로 대체하고, 다른 레슨과 겹치는 날은 만들지 않고 conflicts 로 돌려준다.
 */
function generate(
  state: LessonState,
  enrollment: Enrollment,
  fromKey: string,
  toKey: string,
  holiday: HolidayLookup,
  now: string,
): { state: LessonState; created: number; conflicts: GenerationConflict[] } {
  let slots = state.slots;
  let comments = state.comments;
  const conflicts: GenerationConflict[] = [];
  let created = 0;
  for (const { start, end } of lessonTimes(enrollment, fromKey, toKey)) {
    const s = start.toISOString();
    const e = end.toISOString();
    // 이미 지난 시간은 만들지 않는다
    if (Date.parse(s) < Date.parse(now)) continue;
    const key = `${enrollment.id}-${toDateKey(start).replaceAll("-", "")}-${pad(start.getHours())}${pad(start.getMinutes())}`;
    // 같은 시각에 남아 있는 기록(보강으로 미룸 등)이 있으면 다시 만들지 않는다
    if (slots.some((x) => x.id === `les-${key}` || x.id === `miss-${key}`)) continue;
    const hits = slots.filter((x) => x.status !== "SKIPPED" && overlaps(x.start, x.end, s, e));
    if (hits.some((x) => x.status !== "OPEN")) {
      conflicts.push({ start: s, end: e });
      // 시간을 못 잡은 정규 레슨은 '미배정' 기록으로 남겨 보강 필요 횟수에 들어가게 한다
      const missId = `miss-${key}`;
      slots = [
        ...slots,
        {
          id: missId,
          start: s,
          end: e,
          status: "SKIPPED",
          skipReason: "CONFLICT",
          studentId: enrollment.studentId,
          lessonType: "REGULAR",
          enrollmentId: enrollment.id,
          threadId: `t-${missId}`,
        },
      ];
      continue;
    }
    if (hits.length > 0) {
      const gone = new Set(hits.map((x) => x.id));
      const threads = new Set(hits.map((x) => x.threadId));
      slots = slots.filter((x) => !gone.has(x.id));
      comments = comments.filter((c) => !threads.has(c.threadId));
    }
    const id = `les-${key}`;
    const holidayName = Date.parse(s) >= Date.parse(now) ? holiday(start) : undefined;
    const lesson: LessonSlot = {
      id,
      start: s,
      end: e,
      status: "CONFIRMED",
      studentId: enrollment.studentId,
      lessonType: "REGULAR",
      enrollmentId: enrollment.id,
      threadId: `t-${id}`,
      ...(holidayName ? { holidayName, holidayDecision: "UNDECIDED" as const } : {}),
    };
    slots = [...slots, lesson];
    created++;
  }
  return { state: { ...state, slots, comments }, created, conflicts };
}

/** 레슨생의 진행 중(오늘 기준 종료 전) 등록 */
export const activeEnrollments = (state: LessonState, studentId: string, now: string) =>
  state.enrollments.filter((e) => e.studentId === studentId && endOfDateMs(e.endDate) >= Date.parse(now));

export function registerEnrollment(
  state: LessonState,
  actor: Actor,
  input: EnrollmentInput,
  ctx: MachineContext,
  holiday: HolidayLookup,
): { state: LessonState; enrollment: Enrollment; created: number; conflicts: GenerationConflict[] } {
  requireInstructor(actor);
  validate(input);
  if (endOfDateMs(input.startDate) < Date.parse(ctx.now()))
    throw new LessonError("INVALID_RANGE", "시작일은 오늘 이후여야 합니다.");
  if (
    state.enrollments.some(
      (e) =>
        e.studentId === input.studentId &&
        e.startDate <= input.endDate &&
        input.startDate <= e.endDate,
    )
  )
    throw new LessonError("OVERLAP", "같은 기간에 이미 수강 등록이 있습니다. 기존 등록을 수정하거나 연장해 주세요.");

  const enrollment: Enrollment = { id: ctx.id("enr"), ...input };
  const base = { ...state, enrollments: [...state.enrollments, enrollment] };
  const result = generate(base, enrollment, input.startDate, input.endDate, holiday, ctx.now());
  return { ...result, enrollment };
}

/** 합의 조건(변경 마감, 수강료, 결제 예정일)만 수정한다 */
export function updateEnrollmentTerms(
  state: LessonState,
  actor: Actor,
  id: string,
  terms: Pick<Enrollment, "changeDeadlineHours" | "fee" | "paymentDay">,
): LessonState {
  requireInstructor(actor);
  const current = findEnrollment(state, id);
  if (terms.changeDeadlineHours < 0)
    throw new LessonError("INVALID_RANGE", "변경 마감 시간을 확인해 주세요.");
  if (terms.paymentDay !== undefined && (terms.paymentDay < 1 || terms.paymentDay > 31))
    throw new LessonError("INVALID_RANGE", "결제 예정일은 1~31일 사이여야 합니다.");
  return {
    ...state,
    enrollments: state.enrollments.map((e) => (e.id === id ? { ...current, ...terms } : e)),
  };
}

/** 등록 기간을 newEndDate 까지 늘리고 그만큼 레슨을 추가한다 */
export function extendEnrollment(
  state: LessonState,
  actor: Actor,
  id: string,
  newEndDate: string,
  ctx: MachineContext,
  holiday: HolidayLookup,
): { state: LessonState; created: number; conflicts: GenerationConflict[] } {
  requireInstructor(actor);
  const current = findEnrollment(state, id);
  if (!(newEndDate > current.endDate))
    throw new LessonError("INVALID_RANGE", "새 종료일은 현재 종료일보다 뒤여야 합니다.");
  const next: Enrollment = { ...current, endDate: newEndDate };
  const from = parseDate(current.endDate);
  from.setDate(from.getDate() + 1);
  const base = { ...state, enrollments: state.enrollments.map((e) => (e.id === id ? next : e)) };
  return generate(base, next, toDateKey(from), newEndDate, holiday, ctx.now());
}

/**
 * 등록을 줄일 때 정리할 대상을 계산한다.
 * - 이 등록의 정규 레슨(옮겨 온 레슨 포함) 중 경계 이후에 시작하는 것
 * - 보강 레슨은 같은 레슨생의 다른 등록 기간에 들어가지 않을 때만
 * - keepSkipped: 고정 시간 변경처럼 등록이 계속될 때는 '보강으로 미룸'·'공휴일 휴강' 기록을 남긴다
 * 걸려 있던 대기 요청은 취소하고, 강사가 열어 둔 빈 슬롯(보강 신청·변경 희망 대상)은 다시 빈 슬롯으로 돌린다.
 * 경계는 지금보다 앞설 수 없다 (지난 레슨 기록은 지우지 않는다).
 */
function plan(
  state: LessonState,
  enrollment: Enrollment,
  boundaryMs: number,
  ctx: MachineContext,
  keepSkipped: boolean,
) {
  const boundary = Math.max(boundaryMs, Date.parse(ctx.now()));
  const others = state.enrollments.filter((e) => e.studentId === enrollment.studentId && e.id !== enrollment.id);
  const coveredByOther = (iso: string) => {
    const t = Date.parse(iso);
    return others.some((e) => new Date(`${e.startDate}T00:00:00`).getTime() <= t && t <= enrollmentEndMs(e));
  };
  const affected = state.slots.filter((s) => {
    if (s.studentId !== enrollment.studentId || s.status === "OPEN" || Date.parse(s.start) <= boundary) return false;
    if (keepSkipped && s.status === "SKIPPED" && s.skipReason !== "CONFLICT") return false;
    if (s.enrollmentId === enrollment.id) return true;
    return !s.enrollmentId && s.lessonType === "MAKEUP" && !coveredByOther(s.start);
  });
  const affectedIds = new Set(affected.map((s) => s.id));
  const touched = state.requests.filter(
    (r) => r.status === "PENDING" && (affectedIds.has(r.toSlotId) || affectedIds.has(r.fromSlotId ?? "")),
  );
  // 보강 신청 대상·변경 희망 시간은 강사가 열어 둔 빈 슬롯이었으므로 다시 연다
  const reopen = new Set(
    touched.filter((r) => r.kind === "BOOKING" || r.kind === "CHANGE").map((r) => r.toSlotId),
  );
  const doomed = new Set([...affectedIds].filter((id) => !reopen.has(id)));
  return { touched, reopen, doomed, affected };
}

/** 종료 시 삭제될 레슨 수 (확인 화면용) */
export function countLessonsAfter(state: LessonState, id: string, endDate: string, now: string): number {
  const enrollment = state.enrollments.find((e) => e.id === id);
  if (!enrollment) return 0;
  const ctx = { now: () => now, id: () => "" };
  const { doomed } = plan(state, enrollment, endOfDateMs(endDate), ctx, false);
  return state.slots.filter((s) => doomed.has(s.id) && s.status !== "SKIPPED").length;
}

function removeAfter(
  state: LessonState,
  enrollment: Enrollment,
  boundaryMs: number,
  ctx: MachineContext,
  keepSkipped: boolean,
): { state: LessonState; removed: number } {
  const { touched, reopen, doomed } = plan(state, enrollment, boundaryMs, ctx, keepSkipped);
  const touchedIds = new Set(touched.map((r) => r.id));
  const slots = state.slots
    .filter((s) => !doomed.has(s.id))
    .map((s): LessonSlot => {
      if (reopen.has(s.id)) return { id: s.id, start: s.start, end: s.end, status: "OPEN", threadId: ctx.id("t") };
      // 경계 이전에 남는 쪽(변경 요청의 기존 레슨 등)은 원래 상태로
      if (s.requestId && touchedIds.has(s.requestId)) {
        return { ...s, status: s.status === "PENDING_CHANGE" ? "CONFIRMED" : s.status, requestId: undefined };
      }
      return s;
    });
  const removedThreads = new Set(state.slots.filter((s) => doomed.has(s.id) || reopen.has(s.id)).map((s) => s.threadId));
  const liveThreads = new Set(slots.map((s) => s.threadId));
  return {
    state: {
      ...state,
      slots,
      requests: state.requests.map((r) =>
        touchedIds.has(r.id) ? { ...r, status: "CANCELLED" as const, resolvedAt: ctx.now() } : r,
      ),
      comments: state.comments.filter((c) => !removedThreads.has(c.threadId) || liveThreads.has(c.threadId)),
    },
    removed: state.slots.filter((s) => doomed.has(s.id) && s.status !== "SKIPPED").length,
  };
}

/** 등록을 endDate 로 마무리한다: 그 이후의 미래 레슨을 모두 지운다 (지난 레슨 기록은 유지) */
export function endEnrollment(
  state: LessonState,
  actor: Actor,
  id: string,
  endDate: string,
  ctx: MachineContext,
): { state: LessonState; removed: number } {
  requireInstructor(actor);
  const current = findEnrollment(state, id);
  if (endDate > current.endDate)
    throw new LessonError("INVALID_RANGE", "종료일을 늦추려면 '연장'을 사용해 주세요.");
  if (endDate < current.startDate)
    throw new LessonError("INVALID_RANGE", "종료일이 시작일보다 빠릅니다.");
  if (endOfDateMs(endDate) < Date.parse(ctx.now()) && endDate < toDateKey(new Date(ctx.now())))
    throw new LessonError("INVALID_RANGE", "마지막 날은 오늘 이후여야 합니다. 지난 레슨 기록은 지우지 않습니다.");
  const result = removeAfter(state, current, endOfDateMs(endDate), ctx, false);
  return {
    removed: result.removed,
    state: {
      ...result.state,
      enrollments: result.state.enrollments.map((e) => (e.id === id ? { ...current, endDate } : e)),
    },
  };
}

/**
 * 고정 시간(요일·시각·진행 주차)을 fromDate 부터 바꾼다.
 * fromDate 이후의 정규 레슨을 지우고 새 시간으로 다시 만든다 (보강 레슨은 그대로 둔다).
 */
export function changeEnrollmentSchedule(
  state: LessonState,
  actor: Actor,
  id: string,
  schedule: Pick<Enrollment, "times" | "weeks">,
  fromDate: string,
  ctx: MachineContext,
  holiday: HolidayLookup,
): { state: LessonState; created: number; conflicts: GenerationConflict[] } {
  requireInstructor(actor);
  const current = findEnrollment(state, id);
  validate({ ...current, ...schedule });
  if (fromDate > current.endDate)
    throw new LessonError("INVALID_RANGE", "적용 시작일이 등록 종료일보다 늦습니다.");
  if (endOfDateMs(fromDate) < Date.parse(ctx.now()))
    throw new LessonError("INVALID_RANGE", "적용 시작일은 오늘 이후여야 합니다.");
  const from = fromDate < current.startDate ? current.startDate : fromDate;
  const boundary = parseDate(from).getTime() - 1;
  const cleared = removeAfter(state, current, boundary, ctx, true).state;
  // 남겨 둔 기록과 같은 시각의 새 레슨은 만들지 않는다 (generate 에서 id 로 걸러짐)
  const next: Enrollment = { ...current, ...schedule };
  const base = { ...cleared, enrollments: cleared.enrollments.map((e) => (e.id === id ? next : e)) };
  return generate(base, next, from, current.endDate, holiday, ctx.now());
}

/**
 * 새로 지정된 공휴일(임시공휴일 등)에 걸린 미래의 정규 레슨을 '결정 필요'로 표시한다.
 * 이미 결정했거나 일정 변경으로 옮겨 온 레슨은 건드리지 않는다.
 */
export function markHolidays(state: LessonState, holiday: HolidayLookup, now: string): LessonState {
  let changed = false;
  const slots = state.slots.map((s) => {
    if (
      s.status !== "CONFIRMED" ||
      !s.enrollmentId ||
      s.holidayDecision ||
      s.movedFrom ||
      s.requestId ||
      Date.parse(s.start) < Date.parse(now)
    )
      return s;
    const holidayName = holiday(new Date(s.start));
    if (!holidayName) return s;
    changed = true;
    return { ...s, holidayName, holidayDecision: "UNDECIDED" as const };
  });
  return changed ? { ...state, slots } : state;
}

/* ------------------------------------------------------------------ */
/* 표시용 계산                                                          */
/* ------------------------------------------------------------------ */

const WEEKDAY = ["일", "월", "화", "수", "목", "금", "토"];

/** "주 1회 · 월 4회" */
export function planLabel(plan: Pick<Enrollment, "times" | "weeks">): string {
  const perMonth = plan.times.length * plan.weeks.length;
  const rhythm = plan.weeks.length >= 4 ? `주 ${plan.times.length}회` : `격주 (${plan.weeks.join("·")}주)`;
  return `${rhythm} · 월 ${perMonth}회`;
}

/** "화 19:00 · 토 13:00" */
export const timesLabel = (times: WeeklyTime[]) =>
  times.map((t) => `${WEEKDAY[t.weekday]} ${t.time}`).join(" · ");

/** 등록 종료까지 남은 날 수 (오늘 종료 = 0, 지났으면 음수) */
export function daysLeft(enrollment: Enrollment, now: string): number {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return Math.round((parseDate(enrollment.endDate).getTime() - today.getTime()) / 86_400_000);
}

/** 다음 결제 예정일 (등록 기간 안에서, 없는 날짜는 그 달 말일로) */
export function nextPaymentDate(enrollment: Enrollment, now: string): Date | undefined {
  if (!enrollment.paymentDay) return undefined;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  for (let i = 0; i < 2; i++) {
    const y = today.getFullYear();
    const m = today.getMonth() + i;
    const lastDay = new Date(y, m + 1, 0).getDate();
    const due = new Date(y, m, Math.min(enrollment.paymentDay, lastDay));
    if (due >= today) return due.getTime() <= endOfDateMs(enrollment.endDate) ? due : undefined;
  }
  return undefined;
}

/** 이번 달 정규 레슨 진행 현황 */
export function monthProgress(state: LessonState, enrollment: Enrollment, now: string) {
  const today = new Date(now);
  const inMonth = (s: LessonSlot) => {
    const d = new Date(s.start);
    return d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth();
  };
  const mine = state.slots.filter(
    (s) => s.enrollmentId === enrollment.id && s.lessonType === "REGULAR" && inMonth(s),
  );
  const targets = new Set(
    state.requests.filter((r) => r.status === "PENDING" && r.kind === "CHANGE").map((r) => r.toSlotId),
  );
  const lessons = mine.filter((s) => s.status !== "SKIPPED" && !targets.has(s.id));
  return {
    total: lessons.length,
    done: lessons.filter((s) => Date.parse(s.end) <= Date.parse(now)).length,
    /** 진행하지 않은 레슨 (공휴일 휴강 · 보강으로 미룸 · 미배정) */
    skipped: mine.filter((s) => s.status === "SKIPPED").length,
  };
}

/**
 * 일정 변경이 월별 횟수에 주는 영향. 다른 달로 옮길 때만 값이 있다.
 * (예: 11월 3회 / 12월 5회가 됩니다)
 */
export function changeImpact(
  state: LessonState,
  fromSlot: LessonSlot,
  toStart: string,
): { fromMonth: number; fromCount: number; toMonth: number; toCount: number } | undefined {
  const a = new Date(fromSlot.start);
  const b = new Date(toStart);
  if (fromSlot.lessonType !== "REGULAR") return undefined;
  if (a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()) return undefined;
  const targets = new Set(
    state.requests.filter((r) => r.status === "PENDING" && r.kind === "CHANGE").map((r) => r.toSlotId),
  );
  const count = (ref: Date) =>
    state.slots.filter((s) => {
      if (s.studentId !== fromSlot.studentId || s.id === fromSlot.id) return false;
      // 달력의 n/total 과 같은 기준: 정규 레슨만
      if (s.lessonType !== "REGULAR" || s.status === "SKIPPED" || targets.has(s.id)) return false;
      const d = new Date(s.start);
      return d.getFullYear() === ref.getFullYear() && d.getMonth() === ref.getMonth();
    }).length;
  return {
    fromMonth: a.getMonth() + 1,
    fromCount: count(a),
    toMonth: b.getMonth() + 1,
    toCount: count(b) + 1,
  };
}

/** 저장 전에 미리 보는: 기간 안에서 다른 레슨과 겹쳐 '미배정'이 될 레슨 수 */
export function previewConflicts(
  state: LessonState,
  plan: Pick<Enrollment, "times" | "weeks">,
  fromKey: string,
  toKey: string,
  now: string,
  ignoreEnrollmentId?: string,
): number {
  return lessonTimes(plan, fromKey, toKey).filter(({ start, end }) => {
    if (start.getTime() < Date.parse(now)) return false;
    return state.slots.some(
      (x) =>
        x.status !== "SKIPPED" &&
        x.status !== "OPEN" &&
        (!ignoreEnrollmentId || x.enrollmentId !== ignoreEnrollmentId) &&
        overlaps(x.start, x.end, start.toISOString(), end.toISOString()),
    );
  }).length;
}
