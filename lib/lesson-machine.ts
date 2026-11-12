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
  LessonSlot,
  LessonState,
  ScheduleRequest,
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
  if (state.slots.some((s) => overlaps(s.start, s.end, range.start, range.end)))
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
  if (state.slots.some((s) => s.id !== slotId && overlaps(s.start, s.end, range.start, range.end)))
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
    slots: replaceSlots(state, [next]),
    requests: [...state.requests, request],
    comments: [
      ...state.comments,
      systemComment(ctx, slot.threadId, "보강 신청이 접수되었습니다. 강사 승인을 기다리는 중입니다."),
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
  if (actor.role === "STUDENT" && from.studentId !== actor.userId)
    throw new LessonError("FORBIDDEN", "본인의 레슨만 변경 요청할 수 있습니다.");
  if (to.status !== "OPEN")
    throw new LessonError("INVALID_STATE", "변경 대상은 빈 슬롯이어야 합니다.");
  if (Date.parse(from.end) <= Date.parse(ctx.now()))
    throw new LessonError("INVALID_STATE", "이미 끝난 레슨은 변경할 수 없습니다.");
  if (isPast(to.start, ctx))
    throw new LessonError("INVALID_STATE", "지난 시간으로는 옮길 수 없습니다.");

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
    slots: replaceSlots(state, [
      { ...from, status: "PENDING_CHANGE", requestId: request.id },
      {
        ...to,
        status: "PENDING_CHANGE",
        studentId: from.studentId,
        lessonType: from.lessonType,
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
  const others = state.slots.filter((s) => s.id !== slotId);

  if (slot.status === "OPEN") {
    if (actor.role !== "INSTRUCTOR") return invalid("빈 슬롯은 강사만 옮길 수 있습니다.");
    if (Date.parse(start) < Date.parse(now)) return invalid("지난 시간으로는 옮길 수 없습니다.");
    if (others.some((s) => overlaps(s.start, s.end, start, end)))
      return invalid("다른 레슨/슬롯과 겹칩니다.");
    return { kind: "move", start, end };
  }

  const canChange =
    slot.status === "CONFIRMED" &&
    !!slot.studentId &&
    (actor.role === "INSTRUCTOR" || slot.studentId === actor.userId);
  if (canChange && Date.parse(slot.end) <= Date.parse(now))
    return invalid("이미 끝난 레슨은 옮길 수 없습니다.");
  if (!canChange) {
    return invalid(
      slot.status === "CONFIRMED" ? "본인 레슨만 옮길 수 있습니다." : "응답 대기 중인 일정은 옮길 수 없습니다.",
    );
  }

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
  const confirmed: LessonSlot = { ...to, status: "CONFIRMED", requestId: undefined };
  const changed: LessonSlot[] = [confirmed];
  let removeId: string | undefined;
  if (request.kind === "CHANGE") {
    // 대화 스레드는 새 슬롯(confirmed)이 이어받는다.
    // 레슨생이 요청한 변경: 기존 시간은 다시 빈 슬롯(OPEN)으로 연다.
    // 강사가 제안한 변경: 강사가 그 시간에 안 되는 경우이므로 기존 시간을 열지 않고 지운다.
    if (request.requestedBy === "STUDENT") changed.push(toOpen(ctx, findSlot(state, request.fromSlotId!)));
    else removeId = request.fromSlotId;
  }
  const who = actor.role === "INSTRUCTOR" ? "강사가" : "레슨생이";
  return {
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
          ? `${who} 보강 신청을 승인했습니다. 레슨이 확정되었습니다.`
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
  return {
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
            `${who} 일정 변경 요청을 거절했습니다. 기존 일정이 유지됩니다.${trimmed ? ` (사유: ${trimmed})` : ""}`,
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
    slots,
    requests: replaceRequest(state, {
      ...request,
      status: "CANCELLED",
      resolvedAt: ctx.now(),
    }),
    comments: keepThreadId
      ? [
          ...state.comments,
          systemComment(ctx, keepThreadId, "일정 변경 요청이 취소되었습니다. 기존 일정이 유지됩니다."),
        ]
      : state.comments,
  };
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
  return state.slots.map((slot): SlotView => {
    const mine = actor.role === "STUDENT" && slot.studentId === actor.userId;
    if (actor.role === "STUDENT" && slot.status !== "OPEN" && !mine) {
      return {
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
      };
    }
    const request = slot.requestId ? requests.get(slot.requestId) : undefined;
    let display: SlotView["display"];
    if (slot.status === "PENDING_CHANGE") {
      display = request?.fromSlotId === slot.id ? "PENDING_CHANGE_FROM" : "PENDING_CHANGE_TO";
    } else {
      display = slot.status;
    }
    return { slot, display, masked: false, mine, request };
  });
}
