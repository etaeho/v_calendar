"use client";

import { format, formatDistanceStrict, isSameDay } from "date-fns";
import { ko } from "date-fns/locale";
import { useMemo } from "react";
import { getSlotViews, overlaps } from "@/lib/lesson-machine";
import { userName } from "@/lib/mock-data";
import { useActor, useCalendarStore } from "@/store/calendar-store";
import type { ExternalEvent, SlotDisplay, SlotView, UserRole } from "@/types/calendar";

export type CalendarItem =
  | { kind: "slot"; id: string; start: Date; end: Date; view: SlotView }
  | { kind: "external"; id: string; start: Date; end: Date; event: ExternalEvent };

export const fmtTime = (d: Date | string) => format(new Date(d), "HH:mm");
export const fmtDay = (d: Date | string) => format(new Date(d), "M월 d일 (EEE)", { locale: ko });
export const fmtDateTime = (d: Date | string) =>
  format(new Date(d), "M월 d일 (EEE) HH:mm", { locale: ko });
/** "3시간 전" 형식 */
export const timeAgo = (iso: string, now: string) =>
  `${formatDistanceStrict(new Date(iso), new Date(now), { locale: ko })} 전`;
export const fmtRange = (start: Date | string, end: Date | string) =>
  `${fmtDay(start)} ${fmtTime(start)} – ${fmtTime(end)}`;

/** 현재 역할의 사용자에게 보이는 슬롯(마스킹 적용) */
export function useSlotViews(): SlotView[] {
  const lesson = useCalendarStore((s) => s.lesson);
  const actor = useActor();
  return useMemo(() => getSlotViews(lesson, actor), [lesson, actor]);
}

/** 현재 사용자의 (동기화된) 외부 캘린더 일정 */
export function useMyExternalEvents(): ExternalEvent[] {
  const events = useCalendarStore((s) => s.externalEvents);
  const { userId } = useActor();
  return useMemo(() => events.filter((e) => e.ownerId === userId), [events, userId]);
}

/** 필터가 적용된, 달력에 그릴 전체 항목 (시작 시간순) */
export function useCalendarItems(): CalendarItem[] {
  const views = useSlotViews();
  const external = useMyExternalEvents();
  const filters = useCalendarStore((s) => s.filters);
  return useMemo(() => {
    const items: CalendarItem[] = [];
    if (filters.LESSON) {
      for (const view of views) {
        items.push({
          kind: "slot",
          id: view.slot.id,
          start: new Date(view.slot.start),
          end: new Date(view.slot.end),
          view,
        });
      }
    }
    for (const event of external) {
      if (!filters[event.provider]) continue;
      items.push({
        kind: "external",
        id: event.id,
        start: new Date(event.start),
        end: new Date(event.end),
        event,
      });
    }
    return items.sort((a, b) => a.start.getTime() - b.start.getTime());
  }, [views, external, filters]);
}

export const itemsOnDay = (items: CalendarItem[], day: Date) =>
  items.filter((i) => isSameDay(i.start, day));

/** 슬롯과 시간이 겹치는 내 개인 일정 */
export const conflictsFor = (
  slot: { start: string; end: string },
  events: ExternalEvent[],
) => events.filter((e) => overlaps(slot.start, slot.end, e.start, e.end));

/** 강조 표시할 슬롯 id (선택된 슬롯, 변경 요청으로 연결된 기존/대상 슬롯) */
export function useLinkedSlotIds(): Set<string> {
  const drawer = useCalendarStore((s) => s.drawer);
  const lesson = useCalendarStore((s) => s.lesson);
  return useMemo(() => {
    const ids = new Set<string>();
    if (drawer.type === "reschedule") {
      ids.add(drawer.fromSlotId);
      if (drawer.toSlotId) ids.add(drawer.toSlotId);
    } else if (drawer.type === "slot") {
      ids.add(drawer.slotId);
      const slot = lesson.slots.find((s) => s.id === drawer.slotId);
      const request = lesson.requests.find((r) => r.id === slot?.requestId);
      if (request?.fromSlotId) ids.add(request.fromSlotId);
      if (request) ids.add(request.toSlotId);
    } else if (drawer.type === "external") {
      ids.add(drawer.eventId);
    }
    return ids;
  }, [drawer, lesson]);
}

/** 항목 클릭 동작. 변경 대상 선택 모드에서는 빈 슬롯 클릭이 '대상 지정'이 된다 */
export function useItemClick() {
  const drawerType = useCalendarStore((s) => s.drawer.type);
  const openDrawer = useCalendarStore((s) => s.openDrawer);
  const pickRescheduleTarget = useCalendarStore((s) => s.pickRescheduleTarget);
  return (item: CalendarItem) => {
    if (item.kind === "external") {
      openDrawer({ type: "external", eventId: item.id });
    } else if (drawerType === "reschedule" && item.view.display === "OPEN") {
      pickRescheduleTarget(item.id);
    } else {
      openDrawer({ type: "slot", slotId: item.id });
    }
  };
}

/* ------------------------------------------------------------------ */
/* 표시 스타일 / 라벨                                                   */
/* ------------------------------------------------------------------ */

/**
 * 레슨 상태는 4가지로만 구분한다 (+ 레슨생 화면의 '마감됨').
 * - 가능: 비어 있는 테두리만
 * - 확정: 꽉 찬 고정 색
 * - 승인 대기: 진한 노랑 + 깜빡이는 표시로 눈에 띄게
 * - 변경 요청: 움직이는 점선 (기존 시간·희망 시간 모두)
 */
export const SLOT_STYLES: Record<SlotDisplay, string> = {
  OPEN: "border border-mint-500 bg-white text-mint-700",
  CONFIRMED: "border border-mint-700 bg-mint-600 text-white",
  PENDING_BOOKING: "border-2 border-amber-600 bg-amber-300 text-amber-950 animate-pending",
  PENDING_CHANGE_FROM: "border-marching bg-violet-100 text-violet-950",
  PENDING_CHANGE_TO: "border-marching bg-white text-violet-900",
  // 공휴일 결정 필요: 승인 대기와 같은 노랑 계열 (태그로 구분)
  HOLIDAY_DECISION: "border-2 border-amber-600 bg-amber-300 text-amber-950 animate-pending",
  SKIPPED: "border border-dashed border-zinc-300 bg-zinc-50 text-zinc-500 line-through",
  CLOSED: "border border-zinc-200 bg-closed-stripes text-zinc-500",
};

export const EXTERNAL_STYLES = {
  GOOGLE: "border border-blue-300 border-l-4 border-l-blue-600 bg-blue-50 text-blue-900",
  KAKAO: "border border-coral-300 border-l-4 border-l-coral-600 bg-coral-50 text-coral-800",
} as const;

/** 드래그로 옮길 수 있는 일정인가 (빈 슬롯: 강사 / 확정 레슨: 강사 또는 본인) */
export function canDrag(item: CalendarItem, role: UserRole): boolean {
  if (item.kind !== "slot" || item.view.masked) return false;
  if (item.view.display === "OPEN") return role === "INSTRUCTOR";
  if (item.view.display === "CONFIRMED" || item.view.display === "HOLIDAY_DECISION")
    return !item.view.slot.requestId && (role === "INSTRUCTOR" || item.view.mine);
  return false;
}

export const STATUS_LABEL: Record<SlotDisplay, string> = {
  OPEN: "가능",
  CONFIRMED: "확정",
  PENDING_BOOKING: "승인 대기",
  PENDING_CHANGE_FROM: "변경 요청 · 기존 시간",
  PENDING_CHANGE_TO: "변경 요청 · 희망 시간",
  HOLIDAY_DECISION: "공휴일 · 결정 필요",
  SKIPPED: "휴강",
  CLOSED: "마감",
};

/** 달력 배지에 표시할 짧은 제목 */
export function slotTitle(view: SlotView, role: UserRole): string {
  const makeup = view.slot.lessonType === "MAKEUP";
  // 강사가 먼저 제안한 변경은 '요청'이 아니라 '제안'으로 표시한다
  const proposedByInstructor = view.request?.requestedBy === "INSTRUCTOR";
  // 정규 레슨 회차 (예: 3/4)
  const seq = view.seq ? ` ${view.seq.n}/${view.seq.total}` : "";
  const holiday = view.slot.holidayName ?? "공휴일";
  if (role === "INSTRUCTOR") {
    const name = userName(view.slot.studentId);
    switch (view.display) {
      case "OPEN":
        return "빈 슬롯";
      case "CONFIRMED":
        return `${name} ${makeup ? "보강" : `레슨${seq}`}`;
      case "HOLIDAY_DECISION":
        return `${name} · ${holiday} 결정 필요`;
      case "SKIPPED":
        return `${name} 휴강 (${holiday})`;
      case "PENDING_BOOKING":
        return `${name} 보강 신청`;
      case "PENDING_CHANGE_FROM":
        return proposedByInstructor ? `${name} 변경 제안` : `${name} 변경 요청`;
      case "PENDING_CHANGE_TO":
        return proposedByInstructor ? `${name} 제안한 시간` : `${name} 변경 희망`;
      default:
        return "마감됨";
    }
  }
  switch (view.display) {
    case "OPEN":
      return "신청 가능";
    case "CONFIRMED":
      return makeup ? "내 보강 레슨" : `내 레슨${seq}`;
    case "HOLIDAY_DECISION":
      return `${holiday} 레슨 결정 필요`;
    case "SKIPPED":
      return `휴강 (${holiday})`;
    case "PENDING_BOOKING":
      return "보강 승인 대기";
    case "PENDING_CHANGE_FROM":
      return proposedByInstructor ? "변경 제안 도착" : "변경 요청 중";
    case "PENDING_CHANGE_TO":
      return proposedByInstructor ? "제안받은 시간" : "변경 희망 시간";
    default:
      return "마감됨";
  }
}

export const itemTitle = (item: CalendarItem, role: UserRole) =>
  item.kind === "external" ? item.event.title : slotTitle(item.view, role);

export const itemClass = (item: CalendarItem) =>
  item.kind === "external" ? EXTERNAL_STYLES[item.event.provider] : SLOT_STYLES[item.view.display];

/** 요청 종류 이름 */
export const requestKindLabel = (r: { kind: string }) =>
  r.kind === "BOOKING" ? "보강 신청" : r.kind === "HOLIDAY" ? "공휴일 결정" : "일정 변경";

export const REQUEST_KIND_CHIP: Record<string, string> = {
  BOOKING: "bg-amber-200 text-amber-950",
  CHANGE: "bg-violet-100 text-violet-900",
  HOLIDAY: "bg-red-100 text-red-800",
};

export const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;
