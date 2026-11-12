"use client";

import { useMemo } from "react";
import { create } from "zustand";
import {
  addComment,
  approveRequest,
  cancelRequest,
  createOpenSlot,
  deleteOpenSlot,
  LessonError,
  moveOpenSlot,
  planDrop,
  proposeHoliday,
  rejectRequest,
  requestBooking,
  requestChange,
  requestChangeToNewTime,
  settle,
  type MachineContext,
} from "@/lib/lesson-machine";
import {
  changeEnrollmentSchedule,
  endEnrollment,
  extendEnrollment,
  markHolidays,
  registerEnrollment,
  updateEnrollmentTerms,
  type EnrollmentInput,
  type GenerationConflict,
  type HolidayLookup,
} from "@/lib/enrollment";
import { holidaysOn } from "@/lib/holidays";
import { createInitialLessonState, INSTRUCTOR, STUDENTS, USERS } from "@/lib/mock-data";
import { calendarSyncServices } from "@/lib/services/calendar-sync";
import type {
  Actor,
  CalendarCategory,
  CalendarViewMode,
  Enrollment,
  ExternalEvent,
  ExternalProvider,
  LessonState,
  User,
  UserRole,
} from "@/types/calendar";

export type DrawerState =
  | { type: "closed" }
  | { type: "day"; date: string }
  | { type: "slot"; slotId: string }
  | { type: "external"; eventId: string }
  /**
   * 일정 변경 대상 선택 모드.
   * toSlotId: 기존 빈 슬롯으로 변경 / toRange: (강사 드래그) 슬롯이 없는 새 시간으로 변경
   */
  | {
      type: "reschedule";
      fromSlotId: string;
      toSlotId?: string;
      toRange?: { start: string; end: string };
    };

export interface SyncState {
  status: "idle" | "syncing" | "synced" | "error";
  lastSyncedAt?: string;
}

export interface Toast {
  id: number;
  kind: "success" | "error" | "info";
  message: string;
}

interface CalendarStore {
  initialized: boolean;
  /** 현재 시각 (ISO). 렌더 순수성을 위해 스토어에서 주기적으로 갱신한다 */
  now: string;
  role: UserRole;
  /** 레슨생 모드에서 지금 행동하는 레슨생 (테스트베드: 5명 중 선택) */
  studentId: string;
  view: CalendarViewMode;
  /** 현재 보고 있는 기준 날짜 (ISO) */
  cursor: string;
  filters: Record<CalendarCategory, boolean>;
  lesson: LessonState;
  externalEvents: ExternalEvent[];
  /** `${userId}:${provider}` → 동기화 상태 */
  sync: Record<string, SyncState>;
  drawer: DrawerState;
  toast: Toast | null;

  init: () => void;
  tick: () => void;
  resetDemo: () => void;
  setRole: (role: UserRole) => void;
  setStudent: (studentId: string) => void;
  setView: (view: CalendarViewMode) => void;
  setCursor: (date: Date) => void;
  toggleFilter: (id: CalendarCategory) => void;
  setAllFilters: (on: boolean) => void;
  openDrawer: (drawer: DrawerState) => void;
  closeDrawer: () => void;
  dismissToast: () => void;

  syncCalendar: (provider: ExternalProvider) => Promise<void>;

  createSlot: (start: Date, end: Date) => string | null;
  deleteSlot: (slotId: string) => void;
  bookSlot: (slotId: string, message?: string) => void;
  startReschedule: (fromSlotId: string) => void;
  pickRescheduleTarget: (toSlotId: string) => void;
  submitReschedule: (message?: string) => void;
  /** 드래그 앤 드롭: 슬롯을 start 시각으로 옮긴다 (planDrop 결과에 따라 이동/변경 요청) */
  dropSlot: (slotId: string, start: Date) => void;
  approve: (requestId: string) => void;
  reject: (requestId: string, reason?: string) => void;
  cancel: (requestId: string) => void;
  comment: (slotId: string, body: string) => void;
  /** 공휴일 레슨: 그대로 진행 / 휴강 제안 */
  proposeHoliday: (slotId: string, proposal: "PROCEED" | "SKIP", message?: string) => void;

  /** 수강 등록 관리 (강사). 성공하면 true */
  registerEnrollment: (input: EnrollmentInput) => boolean;
  updateEnrollmentTerms: (
    id: string,
    terms: Pick<Enrollment, "changeDeadlineHours" | "fee" | "paymentDay">,
  ) => boolean;
  changeEnrollmentSchedule: (
    id: string,
    schedule: Pick<Enrollment, "times" | "weeks">,
    fromDate: string,
  ) => boolean;
  extendEnrollment: (id: string, newEndDate: string) => boolean;
  endEnrollment: (id: string, endDate: string) => boolean;
  /** 마지막 등록/연장에서 다른 일정과 겹쳐 만들지 못한 레슨 */
  conflicts: GenerationConflict[];
  clearConflicts: () => void;
}

/** 쉬는 공휴일이면 그 이름 */
const holidayLookup: HolidayLookup = (day) => holidaysOn(day).find((h) => h.dayOff)?.name;

let seq = 0;
const ctx: MachineContext = {
  now: () => new Date().toISOString(),
  id: (prefix) => `${prefix}-${Date.now().toString(36)}-${++seq}`,
};

/** 지금 화면을 보고 있는 사용자 */
export const currentUser = (role: UserRole, studentId: string): User =>
  role === "INSTRUCTOR" ? INSTRUCTOR : (USERS.find((u) => u.id === studentId) ?? STUDENTS[0]);

export const actorOf = (role: UserRole, studentId: string): Actor => ({
  userId: currentUser(role, studentId).id,
  role,
});

const actorFromState = (s: { role: UserRole; studentId: string }) => actorOf(s.role, s.studentId);

/** 컴포넌트용: 현재 행위자 (역할 + 사용자) */
export function useActor(): Actor {
  const role = useCalendarStore((s) => s.role);
  const studentId = useCalendarStore((s) => s.studentId);
  return useMemo(() => actorOf(role, studentId), [role, studentId]);
}

export const syncKey = (userId: string, provider: ExternalProvider) => `${userId}:${provider}`;

const emptyLesson: LessonState = { enrollments: [], slots: [], requests: [], comments: [] };

export const useCalendarStore = create<CalendarStore>((set, get) => {
  const toast = (kind: Toast["kind"], message: string) =>
    set({ toast: { id: ++seq, kind, message } });

  /** 상태 머신 전이를 실행하고, 도메인 오류는 토스트로 보여준다 */
  const transition = (
    fn: (state: LessonState, actor: Actor) => LessonState,
    success?: string,
  ): boolean => {
    try {
      const lesson = fn(get().lesson, actorFromState(get()));
      set({ lesson });
      if (success) toast("success", success);
      return true;
    } catch (e) {
      if (e instanceof LessonError) {
        toast("error", e.message);
        return false;
      }
      throw e;
    }
  };

  /** 레슨이 생성되는 등록 작업: 겹쳐서 못 만든 날이 있으면 따로 보여 준다 */
  const generateWith = (
    fn: (
      state: LessonState,
      actor: Actor,
    ) => { state: LessonState; created: number; conflicts: GenerationConflict[] },
    success: (created: number) => string,
  ): boolean => {
    let result: { created: number; conflicts: GenerationConflict[] } | undefined;
    const ok = transition((state, actor) => {
      const r = fn(state, actor);
      result = r;
      return r.state;
    });
    if (ok && result) {
      set({ conflicts: result.conflicts });
      toast(
        result.conflicts.length > 0 ? "info" : "success",
        success(result.created) +
          (result.conflicts.length > 0
            ? ` 다른 일정과 겹친 ${result.conflicts.length}건은 만들지 못했습니다.`
            : ""),
      );
    }
    return ok;
  };

  /** 확정된 레슨을 연결된 외부 캘린더에 Push (Phase 3 에서 실제 API 호출로 대체) */
  const pushConfirmed = (slotId: string) => {
    const slot = get().lesson.slots.find((s) => s.id === slotId);
    if (!slot || slot.status !== "CONFIRMED" || !slot.studentId) return;
    for (const userId of [INSTRUCTOR.id, slot.studentId]) {
      for (const service of Object.values(calendarSyncServices)) {
        void service.isConnected(userId).then((ok) => {
          if (ok) void service.pushLesson(userId, slot);
        });
      }
    }
  };

  return {
    initialized: false,
    now: "",
    role: "STUDENT",
    studentId: STUDENTS[0].id,
    view: "week",
    cursor: "",
    filters: { LESSON: true, GOOGLE: true, KAKAO: true },
    lesson: emptyLesson,
    externalEvents: [],
    sync: {},
    drawer: { type: "closed" },
    toast: null,

    init: () => {
      if (get().initialized) return;
      const now = new Date();
      set({
        initialized: true,
        now: now.toISOString(),
        cursor: now.toISOString(),
        lesson: settle(createInitialLessonState(now, holidayLookup), ctx),
      });
    },

    tick: () => {
      const now = new Date().toISOString();
      // 시간이 지난 요청 만료, 미결정 공휴일 레슨 휴강 처리, 새로 지정된 공휴일 표시
      set((s) => ({ now, lesson: settle(markHolidays(s.lesson, holidayLookup, now), ctx) }));
    },

    resetDemo: () => {
      const now = new Date();
      set({
        lesson: settle(createInitialLessonState(now, holidayLookup), ctx),
        conflicts: [],
        externalEvents: [],
        sync: {},
        drawer: { type: "closed" },
        cursor: now.toISOString(),
      });
      toast("info", "데모 데이터를 초기 상태로 되돌렸습니다.");
    },

    setRole: (role) => {
      const { drawer } = get();
      // 선택 모드·개인 일정 상세는 역할이 바뀌면 의미가 없으므로 닫는다
      const keep = drawer.type === "slot" || drawer.type === "day";
      const view = role === "STUDENT" && get().view === "students" ? "week" : get().view;
      set({ role, view, toast: null, drawer: keep ? drawer : { type: "closed" } });
    },
    setStudent: (studentId) => {
      const { drawer } = get();
      const keep = drawer.type === "slot" || drawer.type === "day";
      const view = get().view === "students" ? "week" : get().view;
      set({ studentId, role: "STUDENT", view, toast: null, drawer: keep ? drawer : { type: "closed" } });
    },
    setView: (view) => set({ view }),
    setCursor: (date) => set({ cursor: date.toISOString() }),
    toggleFilter: (id) => set((s) => ({ filters: { ...s.filters, [id]: !s.filters[id] } })),
    setAllFilters: (on) => set({ filters: { LESSON: on, GOOGLE: on, KAKAO: on } }),
    openDrawer: (drawer) => set({ drawer }),
    closeDrawer: () => set({ drawer: { type: "closed" } }),
    dismissToast: () => set({ toast: null }),

    syncCalendar: async (provider) => {
      const userId = actorFromState(get()).userId;
      const key = syncKey(userId, provider);
      if (get().sync[key]?.status === "syncing") return;
      set((s) => ({ sync: { ...s.sync, [key]: { ...s.sync[key], status: "syncing" } } }));
      try {
        const events = await calendarSyncServices[provider].fetchEvents(userId);
        set((s) => ({
          externalEvents: [
            ...s.externalEvents.filter((e) => !(e.ownerId === userId && e.provider === provider)),
            ...events,
          ],
          sync: {
            ...s.sync,
            [key]: { status: "synced", lastSyncedAt: new Date().toISOString() },
          },
          filters: { ...s.filters, [provider]: true },
        }));
        toast(
          "success",
          `${provider === "GOOGLE" ? "구글" : "카카오"} 캘린더에서 일정 ${events.length}건을 불러왔습니다.`,
        );
      } catch {
        set((s) => ({ sync: { ...s.sync, [key]: { status: "error" } } }));
        toast("error", "동기화에 실패했습니다. 다시 시도해 주세요.");
      }
    },

    createSlot: (start, end) => {
      let createdId: string | null = null;
      transition((state, actor) => {
        const result = createOpenSlot(
          state,
          actor,
          { start: start.toISOString(), end: end.toISOString() },
          ctx,
        );
        createdId = result.slot.id;
        return result.state;
      }, "레슨 가능 슬롯을 열었습니다.");
      return createdId;
    },

    deleteSlot: (slotId) => {
      if (transition((s, a) => deleteOpenSlot(s, a, slotId), "슬롯을 삭제했습니다.")) {
        set({ drawer: { type: "closed" } });
      }
    },

    bookSlot: (slotId, message) => {
      transition(
        (s, a) => requestBooking(s, a, slotId, ctx, message),
        "보강을 신청했습니다. 강사 승인을 기다려 주세요.",
      );
    },

    startReschedule: (fromSlotId) => set({ drawer: { type: "reschedule", fromSlotId } }),

    pickRescheduleTarget: (toSlotId) => {
      const { drawer } = get();
      if (drawer.type !== "reschedule") return;
      const target = get().lesson.slots.find((s) => s.id === toSlotId);
      if (!target || target.status !== "OPEN" || toSlotId === drawer.fromSlotId) return;
      if (Date.parse(target.start) < Date.parse(get().now)) {
        toast("error", "지난 시간으로는 옮길 수 없습니다.");
        return;
      }
      set({ drawer: { type: "reschedule", fromSlotId: drawer.fromSlotId, toSlotId } });
    },

    submitReschedule: (message) => {
      const { drawer } = get();
      if (drawer.type !== "reschedule") return;
      const { fromSlotId, toSlotId, toRange } = drawer;
      if (!toSlotId && !toRange) return;
      const ok = transition(
        (s, a) =>
          toRange
            ? requestChangeToNewTime(s, a, fromSlotId, toRange, ctx, message)
            : requestChange(s, a, fromSlotId, toSlotId!, ctx, message),
        "일정 변경을 요청했습니다. 상대방의 동의를 기다려 주세요.",
      );
      if (ok) set({ drawer: { type: "slot", slotId: fromSlotId } });
    },

    dropSlot: (slotId, start) => {
      const { lesson, now } = get();
      const plan = planDrop(lesson, actorFromState(get()), slotId, start.toISOString(), now);
      switch (plan.kind) {
        case "none":
          return;
        case "invalid":
          toast("error", plan.reason);
          return;
        case "move":
          if (transition((s, a) => moveOpenSlot(s, a, slotId, plan), "빈 슬롯을 옮겼습니다.")) {
            set({ drawer: { type: "slot", slotId } });
          }
          return;
        case "change":
          // 바로 보내지 않고 확인 화면(사유 입력)을 연다
          set({ drawer: { type: "reschedule", fromSlotId: slotId, toSlotId: plan.toSlotId } });
          return;
        case "change-new":
          set({
            drawer: {
              type: "reschedule",
              fromSlotId: slotId,
              toRange: { start: plan.start, end: plan.end },
            },
          });
          return;
      }
    },

    approve: (requestId) => {
      const request = get().lesson.requests.find((r) => r.id === requestId);
      const ok = transition(
        (s, a) => approveRequest(s, a, requestId, ctx),
        request?.kind === "HOLIDAY"
          ? request.holidayProposal === "SKIP"
            ? "동의했습니다. 이 날 레슨은 쉽니다(휴강)."
            : "동의했습니다. 공휴일이지만 레슨을 진행합니다."
          : get().role === "STUDENT"
            ? "동의했습니다. 새 시간으로 레슨이 확정되었습니다."
            : "승인했습니다. 레슨이 확정되었습니다.",
      );
      if (ok && request && request.kind !== "HOLIDAY") {
        pushConfirmed(request.toSlotId);
        // 변경 승인 시 기존 슬롯은 OPEN 이 되므로, 확정된 새 슬롯을 보여준다
        const { drawer } = get();
        if (drawer.type === "slot" && drawer.slotId === request.fromSlotId) {
          set({ drawer: { type: "slot", slotId: request.toSlotId } });
        }
      }
    },

    reject: (requestId, reason) => {
      const request = get().lesson.requests.find((r) => r.id === requestId);
      const ok = transition(
        (s, a) => rejectRequest(s, a, requestId, ctx, reason),
        "요청을 거절했습니다.",
      );
      if (ok && request) afterRevert(request.kind, request.fromSlotId, request.toSlotId);
    },

    cancel: (requestId) => {
      const request = get().lesson.requests.find((r) => r.id === requestId);
      const ok = transition(
        (s, a) => cancelRequest(s, a, requestId, ctx),
        "요청을 취소했습니다.",
      );
      if (ok && request) afterRevert(request.kind, request.fromSlotId, request.toSlotId);
    },

    comment: (slotId, body) => {
      transition((s, a) => addComment(s, a, slotId, body, ctx));
    },

    proposeHoliday: (slotId, proposal, message) => {
      transition(
        (s, a) => proposeHoliday(s, a, slotId, proposal, ctx, message),
        proposal === "SKIP"
          ? "휴강을 제안했습니다. 상대방의 동의를 기다려 주세요."
          : "그대로 진행을 제안했습니다. 상대방의 동의를 기다려 주세요.",
      );
    },

    conflicts: [],
    clearConflicts: () => set({ conflicts: [] }),

    registerEnrollment: (input) =>
      generateWith(
        (s, a) => registerEnrollment(s, a, input, ctx, holidayLookup),
        (n) => `수강 등록을 저장하고 정규 레슨 ${n}건을 만들었습니다.`,
      ),

    updateEnrollmentTerms: (id, terms) =>
      transition((s, a) => updateEnrollmentTerms(s, a, id, terms), "등록 조건을 수정했습니다."),

    changeEnrollmentSchedule: (id, schedule, fromDate) =>
      generateWith(
        (s, a) => changeEnrollmentSchedule(s, a, id, schedule, fromDate, ctx, holidayLookup),
        (n) => `고정 시간을 바꾸고 정규 레슨 ${n}건을 다시 만들었습니다.`,
      ),

    extendEnrollment: (id, newEndDate) =>
      generateWith(
        (s, a) => extendEnrollment(s, a, id, newEndDate, ctx, holidayLookup),
        (n) => `등록을 연장하고 정규 레슨 ${n}건을 추가했습니다.`,
      ),

    endEnrollment: (id, endDate) => {
      let removed = 0;
      const ok = transition((s, a) => {
        const r = endEnrollment(s, a, id, endDate, ctx);
        removed = r.removed;
        return r.state;
      });
      if (ok) {
        const { drawer, lesson } = get();
        // 보고 있던 레슨이 삭제됐으면 상세 창을 닫는다
        const gone =
          (drawer.type === "slot" && !lesson.slots.some((x) => x.id === drawer.slotId)) ||
          (drawer.type === "reschedule" && !lesson.slots.some((x) => x.id === drawer.fromSlotId));
        if (gone) set({ drawer: { type: "closed" } });
        toast("success", `${endDate}로 등록을 마무리하고 이후 레슨 ${removed}건을 삭제했습니다.`);
      }
      return ok;
    },
  };

  /** 거절/취소 후: 대상 슬롯을 보고 있었다면 유지되는 기존 레슨으로 이동 */
  function afterRevert(kind: string, fromSlotId: string | undefined, toSlotId: string) {
    const { drawer } = get();
    if (kind === "CHANGE" && fromSlotId && drawer.type === "slot" && drawer.slotId === toSlotId) {
      set({ drawer: { type: "slot", slotId: fromSlotId } });
    }
  }
});
