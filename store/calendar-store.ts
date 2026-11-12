"use client";

import { useMemo } from "react";
import { create } from "zustand";
import { runCommand, type Command, type CommandResult } from "@/lib/commands";
import { getDirectory, instructorOf, setDirectory, userName } from "@/lib/directory";
import { LessonError, planDrop, settle, type MachineContext } from "@/lib/lesson-machine";
import {
  markHolidays,
  type EnrollmentInput,
  type GenerationConflict,
  type HolidayLookup,
} from "@/lib/enrollment";
import { holidaysOn } from "@/lib/holidays";
import { createInitialLessonState, STUDENTS, USERS } from "@/lib/mock-data";
import { deriveNotifications, type AppNotification } from "@/lib/notifications";
import { RemoteApi, toUsers, type Me } from "@/lib/remote";
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
  /** time: 시간대를 눌러 연 경우 그 시각("HH:mm")으로 슬롯 열기 폼을 채운다 */
  | { type: "day"; date: string; time?: string }
  | { type: "slot"; slotId: string }
  | { type: "external"; eventId: string }
  | { type: "notifications" }
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
  /** 휴대폰 월간 화면에서 선택한 날 (그 날 일정 목록을 아래에 보여 준다) */
  selectedDate: string;
  selectDate: (date: Date) => void;
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
  /** 강사 화면: 이 레슨생의 일정만 강조 (null = 전체) */
  focusStudentId: string | null;
  setFocusStudent: (studentId: string | null) => void;
  /** 정규 레슨을 보강으로 미루기 요청 */
  proposeDefer: (slotId: string, message?: string) => void;
  /** 화면에서 바로 알림(토스트)을 띄운다 */
  notify: (kind: Toast["kind"], message: string) => void;
  /** 강사: 미배정 레슨을 원래 시간으로 다시 잡기 */
  restoreMissed: (slotId: string) => void;
  /** 일정 변경: 빈 슬롯이 아닌 시간을 직접 지정 (강사) */
  setRescheduleRange: (range: { start: string; end: string }) => void;
  /** 강사: 레슨생에게 보강 시간 제안 (레슨생 동의 필요) */
  proposeMakeup: (slotId: string, studentId: string, message?: string) => boolean;
  /** 강사: 보강 필요 횟수 조정 */
  adjustMakeup: (studentId: string, delta: number, reason: string) => boolean;
  /** 공휴일 레슨: 그대로 진행 / 휴강 제안 */
  proposeHoliday: (slotId: string, proposal: "PROCEED" | "SKIP", message?: string) => void;

  /** 고정 시간 변경 요청 (fromDate 레슨부터 일괄 변경, 상대방 동의 필요). 성공하면 true */
  requestScheduleChange: (
    enrollmentId: string,
    schedule: Pick<Enrollment, "times" | "weeks">,
    fromDate: string,
    message?: string,
  ) => boolean;
  /** 수강 등록 관리 (강사). 성공하면 true */
  registerEnrollment: (input: EnrollmentInput) => boolean;
  updateEnrollmentTerms: (
    id: string,
    terms: Pick<Enrollment, "changeDeadlineHours" | "fee" | "paymentDay">,
  ) => boolean;
  extendEnrollment: (id: string, newEndDate: string) => boolean;
  endEnrollment: (id: string, endDate: string) => boolean;
  /** 마지막 등록/연장에서 다른 일정과 겹쳐 만들지 못한 레슨 */
  conflicts: GenerationConflict[];
  clearConflicts: () => void;

  /** 사용자 목록 (데모: 테스트베드 / 서버: 회원) */
  members: User[];
  /** 알림 (데모: 브라우저에서 계산 / 서버: 서버에서 받아 옴) */
  notifications: AppNotification[];
  markNotificationsRead: () => void;

  /** 서버 모드 세션. null 이면 데모 모드 */
  session: Me | null;
  remoteVersion: number;
  /** 서버 모드 시작: 로그인한 사용자와 서버 상태를 불러와 화면을 바꾼다 */
  startRemote: (api: RemoteApi, me: Me) => Promise<void>;
  /** 실시간 알림을 받으면 서버 상태를 다시 불러온다 */
  refreshFromServer: () => Promise<void>;
  /** 강사: 레슨생 초대 (서버 모드) */
  inviteStudent: (name: string, email: string, phone?: string) => Promise<boolean>;
}

/** 서버 모드 API (startRemote 에서 설정) */
let remote: RemoteApi | null = null;

/** 쉬는 공휴일이면 그 이름 */
const holidayLookup: HolidayLookup = (day) => holidaysOn(day).find((h) => h.dayOff)?.name;

let seq = 0;
const ctx: MachineContext = {
  now: () => new Date().toISOString(),
  id: (prefix) => `${prefix}-${Date.now().toString(36)}-${++seq}`,
};

/** 지금 화면을 보고 있는 사용자 */
export const currentUser = (role: UserRole, studentId: string): User =>
  role === "INSTRUCTOR"
    ? (instructorOf() ?? { id: "t1", name: "강사", role: "INSTRUCTOR" })
    : (getDirectory().find((u) => u.id === studentId) ?? { id: studentId, name: "", role: "STUDENT" });

export const actorOf = (role: UserRole, studentId: string): Actor => ({
  userId: currentUser(role, studentId).id,
  role,
});

const actorFromState = (s: { role: UserRole; studentId: string }) => actorOf(s.role, s.studentId);

/** 컴포넌트용: 현재 행위자 (역할 + 사용자) */
export function useActor(): Actor {
  const role = useCalendarStore((s) => s.role);
  const studentId = useCalendarStore((s) => s.studentId);
  const members = useCalendarStore((s) => s.members);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- members 가 바뀌면 강사 id 가 바뀔 수 있다
  return useMemo(() => actorOf(role, studentId), [role, studentId, members]);
}

/** 레슨생 목록 / 강사 */
export function useStudents(): User[] {
  const members = useCalendarStore((s) => s.members);
  return useMemo(() => members.filter((m) => m.role === "STUDENT"), [members]);
}
export function useInstructor(): User {
  const members = useCalendarStore((s) => s.members);
  return instructorOf(members) ?? { id: "t1", name: "강사", role: "INSTRUCTOR" };
}

export const syncKey = (userId: string, provider: ExternalProvider) => `${userId}:${provider}`;

const emptyLesson: LessonState = {
  enrollments: [],
  makeupAdjustments: [],
  slots: [],
  requests: [],
  comments: [],
};

export const useCalendarStore = create<CalendarStore>((set, get) => {
  const toast = (kind: Toast["kind"], message: string) =>
    set({ toast: { id: ++seq, kind, message } });

  /**
   * 명령 실행: 같은 상태 머신으로 화면에 바로 반영하고(데모·서버 공통),
   * 서버 모드면 같은 명령을 서버에 보내 서버 결과로 맞춘다. 규칙 위반은 토스트로 알린다.
   */
  const exec = (
    cmd: Command,
    success?: string | ((r: CommandResult) => string),
  ): CommandResult | null => {
    const before = get().lesson;
    const actor = actorFromState(get());
    let r: CommandResult;
    try {
      r = runCommand(before, actor, cmd, ctx, holidayLookup);
    } catch (e) {
      if (e instanceof LessonError) {
        toast("error", e.message);
        return null;
      }
      throw e;
    }
    const patch: Partial<CalendarStore> = { lesson: r.state };
    if (!remote) {
      // 데모 모드: 알림을 브라우저에서 계산 (서버 모드는 서버가 계산)
      const instructorId = instructorOf(get().members)?.id ?? "";
      patch.notifications = [
        ...get().notifications,
        ...deriveNotifications(before, r.state, actor, instructorId, userName, ctx.now(), ctx.id),
      ];
    }
    if (r.conflicts) patch.conflicts = r.conflicts;
    set(patch);
    const msg = typeof success === "function" ? success(r) : success;
    const missed = r.conflicts?.length ?? 0;
    if (msg)
      toast(
        missed > 0 ? "info" : "success",
        msg + (missed > 0 ? ` 다른 레슨과 겹친 ${missed}건은 '미배정'으로 기록했습니다 (보강 필요).` : ""),
      );
    if (remote) void sendRemote(cmd, r);
    return r;
  };

  /** 서버 모드: 명령을 서버에 보내고, 서버 상태로 맞춘다 (실패하면 서버 상태로 되돌리고 알림) */
  const sendRemote = async (cmd: Command, local: CommandResult) => {
    if (!remote) return;
    const res = await remote.command(cmd);
    if (!res.ok) {
      toast("error", res.error.message);
      await refreshRemote();
      return;
    }
    set({ lesson: res.state, remoteVersion: res.version });
    // 화면에서 연 새 슬롯은 서버가 만든 id 로 바꿔 준다
    const { drawer } = get();
    if (local.slotId && res.result.slotId && drawer.type === "slot" && drawer.slotId === local.slotId)
      set({ drawer: { type: "slot", slotId: res.result.slotId } });
    void loadRemoteNotifications();
  };

  const refreshRemote = async () => {
    if (!remote) return;
    const res = await remote.view();
    if (!res.ok) {
      toast("error", res.error.message);
      return;
    }
    const members = toUsers(res.members);
    setDirectory(members);
    set({ lesson: res.state, remoteVersion: res.version, members });
  };

  const loadRemoteNotifications = async () => {
    if (!remote) return;
    const res = await remote.notifications();
    if (res.ok) set({ notifications: res.notifications });
  };

  /** 레슨이 생성되는 등록 작업 */
  const generate = (cmd: Command, success: (created: number) => string): boolean =>
    !!exec(cmd, (r) => success(r.created ?? 0));

  /** 확정된 레슨을 연결된 외부 캘린더에 Push (Phase 3 에서 실제 API 호출로 대체) */
  const pushConfirmed = (slotId: string) => {
    const slot = get().lesson.slots.find((s) => s.id === slotId);
    if (!slot || slot.status !== "CONFIRMED" || !slot.studentId) return;
    for (const userId of [instructorOf(get().members)?.id ?? "", slot.studentId]) {
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
    selectedDate: "",
    selectDate: (date) => set({ selectedDate: date.toISOString(), cursor: date.toISOString() }),
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
        selectedDate: now.toISOString(),
        lesson: settle(createInitialLessonState(now, holidayLookup), ctx),
      });
    },

    tick: () => {
      const now = new Date().toISOString();
      // 시간이 지난 요청 만료, 미결정 공휴일 레슨 휴강 처리, 새로 지정된 공휴일 표시
      set((s) => ({
        now,
        lesson: settle(markHolidays(s.lesson, holidayLookup, now), ctx),
      }));
    },

    resetDemo: () => {
      const now = new Date();
      set({
        lesson: settle(createInitialLessonState(now, holidayLookup), ctx),
        conflicts: [],
        focusStudentId: null,
        externalEvents: [],
        sync: {},
        drawer: { type: "closed" },
        cursor: now.toISOString(),
        selectedDate: now.toISOString(),
      });
      toast("info", "데모 데이터를 초기 상태로 되돌렸습니다.");
    },

    setRole: (role) => {
      const { drawer } = get();
      // 선택 모드·개인 일정 상세는 역할이 바뀌면 의미가 없으므로 닫는다
      const keep = drawer.type === "slot" || drawer.type === "day";
      const current = get().view;
      // 역할에 없는 화면이면 달력으로 돌아간다 (레슨생 관리 = 강사 전용, 내 수강 = 레슨생 전용)
      const view =
        (role === "STUDENT" && current === "students") || (role === "INSTRUCTOR" && current === "plan")
          ? "month"
          : current;
      set({
        role,
        view,
        toast: null,
        focusStudentId: null,
        drawer: keep ? drawer : { type: "closed" },
      });
    },
    setStudent: (studentId) => {
      const { drawer } = get();
      const keep = drawer.type === "slot" || drawer.type === "day";
      const view = get().view === "students" ? "month" : get().view;
      set({
        studentId,
        role: "STUDENT",
        view,
        toast: null,
        drawer: keep ? drawer : { type: "closed" },
      });
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
      set((s) => ({
        sync: { ...s.sync, [key]: { ...s.sync[key], status: "syncing" } },
      }));
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
      const r = exec(
        { type: "createOpenSlot", start: start.toISOString(), end: end.toISOString() },
        "레슨 가능 슬롯을 열었습니다.",
      );
      return r?.slotId ?? null;
    },

    deleteSlot: (slotId) => {
      if (exec({ type: "deleteOpenSlot", slotId }, "슬롯을 삭제했습니다.")) {
        set({ drawer: { type: "closed" } });
      }
    },

    bookSlot: (slotId, message) => {
      exec({ type: "requestBooking", slotId, message }, "보강을 신청했습니다. 강사 승인을 기다려 주세요.");
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
      set({
        drawer: { type: "reschedule", fromSlotId: drawer.fromSlotId, toSlotId },
      });
    },

    submitReschedule: (message) => {
      const { drawer } = get();
      if (drawer.type !== "reschedule") return;
      const { fromSlotId, toSlotId, toRange } = drawer;
      if (!toSlotId && !toRange) return;
      const ok = exec(
        toRange
          ? { type: "requestChangeToNewTime", fromSlotId, ...toRange, message }
          : { type: "requestChange", fromSlotId, toSlotId: toSlotId!, message },
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
          if (
            exec({ type: "moveOpenSlot", slotId, start: plan.start, end: plan.end }, "빈 슬롯을 옮겼습니다.")
          ) {
            set({ drawer: { type: "slot", slotId } });
          }
          return;
        case "change":
          // 바로 보내지 않고 확인 화면(사유 입력)을 연다
          set({
            drawer: {
              type: "reschedule",
              fromSlotId: slotId,
              toSlotId: plan.toSlotId,
            },
          });
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
      if (request?.kind === "SCHEDULE") {
        const verb = get().role === "STUDENT" ? "동의했습니다" : "승인했습니다";
        const ok = generate(
          { type: "approve", requestId },
          (n) => `${verb}. 고정 시간이 바뀌어 정규 레슨 ${n}건을 새 시간으로 다시 만들었습니다.`,
        );
        if (ok) {
          // 보고 있던 기준 레슨은 새 시간 레슨으로 바뀌었으므로 새 첫 레슨을 보여 준다
          const updated = get().lesson.requests.find((r) => r.id === requestId);
          const { drawer, lesson } = get();
          if (drawer.type === "slot" && !lesson.slots.some((x) => x.id === drawer.slotId)) {
            set({ drawer: updated ? { type: "slot", slotId: updated.toSlotId } : { type: "closed" } });
          }
        }
        return;
      }
      const ok = exec(
        { type: "approve", requestId },
        request?.kind === "DEFER"
          ? "동의했습니다. 이 레슨은 보강으로 미뤘습니다 (보강 필요 1회)."
          : request?.kind === "HOLIDAY"
            ? request.holidayProposal === "SKIP"
              ? "동의했습니다. 이 날 레슨은 쉽니다(휴강)."
              : "동의했습니다. 공휴일이지만 레슨을 진행합니다."
            : get().role === "STUDENT"
              ? request?.kind === "BOOKING"
                ? "동의했습니다. 보강 레슨이 확정되었습니다."
                : "동의했습니다. 새 시간으로 레슨이 확정되었습니다."
              : "승인했습니다. 레슨이 확정되었습니다.",
      );
      if (ok && request && request.kind !== "HOLIDAY" && request.kind !== "DEFER") {
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
      const ok = exec({ type: "reject", requestId, reason }, "요청을 거절했습니다.");
      if (ok && request) afterRevert(request.kind, request.fromSlotId, request.toSlotId);
    },

    cancel: (requestId) => {
      const request = get().lesson.requests.find((r) => r.id === requestId);
      const ok = exec({ type: "cancel", requestId }, "요청을 취소했습니다.");
      if (ok && request) afterRevert(request.kind, request.fromSlotId, request.toSlotId);
    },

    comment: (slotId, body) => {
      exec({ type: "addComment", slotId, body });
    },

    proposeHoliday: (slotId, proposal, message) => {
      exec(
        { type: "proposeHoliday", slotId, proposal, message },
        proposal === "SKIP"
          ? "휴강을 제안했습니다. 상대방의 동의를 기다려 주세요."
          : "그대로 진행을 제안했습니다. 상대방의 동의를 기다려 주세요.",
      );
    },

    conflicts: [],
    clearConflicts: () => set({ conflicts: [] }),

    members: USERS,
    notifications: [],
    markNotificationsRead: () => {
      const me = actorFromState(get()).userId;
      const now = new Date().toISOString();
      const unread = get().notifications.filter((n) => n.recipient === me && !n.readAt);
      if (unread.length === 0) return;
      set({
        notifications: get().notifications.map((n) =>
          n.recipient === me && !n.readAt ? { ...n, readAt: now } : n,
        ),
      });
      if (remote) void remote.markRead(unread.map((n) => n.id));
    },

    session: null,
    remoteVersion: 0,
    startRemote: async (api, me) => {
      remote = api;
      set({
        session: me,
        role: me.role,
        studentId: me.role === "STUDENT" ? me.appKey : get().studentId,
        lesson: emptyLesson,
        notifications: [],
        externalEvents: [],
        drawer: { type: "closed" },
        view: me.role === "STUDENT" && get().view === "students" ? "month" : get().view,
      });
      await refreshRemote();
      await loadRemoteNotifications();
    },
    refreshFromServer: async () => {
      await refreshRemote();
      await loadRemoteNotifications();
    },
    inviteStudent: async (name, email, phone) => {
      if (!remote) return false;
      const res = await remote.addMember(name, email, phone);
      if (!res.ok) {
        toast("error", res.error.message);
        return false;
      }
      const members = toUsers(res.members);
      setDirectory(members);
      set({ members });
      toast("success", `${name} 님을 초대했습니다. ${email} 로 로그인하면 바로 연결됩니다.`);
      return true;
    },

    focusStudentId: null,
    setFocusStudent: (studentId) => set({ focusStudentId: studentId }),

    proposeDefer: (slotId, message) => {
      exec(
        { type: "proposeDefer", slotId, message },
        "보강으로 미루기를 요청했습니다. 상대방의 동의를 기다려 주세요.",
      );
    },

    notify: (kind, message) => toast(kind, message),

    restoreMissed: (slotId) => {
      exec({ type: "restoreMissed", slotId }, "원래 시간으로 레슨을 다시 잡았습니다.");
    },

    setRescheduleRange: (range) => {
      const { drawer, lesson, now } = get();
      if (drawer.type !== "reschedule") return;
      const plan = planDrop(lesson, actorFromState(get()), drawer.fromSlotId, range.start, now);
      if (plan.kind === "invalid") {
        toast("error", plan.reason);
        return;
      }
      if (plan.kind === "change") {
        set({ drawer: { type: "reschedule", fromSlotId: drawer.fromSlotId, toSlotId: plan.toSlotId } });
      } else if (plan.kind === "change-new") {
        set({
          drawer: {
            type: "reschedule",
            fromSlotId: drawer.fromSlotId,
            toRange: { start: plan.start, end: plan.end },
          },
        });
      }
    },

    proposeMakeup: (slotId, studentId, message) =>
      !!exec(
        { type: "proposeMakeup", slotId, studentId, message },
        "보강 시간을 제안했습니다. 레슨생의 동의를 기다려 주세요.",
      ),

    adjustMakeup: (studentId, delta, reason) =>
      !!exec(
        { type: "adjustMakeup", studentId, delta, reason },
        `보강 필요 횟수를 ${delta > 0 ? `${delta}회 늘렸습니다` : `${-delta}회 줄였습니다`}.`,
      ),

    requestScheduleChange: (enrollmentId, schedule, fromDate, message) =>
      !!exec(
        { type: "requestScheduleChange", enrollmentId, schedule, fromDate, message },
        get().role === "STUDENT"
          ? "고정 시간 변경을 요청했습니다. 강사가 승인하면 적용됩니다."
          : "고정 시간 변경을 요청했습니다. 레슨생이 동의하면 적용됩니다.",
      ),

    registerEnrollment: (input) =>
      generate(
        { type: "registerEnrollment", input },
        (n) => `수강 등록을 저장하고 정규 레슨 ${n}건을 만들었습니다.`,
      ),

    updateEnrollmentTerms: (id, terms) =>
      !!exec({ type: "updateEnrollmentTerms", id, terms }, "등록 조건을 수정했습니다."),

    extendEnrollment: (id, newEndDate) =>
      generate(
        { type: "extendEnrollment", id, newEndDate },
        (n) => `등록을 연장하고 정규 레슨 ${n}건을 추가했습니다.`,
      ),

    endEnrollment: (id, endDate) => {
      const r = exec({ type: "endEnrollment", id, endDate });
      const removed = r?.removed ?? 0;
      const ok = !!r;
      if (ok) {
        const { drawer, lesson } = get();
        // 보고 있던 레슨이 삭제됐으면 상세 창을 닫는다
        const gone =
          (drawer.type === "slot" && !lesson.slots.some((x) => x.id === drawer.slotId)) ||
          (drawer.type === "reschedule" && !lesson.slots.some((x) => x.id === drawer.fromSlotId));
        if (gone) set({ drawer: { type: "closed" } });
        const [, m, d] = endDate.split("-").map(Number);
        toast(
          "success",
          removed > 0
            ? `${m}월 ${d}일까지로 등록을 마무리했습니다. 이후 레슨 ${removed}건을 삭제했습니다.`
            : `${m}월 ${d}일까지로 등록을 마무리했습니다.`,
        );
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
