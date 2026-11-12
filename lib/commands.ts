/**
 * 명령(Command) 계층.
 *
 * 화면의 모든 동작을 JSON 으로 직렬화할 수 있는 명령으로 표현하고, 같은 상태 머신 함수로 실행한다.
 * - 데모 모드: 브라우저 메모리의 상태에 바로 실행
 * - 서버 모드: 같은 명령을 서버(Supabase Edge Function)로 보내, 서버가 같은 코드로 실행
 * 그래서 규칙(권한·겹침·마감 등)은 한 곳(lesson-machine / enrollment)에만 있다.
 */
import type { Actor, Enrollment, LessonState, WeeklyTime } from "../types/calendar";
import {
  addComment,
  adjustMakeup,
  approveRequest,
  cancelRequest,
  createOpenSlot,
  deleteOpenSlot,
  moveOpenSlot,
  proposeDefer,
  proposeHoliday,
  proposeMakeup,
  rejectRequest,
  requestBooking,
  requestChange,
  requestChangeToNewTime,
  restoreMissed,
  type MachineContext,
} from "./lesson-machine.ts";
import {
  approveScheduleRequest,
  endEnrollment,
  extendEnrollment,
  registerEnrollment,
  requestScheduleChange,
  updateEnrollmentTerms,
  type EnrollmentInput,
  type GenerationConflict,
  type HolidayLookup,
} from "./enrollment.ts";

type Range = { start: string; end: string };

export type Command =
  | ({ type: "createOpenSlot" } & Range)
  | { type: "deleteOpenSlot"; slotId: string }
  | ({ type: "moveOpenSlot"; slotId: string } & Range)
  | { type: "requestBooking"; slotId: string; message?: string }
  | { type: "requestChange"; fromSlotId: string; toSlotId: string; message?: string }
  | ({ type: "requestChangeToNewTime"; fromSlotId: string; message?: string } & Range)
  | { type: "approve"; requestId: string }
  | { type: "reject"; requestId: string; reason?: string }
  | { type: "cancel"; requestId: string }
  | { type: "addComment"; slotId: string; body: string }
  | { type: "proposeHoliday"; slotId: string; proposal: "PROCEED" | "SKIP"; message?: string }
  | { type: "proposeDefer"; slotId: string; message?: string }
  | { type: "proposeMakeup"; slotId: string; studentId: string; message?: string }
  | { type: "adjustMakeup"; studentId: string; delta: number; reason: string }
  | { type: "restoreMissed"; slotId: string }
  | { type: "registerEnrollment"; input: EnrollmentInput }
  | {
      type: "updateEnrollmentTerms";
      id: string;
      terms: Pick<Enrollment, "changeDeadlineHours" | "fee" | "paymentDay">;
    }
  | { type: "extendEnrollment"; id: string; newEndDate: string }
  | { type: "endEnrollment"; id: string; endDate: string }
  | {
      type: "requestScheduleChange";
      enrollmentId: string;
      schedule: { times: WeeklyTime[]; weeks: number[] };
      fromDate: string;
      message?: string;
    };

export interface CommandResult {
  state: LessonState;
  /** 수강 등록·연장·고정 시간 변경으로 만들어진 정규 레슨 수 */
  created?: number;
  /** 다른 레슨과 겹쳐 '미배정'이 된 레슨 */
  conflicts?: GenerationConflict[];
  /** 종료로 삭제된 레슨 수 */
  removed?: number;
  /** 새로 만든 슬롯 id (createOpenSlot) */
  slotId?: string;
}

/** 명령 하나를 실행한다. 규칙 위반은 LessonError 를 던진다 (상태는 바뀌지 않음) */
export function runCommand(
  state: LessonState,
  actor: Actor,
  cmd: Command,
  ctx: MachineContext,
  holiday: HolidayLookup,
): CommandResult {
  switch (cmd.type) {
    case "createOpenSlot": {
      const r = createOpenSlot(state, actor, cmd, ctx);
      return { state: r.state, slotId: r.slot.id };
    }
    case "deleteOpenSlot":
      return { state: deleteOpenSlot(state, actor, cmd.slotId) };
    case "moveOpenSlot":
      return { state: moveOpenSlot(state, actor, cmd.slotId, cmd) };
    case "requestBooking":
      return { state: requestBooking(state, actor, cmd.slotId, ctx, cmd.message) };
    case "requestChange":
      return { state: requestChange(state, actor, cmd.fromSlotId, cmd.toSlotId, ctx, cmd.message) };
    case "requestChangeToNewTime":
      return {
        state: requestChangeToNewTime(state, actor, cmd.fromSlotId, cmd, ctx, cmd.message),
      };
    case "approve": {
      const request = state.requests.find((r) => r.id === cmd.requestId);
      if (request?.kind === "SCHEDULE") return approveScheduleRequest(state, actor, cmd.requestId, ctx, holiday);
      return { state: approveRequest(state, actor, cmd.requestId, ctx) };
    }
    case "reject":
      return { state: rejectRequest(state, actor, cmd.requestId, ctx, cmd.reason) };
    case "cancel":
      return { state: cancelRequest(state, actor, cmd.requestId, ctx) };
    case "addComment":
      return { state: addComment(state, actor, cmd.slotId, cmd.body, ctx) };
    case "proposeHoliday":
      return { state: proposeHoliday(state, actor, cmd.slotId, cmd.proposal, ctx, cmd.message) };
    case "proposeDefer":
      return { state: proposeDefer(state, actor, cmd.slotId, ctx, cmd.message) };
    case "proposeMakeup":
      return { state: proposeMakeup(state, actor, cmd.slotId, cmd.studentId, ctx, cmd.message) };
    case "adjustMakeup":
      return { state: adjustMakeup(state, actor, cmd.studentId, cmd.delta, cmd.reason, ctx) };
    case "restoreMissed":
      return { state: restoreMissed(state, actor, cmd.slotId, ctx) };
    case "registerEnrollment": {
      const r = registerEnrollment(state, actor, cmd.input, ctx, holiday);
      return { state: r.state, created: r.created, conflicts: r.conflicts };
    }
    case "updateEnrollmentTerms":
      return { state: updateEnrollmentTerms(state, actor, cmd.id, cmd.terms) };
    case "extendEnrollment":
      return extendEnrollment(state, actor, cmd.id, cmd.newEndDate, ctx, holiday);
    case "endEnrollment":
      return endEnrollment(state, actor, cmd.id, cmd.endDate, ctx);
    case "requestScheduleChange":
      return {
        state: requestScheduleChange(state, actor, cmd.enrollmentId, cmd.schedule, cmd.fromDate, ctx, cmd.message),
      };
  }
}
