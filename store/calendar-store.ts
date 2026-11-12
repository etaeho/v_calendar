"use client";

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
  rejectRequest,
  requestBooking,
  requestChange,
  requestChangeToNewTime,
  type MachineContext,
} from "@/lib/lesson-machine";
import { createInitialLessonState, INSTRUCTOR, ME_STUDENT } from "@/lib/mock-data";
import { calendarSyncServices } from "@/lib/services/calendar-sync";
import type {
  Actor,
  CalendarCategory,
  CalendarViewMode,
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
}

let seq = 0;
const ctx: MachineContext = {
  now: () => new Date().toISOString(),
  id: (prefix) => `${prefix}-${Date.now().toString(36)}-${++seq}`,
};

export const userForRole = (role: UserRole): User =>
  role === "INSTRUCTOR" ? INSTRUCTOR : ME_STUDENT;

export const actorForRole = (role: UserRole): Actor => ({
  userId: userForRole(role).id,
  role,
});

export const syncKey = (userId: string, provider: ExternalProvider) => `${userId}:${provider}`;

const emptyLesson: LessonState = { slots: [], requests: [], comments: [] };

export const useCalendarStore = create<CalendarStore>((set, get) => {
  const toast = (kind: Toast["kind"], message: string) =>
    set({ toast: { id: ++seq, kind, message } });

  /** 상태 머신 전이를 실행하고, 도메인 오류는 토스트로 보여준다 */
  const transition = (
    fn: (state: LessonState, actor: Actor) => LessonState,
    success?: string,
  ): boolean => {
    try {
      const lesson = fn(get().lesson, actorForRole(get().role));
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
        lesson: createInitialLessonState(now),
      });
    },

    tick: () => set({ now: new Date().toISOString() }),

    resetDemo: () => {
      const now = new Date();
      set({
        lesson: createInitialLessonState(now),
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
      set({ role, drawer: keep ? drawer : { type: "closed" } });
    },
    setView: (view) => set({ view }),
    setCursor: (date) => set({ cursor: date.toISOString() }),
    toggleFilter: (id) => set((s) => ({ filters: { ...s.filters, [id]: !s.filters[id] } })),
    setAllFilters: (on) => set({ filters: { LESSON: on, GOOGLE: on, KAKAO: on } }),
    openDrawer: (drawer) => set({ drawer }),
    closeDrawer: () => set({ drawer: { type: "closed" } }),
    dismissToast: () => set({ toast: null }),

    syncCalendar: async (provider) => {
      const userId = userForRole(get().role).id;
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
      const { lesson, role, now } = get();
      const plan = planDrop(lesson, actorForRole(role), slotId, start.toISOString(), now);
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
        "승인했습니다. 레슨이 확정되었습니다.",
      );
      if (ok && request) {
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
  };

  /** 거절/취소 후: 대상 슬롯을 보고 있었다면 유지되는 기존 레슨으로 이동 */
  function afterRevert(kind: string, fromSlotId: string | undefined, toSlotId: string) {
    const { drawer } = get();
    if (kind === "CHANGE" && fromSlotId && drawer.type === "slot" && drawer.slotId === toSlotId) {
      set({ drawer: { type: "slot", slotId: fromSlotId } });
    }
  }
});
