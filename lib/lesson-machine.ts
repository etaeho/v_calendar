/**
 * 레슨 일정 상태 머신 (순수 함수)
 *
 *   OPEN ──보강 신청(레슨생)──▶ PENDING_BOOKING ──승인(강사)──▶ CONFIRMED
 *                                      └──거절/취소──▶ OPEN
 *
 *   CONFIRMED(기존) + OPEN(대상) ──변경 요청──▶ 둘 다 PENDING_CHANGE
 *        승인(상대방) ▶ 기존=OPEN, 대상=CONFIRMED
 *        거절/취소    ▶ 기존=CONFIRMED, 대상=OPEN
 *
 * UI/스토어와 분리되어 있어 Phase 2 에서 서버(Supabase RPC 등)로 그대로 옮길 수 있다.
 */
import type {
  Actor,
  Comment,
  Enrollment,
  HolidayDecision,
  LessonSlot,
  LessonState,
  ScheduleRequest,
  SkipReason,
  SlotView,
} from "../types/calendar";

export type LessonErrorCode =
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "INVALID_STATE"
  | "INVALID_RANGE"
  | "OVERLAP";

export class LessonError extends Error {
  code: LessonErrorCode;
  constructor(code: LessonErrorCode, message: string) {
    super(message);
    this.name = "LessonError";
    this.code = code;
  }
}

/** 시간/ID 주입 (테스트에서 결정적으로 만들기 위함) */
export interface MachineContext {
  now: () => string;
  id: (prefix: string) => string;
}

export const overlaps = (
  aStart: string,
  aEnd: string,
  bStart: string,
  bEnd: string,
) => Date.parse(aStart) < Date.parse(bEnd) && Date.parse(bStart) < Date.parse(aEnd);

const isPast = (iso: string, ctx: MachineContext) => Date.parse(iso) < Date.parse(ctx.now());

/** 휴강(SKIPPED) 기록은 시간을 점유하지 않는다 */
const occupies = (s: LessonSlot) => s.status !== "SKIPPED";

export const enrollmentOf = (state: LessonState, slot: LessonSlot): Enrollment | undefined =>
  slot.enrollmentId ? state.enrollments.find((e) => e.id === slot.enrollmentId) : undefined;

/** 등록 종료일의 마지막 순간 (현지 시간) */
export const enrollmentEndMs = (e: Enrollment) => new Date(`${e.endDate}T23:59:59.999`).getTime();

/**
 * 이 레슨에 적용되는 수강 등록. 정규 레슨은 자기 등록, 보강 레슨은 그 날짜를 포함하는 등록
 * (없으면 가장 최근 등록)을 따른다.
 */
export function governingEnrollment(state: LessonState, slot: LessonSlot): Enrollment | undefined {
  const own = enrollmentOf(state, slot);
  if (own) return own;
  if (!slot.studentId) return undefined;
  const mine = state.enrollments
    .filter((e) => e.studentId === slot.studentId)
    .sort((a, b) => b.endDate.localeCompare(a.endDate));
  const t = Date.parse(slot.start);
  return (
    mine.find((e) => new Date(`${e.startDate}T00:00:00`).getTime() <= t && t <= enrollmentEndMs(e)) ??
    mine[0]
  );
}

/** 이 레슨을 옮길 수 있는 마지막 시각: 정규 레슨은 자기 등록 종료일, 보강은 레슨생의 가장 늦은 등록 종료일 */
export function changeLimitMs(state: LessonState, slot: LessonSlot): number {
  const own = enrollmentOf(state, slot);
  if (own) return enrollmentEndMs(own);
  const ends = state.enrollments
    .filter((e) => e.studentId === slot.studentId)
    .map((e) => enrollmentEndMs(e));
  return ends.length > 0 ? Math.max(...ends) : Infinity;
}

export const changeLimitLabel = (state: LessonState, slot: LessonSlot) => {
  const ms = changeLimitMs(state, slot);
  if (!Number.isFinite(ms)) return undefined;
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** 레슨생의 변경 요청 마감(등록 시 합의한 n시간 전, 보강 레슨 포함) */
export const deadlineHours = (state: LessonState, slot: LessonSlot) =>
  governingEnrollment(state, slot)?.changeDeadlineHours ?? 0;

/** 레슨생의 변경 요청 마감이 지났는가 */
export function changeDeadlinePassed(state: LessonState, slot: LessonSlot, now: string): boolean {
  const hours = deadlineHours(state, slot);
  return hours > 0 && Date.parse(slot.start) - Date.parse(now) < hours * 3_600_000;
}

const findSlot = (state: LessonState, slotId: string): LessonSlot => {
  const slot = state.slots.find((s) => s.id === slotId);
  if (!slot) throw new LessonError("NOT_FOUND", "슬롯을 찾을 수 없습니다.");
  return slot;
};

const replaceSlots = (state: LessonState, next: LessonSlot[]): LessonSlot[] => {
  const byId = new Map(next.map((s) => [s.id, s]));
  return state.slots.map((s) => byId.get(s.id) ?? s);
};

const systemComment = (ctx: MachineContext, threadId: string, body: string): Comment => ({
  id: ctx.id("c"),
  threadId,
  kind: "SYSTEM",
  body,
  createdAt: ctx.now(),
});

const userComment = (
  ctx: MachineContext,
  threadId: string,
  actor: Actor,
  body: string,
): Comment => ({
  id: ctx.id("c"),
  threadId,
  kind: "USER",
  authorId: actor.userId,
  body,
  createdAt: ctx.now(),
});

const cleanMessage = (message: string | undefined) => message?.trim() || undefined;

/** 빈 슬롯으로 되돌린다. 스레드를 새로 발급해 이전 대화가 다음 사람에게 보이지 않게 한다 */
const toOpen = (ctx: MachineContext, slot: LessonSlot): LessonSlot => ({
  id: slot.id,
  start: slot.start,
  end: slot.end,
  status: "OPEN",
  threadId: ctx.id("t"),
});

/* ------------------------------------------------------------------ */
/* 강사: 슬롯 오픈 / 삭제                                               */
/* ------------------------------------------------------------------ */

export function createOpenSlot(
  state: LessonState,
  actor: Actor,
  range: { start: string; end: string },
  ctx: MachineContext,
): { state: LessonState; slot: LessonSlot } {
  if (actor.role !== "INSTRUCTOR")
    throw new LessonError("FORBIDDEN", "강사만 레슨 가능 시간을 열 수 있습니다.");
  if (!(Date.parse(range.start) < Date.parse(range.end)))
    throw new LessonError("INVALID_RANGE", "종료 시간이 시작 시간보다 늦어야 합니다.");
  if (isPast(range.start, ctx))
    throw new LessonError("INVALID_RANGE", "지난 시간에는 슬롯을 열 수 없습니다.");
  if (state.slots.some((s) => occupies(s) && overlaps(s.start, s.end, range.start, range.end)))
    throw new LessonError("OVERLAP", "이미 등록된 레슨/슬롯과 시간이 겹칩니다.");

  const slot: LessonSlot = {
    id: ctx.id("slot"),
    start: range.start,
    end: range.end,
    status: "OPEN",
    threadId: ctx.id("t"),
  };
  return { state: { ...state, slots: [...state.slots, slot] }, slot };
}

export function deleteOpenSlot(state: LessonState, actor: Actor, slotId: string): LessonState {
  if (actor.role !== "INSTRUCTOR")
    throw new LessonError("FORBIDDEN", "강사만 슬롯을 삭제할 수 있습니다.");
  const slot = findSlot(state, slotId);
  if (slot.status !== "OPEN")
    throw new LessonError("INVALID_STATE", "빈 슬롯(OPEN)만 삭제할 수 있습니다.");
  return {
    ...state,
    slots: state.slots.filter((s) => s.id !== slotId),
    comments: state.comments.filter((c) => c.threadId !== slot.threadId),
  };
}

/** 강사: 빈 슬롯의 시간을 옮긴다 (드래그 앤 드롭) */
export function moveOpenSlot(
  state: LessonState,
  actor: Actor,
  slotId: string,
  range: { start: string; end: string },
): LessonState {
  if (actor.role !== "INSTRUCTOR")
    throw new LessonError("FORBIDDEN", "강사만 슬롯을 옮길 수 있습니다.");
  const slot = findSlot(state, slotId);
  if (slot.status !== "OPEN")
    throw new LessonError("INVALID_STATE", "빈 슬롯(OPEN)만 직접 옮길 수 있습니다.");
  if (!(Date.parse(range.start) < Date.parse(range.end)))
    throw new LessonError("INVALID_RANGE", "종료 시간이 시작 시간보다 늦어야 합니다.");
  if (
    state.slots.some(
      (s) => s.id !== slotId && occupies(s) && overlaps(s.start, s.end, range.start, range.end),
    )
  )
    throw new LessonError("OVERLAP", "이미 등록된 레슨/슬롯과 시간이 겹칩니다.");
  return {
    ...state,
    slots: replaceSlots(state, [{ ...slot, start: range.start, end: range.end }]),
  };
}

/* ------------------------------------------------------------------ */
/* 레슨생: 보강 신청                                                    */
/* ------------------------------------------------------------------ */

export function requestBooking(
  state: LessonState,
  actor: Actor,
  slotId: string,
  ctx: MachineContext,
  message?: string,
): LessonState {
  if (actor.role !== "STUDENT")
    throw new LessonError("FORBIDDEN", "보강 신청은 레슨생만 할 수 있습니다.");
  const slot = findSlot(state, slotId);
  if (slot.status !== "OPEN")
    throw new LessonError("INVALID_STATE", "이미 마감된 슬롯입니다.");
  if (isPast(slot.start, ctx))
    throw new LessonError("INVALID_STATE", "이미 지난 시간이라 신청할 수 없습니다.");
  // 보강은 수강 등록 기간 안에서만 신청할 수 있다
  const mine = state.enrollments.filter((e) => e.studentId === actor.userId);
  if (mine.length === 0)
    throw new LessonError("FORBIDDEN", "수강 등록 후에 보강을 신청할 수 있습니다. 선생님께 등록을 요청해 주세요.");
  const lastEnd = Math.max(...mine.map((e) => enrollmentEndMs(e)));
  if (Date.parse(slot.start) > lastEnd)
    throw new LessonError(
      "INVALID_STATE",
      "등록 기간이 끝난 뒤의 시간입니다. 재등록 후에 신청해 주세요.",
    );

  const request: ScheduleRequest = {
    id: ctx.id("req"),
    kind: "BOOKING",
    status: "PENDING",
    studentId: actor.userId,
    requestedBy: "STUDENT",
    toSlotId: slot.id,
    toStart: slot.start,
    message: cleanMessage(message),
    createdAt: ctx.now(),
  };
  const next: LessonSlot = {
    ...slot,
    status: "PENDING_BOOKING",
    studentId: actor.userId,
    lessonType: "MAKEUP",
    requestId: request.id,
  };
  return {
    ...state,
    slots: replaceSlots(state, [next]),
    requests: [...state.requests, request],
    comments: [
      ...state.comments,
      systemComment(ctx, slot.threadId, "보강 신청이 접수되었습니다. 강사 승인을 기다리는 중입니다."),
    ],
  };
}

/**
 * 강사: 등록 때 다른 일정과 겹쳐 '미배정'이 된 정규 레슨을, 그 시간이 비었으면 원래 시간으로 다시 잡는다.
 * (예: 겹쳤던 보강 신청이 거절된 뒤) 겹치던 빈 슬롯은 레슨으로 대체된다. 보강 필요 횟수는 자동으로 1 줄어든다.
 */
export function restoreMissed(
  state: LessonState,
  actor: Actor,
  slotId: string,
  ctx: MachineContext,
): LessonState {
  if (actor.role !== "INSTRUCTOR")
    throw new LessonError("FORBIDDEN", "강사만 다시 잡을 수 있습니다.");
  const slot = findSlot(state, slotId);
  if (slot.status !== "SKIPPED" || slot.skipReason !== "CONFLICT")
    throw new LessonError("INVALID_STATE", "미배정 레슨만 다시 잡을 수 있습니다.");
  if (isPast(slot.start, ctx)) throw new LessonError("INVALID_STATE", "이미 지난 시간입니다.");
  const hits = state.slots.filter(
    (s) => s.id !== slot.id && occupies(s) && overlaps(s.start, s.end, slot.start, slot.end),
  );
  if (hits.some((s) => s.status !== "OPEN"))
    throw new LessonError("OVERLAP", "아직 다른 레슨과 겹칩니다. 다른 시간으로 보강을 잡아 주세요.");
  const gone = new Set(hits.map((s) => s.id));
  return {
    ...state,
    slots: state.slots
      .filter((s) => !gone.has(s.id))
      .map((s) => (s.id === slot.id ? { ...s, status: "CONFIRMED" as const, skipReason: undefined } : s)),
    comments: [
      ...state.comments.filter((c) => !hits.some((h) => h.threadId === c.threadId)),
      systemComment(ctx, slot.threadId, "시간이 비어 원래 시간으로 레슨을 다시 잡았습니다."),
    ],
  };
}

/** 지금 다시 잡을 수 있는 미배정 레슨인가 (화면에서 버튼 표시용) */
export function canRestoreMissed(state: LessonState, slot: LessonSlot, now: string): boolean {
  if (slot.status !== "SKIPPED" || slot.skipReason !== "CONFLICT") return false;
  if (Date.parse(slot.start) < Date.parse(now)) return false;
  return !state.slots.some(
    (s) =>
      s.id !== slot.id &&
      occupies(s) &&
      s.status !== "OPEN" &&
      overlaps(s.start, s.end, slot.start, slot.end),
  );
}

/**
 * 강사: 레슨생에게 보강 시간을 제안한다 (레슨생 관리의 '남은 보강'에서).
 * 빈 슬롯이 승인 대기 상태가 되고, 레슨생이 동의하면 보강 레슨으로 확정된다.
 */
export function proposeMakeup(
  state: LessonState,
  actor: Actor,
  slotId: string,
  studentId: string,
  ctx: MachineContext,
  message?: string,
): LessonState {
  if (actor.role !== "INSTRUCTOR")
    throw new LessonError("FORBIDDEN", "보강 제안은 강사만 할 수 있습니다.");
  const slot = findSlot(state, slotId);
  if (slot.status !== "OPEN") throw new LessonError("INVALID_STATE", "이미 마감된 슬롯입니다.");
  if (isPast(slot.start, ctx)) throw new LessonError("INVALID_STATE", "지난 시간에는 보강을 잡을 수 없습니다.");
  const clash = state.slots.find(
    (s) =>
      s.studentId === studentId &&
      s.status !== "SKIPPED" &&
      s.id !== slot.id &&
      overlaps(s.start, s.end, slot.start, slot.end),
  );
  if (clash) throw new LessonError("OVERLAP", "이 레슨생의 다른 레슨과 시간이 겹칩니다.");

  const request: ScheduleRequest = {
    id: ctx.id("req"),
    kind: "BOOKING",
    status: "PENDING",
    studentId,
    requestedBy: "INSTRUCTOR",
    toSlotId: slot.id,
    toStart: slot.start,
    message: cleanMessage(message),
    createdAt: ctx.now(),
  };
  return {
    ...state,
    slots: replaceSlots(state, [
      { ...slot, status: "PENDING_BOOKING", studentId, lessonType: "MAKEUP", requestId: request.id },
    ]),
    requests: [...state.requests, request],
    comments: [
      ...state.comments,
      systemComment(ctx, slot.threadId, "강사가 보강 시간을 제안했습니다. 레슨생 동의를 기다리는 중입니다."),
    ],
  };
}

/* ------------------------------------------------------------------ */
/* 강사/레슨생: 일정 변경 요청                                          */
/* ------------------------------------------------------------------ */

export function requestChange(
  state: LessonState,
  actor: Actor,
  fromSlotId: string,
  toSlotId: string,
  ctx: MachineContext,
  message?: string,
): LessonState {
  const from = findSlot(state, fromSlotId);
  const to = findSlot(state, toSlotId);
  if (from.status !== "CONFIRMED" || !from.studentId)
    throw new LessonError("INVALID_STATE", "확정된 레슨만 변경 요청할 수 있습니다.");
  if (from.requestId)
    throw new LessonError("INVALID_STATE", "이 레슨에 진행 중인 요청이 있습니다.");
  if (actor.role === "STUDENT" && from.studentId !== actor.userId)
    throw new LessonError("FORBIDDEN", "본인의 레슨만 변경 요청할 수 있습니다.");
  if (to.status !== "OPEN")
    throw new LessonError("INVALID_STATE", "변경 대상은 빈 슬롯이어야 합니다.");
  if (Date.parse(from.end) <= Date.parse(ctx.now()))
    throw new LessonError("INVALID_STATE", "이미 끝난 레슨은 변경할 수 없습니다.");
  if (isPast(to.start, ctx))
    throw new LessonError("INVALID_STATE", "지난 시간으로는 옮길 수 없습니다.");
  if (Date.parse(to.start) > changeLimitMs(state, from))
    throw new LessonError(
      "INVALID_STATE",
      `등록 기간(${changeLimitLabel(state, from)}까지) 이후로는 옮길 수 없습니다.`,
    );
  if (actor.role === "STUDENT" && changeDeadlinePassed(state, from, ctx.now()))
    throw new LessonError(
      "INVALID_STATE",
      `레슨 시작 ${deadlineHours(state, from)}시간 전까지만 변경을 요청할 수 있습니다.`,
    );

  const request: ScheduleRequest = {
    id: ctx.id("req"),
    kind: "CHANGE",
    status: "PENDING",
    studentId: from.studentId,
    requestedBy: actor.role,
    fromSlotId: from.id,
    toSlotId: to.id,
    fromStart: from.start,
    toStart: to.start,
    message: cleanMessage(message),
    createdAt: ctx.now(),
  };
  const waitingFor = actor.role === "STUDENT" ? "강사 승인을" : "레슨생 동의를";
  return {
    ...state,
    slots: replaceSlots(state, [
      { ...from, status: "PENDING_CHANGE", requestId: request.id },
      {
        ...to,
        status: "PENDING_CHANGE",
        studentId: from.studentId,
        lessonType: from.lessonType,
        enrollmentId: from.enrollmentId,
        requestId: request.id,
        // 기존 레슨의 대화 스레드를 공유해 두 슬롯을 하나의 대화로 연결한다
        threadId: from.threadId,
      },
    ]),
    requests: [...state.requests, request],
    comments: [
      ...state.comments.filter((c) => c.threadId !== to.threadId),
      systemComment(
        ctx,
        from.threadId,
        `${actor.role === "STUDENT" ? "레슨생이" : "강사가"} 일정 변경을 요청했습니다. ${waitingFor} 기다리는 중입니다.`,
      ),
    ],
  };
}

/**
 * 강사: 확정된 레슨을 아직 슬롯이 없는 새 시간으로 옮기자고 요청한다.
 * 새 시간에 빈 슬롯을 열고 그 슬롯으로 변경 요청을 보낸다 (레슨생 동의 필요).
 * 거절되면 새로 연 슬롯은 빈 슬롯(OPEN)으로 남는다.
 */
export function requestChangeToNewTime(
  state: LessonState,
  actor: Actor,
  fromSlotId: string,
  range: { start: string; end: string },
  ctx: MachineContext,
  message?: string,
): LessonState {
  if (actor.role !== "INSTRUCTOR")
    throw new LessonError("FORBIDDEN", "레슨생은 강사가 열어 둔 빈 슬롯으로만 옮길 수 있습니다.");
  const from = findSlot(state, fromSlotId);
  if (from.status !== "CONFIRMED")
    throw new LessonError("INVALID_STATE", "확정된 레슨만 변경 요청할 수 있습니다.");
  const created = createOpenSlot(state, actor, range, ctx);
  return requestChange(created.state, actor, fromSlotId, created.slot.id, ctx, message);
}

/** 드래그 앤 드롭 결과 미리 계산 (화면의 고스트 표시와 실제 처리에 같이 쓴다) */
export type DropPlan =
  | { kind: "none" }
  | { kind: "move"; start: string; end: string }
  | { kind: "change"; toSlotId: string; start: string; end: string }
  | { kind: "change-new"; start: string; end: string }
  | { kind: "invalid"; reason: string; start: string; end: string };

export function planDrop(
  state: LessonState,
  actor: Actor,
  slotId: string,
  start: string,
  now: string,
): DropPlan {
  const slot = state.slots.find((s) => s.id === slotId);
  if (!slot) return { kind: "none" };
  const duration = Date.parse(slot.end) - Date.parse(slot.start);
  const end = new Date(Date.parse(start) + duration).toISOString();
  if (Date.parse(start) === Date.parse(slot.start)) return { kind: "none" };
  const invalid = (reason: string): DropPlan => ({ kind: "invalid", reason, start, end });
  const others = state.slots.filter((s) => s.id !== slotId && occupies(s));

  if (slot.status === "OPEN") {
    if (actor.role !== "INSTRUCTOR") return invalid("빈 슬롯은 강사만 옮길 수 있습니다.");
    if (Date.parse(start) < Date.parse(now)) return invalid("지난 시간으로는 옮길 수 없습니다.");
    if (others.some((s) => overlaps(s.start, s.end, start, end)))
      return invalid("다른 레슨/슬롯과 겹칩니다.");
    return { kind: "move", start, end };
  }

  const canChange =
    slot.status === "CONFIRMED" &&
    !slot.requestId &&
    !!slot.studentId &&
    (actor.role === "INSTRUCTOR" || slot.studentId === actor.userId);
  if (canChange && Date.parse(slot.end) <= Date.parse(now))
    return invalid("이미 끝난 레슨은 옮길 수 없습니다.");
  if (!canChange) {
    return invalid(
      slot.status === "CONFIRMED" ? "본인 레슨만 옮길 수 있습니다." : "응답 대기 중인 일정은 옮길 수 없습니다.",
    );
  }

  if (actor.role === "STUDENT" && changeDeadlinePassed(state, slot, now))
    return invalid(`레슨 시작 ${deadlineHours(state, slot)}시간 전까지만 변경할 수 있습니다.`);
  if (Date.parse(start) > changeLimitMs(state, slot))
    return invalid(`등록 기간(${changeLimitLabel(state, slot)}까지) 이후로는 옮길 수 없습니다.`);

  // 놓은 위치에 빈 슬롯이 있으면 그 슬롯으로 변경 요청 (시작 시간이 같은 슬롯 우선)
  const targets = others
    .filter((s) => s.status === "OPEN" && overlaps(s.start, s.end, start, end))
    .sort(
      (a, b) =>
        Math.abs(Date.parse(a.start) - Date.parse(start)) -
        Math.abs(Date.parse(b.start) - Date.parse(start)),
    );
  if (targets.length > 0) {
    const target = targets[0];
    if (Date.parse(target.start) < Date.parse(now)) return invalid("지난 슬롯으로는 옮길 수 없습니다.");
    return { kind: "change", toSlotId: target.id, start: target.start, end: target.end };
  }
  if (actor.role !== "INSTRUCTOR") return invalid("강사가 열어 둔 빈 슬롯 위에 놓아 주세요.");
  if (Date.parse(start) < Date.parse(now)) return invalid("지난 시간으로는 옮길 수 없습니다.");
  if (overlaps(slot.start, slot.end, start, end))
    return invalid("기존 레슨 시간과 겹치지 않게 옮겨 주세요.");
  if (others.some((s) => overlaps(s.start, s.end, start, end)))
    return invalid("다른 레슨/슬롯과 겹칩니다.");
  return { kind: "change-new", start, end };
}

/* ------------------------------------------------------------------ */
/* 승인 / 거절 / 취소                                                   */
/* ------------------------------------------------------------------ */

const findPending = (state: LessonState, requestId: string): ScheduleRequest => {
  const request = state.requests.find((r) => r.id === requestId);
  if (!request) throw new LessonError("NOT_FOUND", "요청을 찾을 수 없습니다.");
  if (request.status !== "PENDING")
    throw new LessonError("INVALID_STATE", "이미 처리된 요청입니다.");
  return request;
};

/** 이 행위자가 요청을 승인/거절할 수 있는가 (요청을 보낸 쪽의 상대방만 가능) */
export function canResolve(request: ScheduleRequest, actor: Actor): boolean {
  if (request.status !== "PENDING") return false;
  if (request.requestedBy === actor.role) return false;
  return actor.role === "INSTRUCTOR" || request.studentId === actor.userId;
}

/** 이 행위자가 요청을 철회할 수 있는가 (요청을 보낸 본인만 가능) */
export function canCancel(request: ScheduleRequest, actor: Actor): boolean {
  if (request.status !== "PENDING") return false;
  if (request.requestedBy !== actor.role) return false;
  return actor.role === "INSTRUCTOR" || request.studentId === actor.userId;
}

const replaceRequest = (state: LessonState, next: ScheduleRequest) =>
  state.requests.map((r) => (r.id === next.id ? next : r));

/** 요청을 되돌린다 (거절·취소 공통): 대상 슬롯은 OPEN, 기존 레슨은 CONFIRMED 유지 */
function revert(
  state: LessonState,
  request: ScheduleRequest,
  ctx: MachineContext,
): { slots: LessonSlot[]; keepThreadId?: string } {
  const to = findSlot(state, request.toSlotId);
  if (request.kind === "BOOKING") {
    return { slots: replaceSlots(state, [toOpen(ctx, to)]) };
  }
  if (request.kind === "HOLIDAY" || request.kind === "DEFER") {
    // 공휴일 제안이 반려/취소되면 다시 '결정 필요' 상태로, 보강 미루기는 원래 레슨으로 남는다
    return { slots: replaceSlots(state, [{ ...to, requestId: undefined }]), keepThreadId: to.threadId };
  }
  const from = findSlot(state, request.fromSlotId!);
  return {
    slots: replaceSlots(state, [
      { ...from, status: "CONFIRMED", requestId: undefined },
      toOpen(ctx, to),
    ]),
    keepThreadId: from.threadId,
  };
}

export function approveRequest(
  state: LessonState,
  actor: Actor,
  requestId: string,
  ctx: MachineContext,
): LessonState {
  const request = findPending(state, requestId);
  if (!canResolve(request, actor))
    throw new LessonError("FORBIDDEN", "이 요청을 승인할 권한이 없습니다.");

  const to = findSlot(state, request.toSlotId);
  const who = actor.role === "INSTRUCTOR" ? "강사가" : "레슨생이";

  if (request.kind === "HOLIDAY") {
    const skip = request.holidayProposal === "SKIP";
    const decided: LessonSlot = {
      ...to,
      status: skip ? "SKIPPED" : "CONFIRMED",
      holidayDecision: skip ? "SKIP" : "PROCEED",
      ...(skip ? { skipReason: "HOLIDAY" as const } : {}),
      requestId: undefined,
    };
    return {
      ...state,
      slots: replaceSlots(state, [decided]),
      requests: replaceRequest(state, { ...request, status: "APPROVED", resolvedAt: ctx.now() }),
      comments: [
        ...state.comments,
        systemComment(
          ctx,
          to.threadId,
          skip
            ? `공휴일(${to.holidayName ?? "휴일"}) 레슨은 쉬기로 했습니다. (휴강 · 보강 필요 1회)`
            : `공휴일(${to.holidayName ?? "휴일"})이지만 레슨을 그대로 진행하기로 했습니다.`,
        ),
      ],
    };
  }

  if (request.kind === "DEFER") {
    return {
      ...state,
      slots: replaceSlots(state, [
        { ...to, status: "SKIPPED", skipReason: "DEFERRED", requestId: undefined },
      ]),
      requests: replaceRequest(state, { ...request, status: "APPROVED", resolvedAt: ctx.now() }),
      comments: [
        ...state.comments,
        systemComment(
          ctx,
          to.threadId,
          `${who} 동의해 이 레슨은 보강으로 미뤘습니다. 날짜는 보강 신청으로 다시 잡아 주세요. (보강 필요 1회)`,
        ),
      ],
    };
  }

  const confirmed: LessonSlot = { ...to, status: "CONFIRMED", requestId: undefined };
  const changed: LessonSlot[] = [confirmed];
  let removeId: string | undefined;
  if (request.kind === "CHANGE") {
    const from = findSlot(state, request.fromSlotId!);
    // 대화 스레드는 새 슬롯(confirmed)이 이어받는다.
    confirmed.movedFrom = from.start;
    // 레슨생이 요청한 변경: 기존 시간은 다시 빈 슬롯(OPEN)으로 연다.
    // 강사가 제안한 변경 / 공휴일 레슨을 옮긴 경우: 기존 시간은 열지 않고 지운다.
    if (request.requestedBy === "STUDENT" && !from.holidayDecision) changed.push(toOpen(ctx, from));
    else removeId = from.id;
  }
  return {
    ...state,
    slots: replaceSlots(state, changed).filter((s) => s.id !== removeId),
    requests: replaceRequest(state, {
      ...request,
      status: "APPROVED",
      resolvedAt: ctx.now(),
    }),
    comments: [
      ...state.comments,
      systemComment(
        ctx,
        confirmed.threadId,
        request.kind === "BOOKING"
          ? actor.role === "STUDENT"
            ? "레슨생이 보강 일정에 동의했습니다. 레슨이 확정되었습니다."
            : `${who} 보강 신청을 승인했습니다. 레슨이 확정되었습니다.`
          : actor.role === "STUDENT"
            ? "레슨생이 일정 변경에 동의했습니다. 새 시간으로 확정되었습니다."
            : `${who} 일정 변경을 승인했습니다. 새 시간으로 확정되었습니다.`,
      ),
    ],
  };
}

export function rejectRequest(
  state: LessonState,
  actor: Actor,
  requestId: string,
  ctx: MachineContext,
  reason?: string,
): LessonState {
  const request = findPending(state, requestId);
  if (!canResolve(request, actor))
    throw new LessonError("FORBIDDEN", "이 요청을 거절할 권한이 없습니다.");

  const trimmed = reason?.trim() || undefined;
  const { slots, keepThreadId } = revert(state, request, ctx);
  const who = actor.role === "INSTRUCTOR" ? "강사가" : "레슨생이";
  const what =
    request.kind === "HOLIDAY"
      ? "공휴일 레슨 제안을 거절했습니다. 다시 정해 주세요."
      : request.kind === "DEFER"
        ? "보강으로 미루기를 거절했습니다. 레슨은 그대로 진행합니다."
        : "일정 변경 요청을 거절했습니다. 기존 일정이 유지됩니다.";
  return {
    ...state,
    slots,
    requests: replaceRequest(state, {
      ...request,
      status: "REJECTED",
      resolvedAt: ctx.now(),
      rejectReason: trimmed,
    }),
    // 변경 요청이 반려되면 기존 레슨 스레드에 사유를 남긴다.
    // 보강 신청 반려는 슬롯이 OPEN 으로 돌아가므로 사유는 요청 내역(rejectReason)에만 남는다.
    comments: keepThreadId
      ? [
          ...state.comments,
          systemComment(
            ctx,
            keepThreadId,
            `${who} ${what}${trimmed ? ` (사유: ${trimmed})` : ""}`,
          ),
        ]
      : state.comments,
  };
}

export function cancelRequest(
  state: LessonState,
  actor: Actor,
  requestId: string,
  ctx: MachineContext,
): LessonState {
  const request = findPending(state, requestId);
  if (!canCancel(request, actor))
    throw new LessonError("FORBIDDEN", "본인이 보낸 요청만 취소할 수 있습니다.");

  const { slots, keepThreadId } = revert(state, request, ctx);
  return {
    ...state,
    slots,
    requests: replaceRequest(state, {
      ...request,
      status: "CANCELLED",
      resolvedAt: ctx.now(),
    }),
    comments: keepThreadId
      ? [
          ...state.comments,
          systemComment(
            ctx,
            keepThreadId,
            request.kind === "HOLIDAY"
              ? "공휴일 레슨 제안이 취소되었습니다."
              : request.kind === "DEFER"
                ? "보강으로 미루기 요청이 취소되었습니다. 레슨은 그대로 진행합니다."
                : "일정 변경 요청이 취소되었습니다. 기존 일정이 유지됩니다.",
          ),
        ]
      : state.comments,
  };
}

/* ------------------------------------------------------------------ */
/* 공휴일 레슨 결정                                                     */
/* ------------------------------------------------------------------ */

/**
 * 공휴일에 잡힌 레슨을 '그대로 진행' 또는 '휴강'하자고 제안한다. 상대방이 동의하면 확정된다.
 * (다른 날로 옮기는 것은 일반 일정 변경 요청을 쓴다)
 */
export function proposeHoliday(
  state: LessonState,
  actor: Actor,
  slotId: string,
  proposal: Exclude<HolidayDecision, "UNDECIDED">,
  ctx: MachineContext,
  message?: string,
): LessonState {
  const slot = findSlot(state, slotId);
  if (slot.status !== "CONFIRMED" || slot.holidayDecision !== "UNDECIDED" || !slot.studentId)
    throw new LessonError("INVALID_STATE", "결정이 필요한 공휴일 레슨이 아닙니다.");
  if (slot.requestId) throw new LessonError("INVALID_STATE", "이미 진행 중인 제안이 있습니다.");
  if (actor.role === "STUDENT" && slot.studentId !== actor.userId)
    throw new LessonError("FORBIDDEN", "본인의 레슨만 제안할 수 있습니다.");
  if (isPast(slot.start, ctx)) throw new LessonError("INVALID_STATE", "이미 지난 레슨입니다.");

  const request: ScheduleRequest = {
    id: ctx.id("req"),
    kind: "HOLIDAY",
    status: "PENDING",
    studentId: slot.studentId,
    requestedBy: actor.role,
    toSlotId: slot.id,
    toStart: slot.start,
    holidayProposal: proposal,
    message: cleanMessage(message),
    createdAt: ctx.now(),
  };
  return {
    ...state,
    slots: replaceSlots(state, [{ ...slot, requestId: request.id }]),
    requests: [...state.requests, request],
    comments: [
      ...state.comments,
      systemComment(
        ctx,
        slot.threadId,
        `${actor.role === "STUDENT" ? "레슨생이" : "강사가"} 공휴일(${slot.holidayName ?? "휴일"}) 레슨을 ${
          proposal === "SKIP" ? "쉬자고(휴강)" : "그대로 진행하자고"
        } 제안했습니다.`,
      ),
    ],
  };
}

/* ------------------------------------------------------------------ */
/* 보강 관리                                                            */
/* ------------------------------------------------------------------ */

/**
 * 확정된 정규 레슨을 취소하고 '보강 필요'로 미루자고 요청한다 (새 날짜는 나중에 정함).
 * 상대방이 동의하면 레슨은 휴강(DEFERRED) 기록이 되고 보강 필요 횟수가 1 늘어난다.
 */
export function proposeDefer(
  state: LessonState,
  actor: Actor,
  slotId: string,
  ctx: MachineContext,
  message?: string,
): LessonState {
  const slot = findSlot(state, slotId);
  if (slot.status !== "CONFIRMED" || !slot.studentId || slot.lessonType !== "REGULAR")
    throw new LessonError("INVALID_STATE", "확정된 정규 레슨만 보강으로 미룰 수 있습니다.");
  if (slot.requestId) throw new LessonError("INVALID_STATE", "이 레슨에 진행 중인 요청이 있습니다.");
  if (actor.role === "STUDENT" && slot.studentId !== actor.userId)
    throw new LessonError("FORBIDDEN", "본인의 레슨만 요청할 수 있습니다.");
  if (isPast(slot.start, ctx)) throw new LessonError("INVALID_STATE", "이미 시작한 레슨은 미룰 수 없습니다.");
  if (actor.role === "STUDENT" && changeDeadlinePassed(state, slot, ctx.now()))
    throw new LessonError(
      "INVALID_STATE",
      `레슨 시작 ${deadlineHours(state, slot)}시간 전까지만 요청할 수 있습니다.`,
    );

  const request: ScheduleRequest = {
    id: ctx.id("req"),
    kind: "DEFER",
    status: "PENDING",
    studentId: slot.studentId,
    requestedBy: actor.role,
    toSlotId: slot.id,
    toStart: slot.start,
    message: cleanMessage(message),
    createdAt: ctx.now(),
  };
  return {
    ...state,
    slots: replaceSlots(state, [{ ...slot, requestId: request.id }]),
    requests: [...state.requests, request],
    comments: [
      ...state.comments,
      systemComment(
        ctx,
        slot.threadId,
        `${actor.role === "STUDENT" ? "레슨생이" : "강사가"} 이 레슨을 보강으로 미루자고 요청했습니다.`,
      ),
    ],
  };
}

/** 강사: 보강 필요 횟수를 직접 조정한다 (+1 결석 보강, -1 보강 없이 정리 등) */
export function adjustMakeup(
  state: LessonState,
  actor: Actor,
  studentId: string,
  delta: number,
  reason: string,
  ctx: MachineContext,
): LessonState {
  if (actor.role !== "INSTRUCTOR")
    throw new LessonError("FORBIDDEN", "보강 횟수는 강사만 조정할 수 있습니다.");
  if (!Number.isInteger(delta) || delta === 0)
    throw new LessonError("INVALID_RANGE", "조정할 횟수를 확인해 주세요.");
  const trimmed = reason.trim();
  if (!trimmed) throw new LessonError("INVALID_RANGE", "조정 사유를 적어 주세요.");
  if (makeupSummary(state, studentId, ctx.now()).owed + delta < 0)
    throw new LessonError("INVALID_RANGE", "보강 필요 횟수는 0보다 작아질 수 없습니다.");
  return {
    ...state,
    makeupAdjustments: [
      ...state.makeupAdjustments,
      { id: ctx.id("adj"), studentId, delta, reason: trimmed, createdAt: ctx.now() },
    ],
  };
}

export const SKIP_REASON_LABEL: Record<SkipReason, string> = {
  HOLIDAY: "공휴일 휴강",
  DEFERRED: "보강으로 미룸",
  CONFLICT: "일정 겹침 · 미배정",
};

export interface MakeupEntry {
  at: string;
  delta: number;
  label: string;
  slotId?: string;
}

/**
 * 레슨생의 보강 현황.
 * 보강 필요 = 진행하지 못한 정규 레슨(휴강·미룸·미배정) + 강사 조정
 * 남은 보강 = 보강 필요 - (완료 + 예정된 보강 레슨). 음수면 추가 레슨을 받은 것.
 */
export function makeupSummary(state: LessonState, studentId: string, now: string) {
  const mine = state.slots.filter((s) => s.studentId === studentId);
  const skipped = mine.filter((s) => s.status === "SKIPPED" && s.lessonType === "REGULAR");
  const adjustments = state.makeupAdjustments.filter((a) => a.studentId === studentId);
  const makeups = mine.filter((s) => s.lessonType === "MAKEUP");
  const confirmed = makeups.filter((s) => s.status === "CONFIRMED" || s.status === "PENDING_CHANGE");
  // 변경 요청 중인 보강은 기존 시간 하나만 센다
  const targets = new Set(
    state.requests.filter((r) => r.status === "PENDING" && r.kind === "CHANGE").map((r) => r.toSlotId),
  );
  const counted = confirmed.filter((s) => !targets.has(s.id));
  const done = counted.filter((s) => Date.parse(s.end) <= Date.parse(now)).length;
  const scheduled = counted.length - done;
  const requested = makeups.filter((s) => s.status === "PENDING_BOOKING").length;
  const owed = skipped.length + adjustments.reduce((sum, a) => sum + a.delta, 0);
  const holidayName = (s: LessonSlot) => (s.holidayName ? ` (${s.holidayName})` : "");
  const entries: MakeupEntry[] = [
    ...skipped.map((s) => ({
      at: s.start,
      delta: 1,
      label: `${SKIP_REASON_LABEL[s.skipReason ?? "HOLIDAY"]}${holidayName(s)}`,
      slotId: s.id,
    })),
    ...adjustments.map((a) => ({ at: a.createdAt, delta: a.delta, label: `강사 조정 · ${a.reason}` })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  return { owed, done, scheduled, requested, remaining: owed - done - scheduled, entries };
}

/* ------------------------------------------------------------------ */
/* 시간 경과 처리                                                       */
/* ------------------------------------------------------------------ */

/**
 * 시간이 지나 의미가 없어진 것들을 정리한다 (앱 시작 시와 주기적으로 호출).
 * - 응답 없이 해당 시간이 지난 요청 → EXPIRED (기존 레슨 유지, 대상 슬롯은 OPEN)
 * - 결정 없이 지나간 공휴일 레슨 → 휴강(SKIPPED) 처리
 * 바뀐 것이 없으면 같은 state 객체를 그대로 돌려준다.
 */
export function settle(state: LessonState, ctx: MachineContext): LessonState {
  const now = Date.parse(ctx.now());
  let next = state;
  for (const request of state.requests) {
    if (request.status !== "PENDING") continue;
    const times = [request.toSlotId, request.fromSlotId]
      .map((id) => next.slots.find((s) => s.id === id))
      .filter((s): s is LessonSlot => !!s)
      .map((s) => Date.parse(s.start));
    if (times.length > 0 && Math.min(...times) >= now) continue;
    const { slots, keepThreadId } = revert(next, request, ctx);
    next = {
      ...next,
      slots,
      requests: replaceRequest(next, { ...request, status: "EXPIRED", resolvedAt: ctx.now() }),
      comments: keepThreadId
        ? [
            ...next.comments,
            systemComment(ctx, keepThreadId, "응답 없이 시간이 지나 요청이 만료되었습니다."),
          ]
        : next.comments,
    };
  }
  const lapsed = next.slots.filter(
    (s) => s.status === "CONFIRMED" && s.holidayDecision === "UNDECIDED" && Date.parse(s.start) < now,
  );
  if (lapsed.length > 0) {
    next = {
      ...next,
      slots: replaceSlots(
        next,
        lapsed.map((s) => ({
          ...s,
          status: "SKIPPED",
          holidayDecision: "SKIP",
          skipReason: "HOLIDAY",
          requestId: undefined,
        })),
      ),
      comments: [
        ...next.comments,
        ...lapsed.map((s) =>
          systemComment(ctx, s.threadId, "결정 없이 공휴일이 지나 휴강으로 처리되었습니다. (보강 필요 1회)"),
        ),
      ],
    };
  }
  return next;
}

/* ------------------------------------------------------------------ */
/* 댓글                                                                 */
/* ------------------------------------------------------------------ */

export function addComment(
  state: LessonState,
  actor: Actor,
  slotId: string,
  body: string,
  ctx: MachineContext,
): LessonState {
  const slot = findSlot(state, slotId);
  const trimmed = body.trim();
  if (!trimmed) return state;
  if (slot.status === "OPEN")
    throw new LessonError("INVALID_STATE", "빈 슬롯에는 댓글을 남길 수 없습니다.");
  if (actor.role === "STUDENT" && slot.studentId !== actor.userId)
    throw new LessonError("FORBIDDEN", "본인 레슨에만 댓글을 남길 수 있습니다.");
  return {
    ...state,
    comments: [...state.comments, userComment(ctx, slot.threadId, actor, trimmed)],
  };
}

/* ------------------------------------------------------------------ */
/* 역할별 가시성 (마스킹)                                               */
/* ------------------------------------------------------------------ */

/**
 * 역할에 따라 화면에 내려줄 슬롯 목록을 만든다.
 * 레슨생에게 다른 레슨생의 슬롯은 '마감됨'으로 마스킹되고 studentId/요청/스레드 정보가 제거된다.
 */
export function getSlotViews(state: LessonState, actor: Actor): SlotView[] {
  const requests = new Map(state.requests.map((r) => [r.id, r]));

  // 정규 레슨의 월별 회차 (레슨생·달 단위, 휴강과 변경 희망 시간은 제외)
  const seq = new Map<string, { n: number; total: number }>();
  const groups = new Map<string, LessonSlot[]>();
  for (const slot of state.slots) {
    if (!slot.studentId || slot.lessonType !== "REGULAR" || slot.status === "SKIPPED") continue;
    if (slot.status === "PENDING_CHANGE" && requests.get(slot.requestId ?? "")?.toSlotId === slot.id)
      continue;
    const d = new Date(slot.start);
    // 회차는 수강 등록 단위로 센다 (재등록하면 새로 1부터)
    const key = `${slot.enrollmentId ?? slot.studentId}:${d.getFullYear()}-${d.getMonth()}`;
    const list = groups.get(key);
    if (list) list.push(slot);
    else groups.set(key, [slot]);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => a.start.localeCompare(b.start));
    list.forEach((slot, i) => seq.set(slot.id, { n: i + 1, total: list.length }));
  }

  const views: SlotView[] = [];
  for (const slot of state.slots) {
    const mine = actor.role === "STUDENT" && slot.studentId === actor.userId;
    if (actor.role === "STUDENT" && slot.status !== "OPEN" && !mine) {
      // 다른 레슨생의 휴강 기록은 시간이 비어 있으므로 아예 보이지 않는다
      if (slot.status === "SKIPPED") continue;
      views.push({
        slot: {
          id: slot.id,
          start: slot.start,
          end: slot.end,
          status: "CONFIRMED",
          threadId: "",
        },
        display: "CLOSED",
        masked: true,
        mine: false,
      });
      continue;
    }
    const request = slot.requestId ? requests.get(slot.requestId) : undefined;
    let display: SlotView["display"];
    if (slot.status === "PENDING_CHANGE") {
      display = request?.fromSlotId === slot.id ? "PENDING_CHANGE_FROM" : "PENDING_CHANGE_TO";
    } else if (slot.status === "CONFIRMED" && request?.kind === "DEFER") {
      display = "PENDING_DEFER";
    } else if (slot.status === "CONFIRMED" && slot.holidayDecision === "UNDECIDED") {
      display = "HOLIDAY_DECISION";
    } else {
      display = slot.status;
    }
    views.push({ slot, display, masked: false, mine, request, seq: seq.get(slot.id) });
  }
  return views;
}
