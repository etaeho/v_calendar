"use client";

import { format, isSameDay } from "date-fns";
import { ko } from "date-fns/locale";
import { useMemo } from "react";
import { getSlotViews, overlaps } from "@/lib/lesson-machine";
import { userName } from "@/lib/mock-data";
import { actorForRole, useCalendarStore } from "@/store/calendar-store";
import type { ExternalEvent, SlotDisplay, SlotView, UserRole } from "@/types/calendar";

export type CalendarItem =
  | { kind: "slot"; id: string; start: Date; end: Date; view: SlotView }
  | { kind: "external"; id: string; start: Date; end: Date; event: ExternalEvent };

export const fmtTime = (d: Date | string) => format(new Date(d), "HH:mm");
export const fmtDay = (d: Date | string) => format(new Date(d), "M월 d일 (EEE)", { locale: ko });
export const fmtDateTime = (d: Date | string) =>
  format(new Date(d), "M월 d일 (EEE) HH:mm", { locale: ko });
export const fmtRange = (start: Date | string, end: Date | string) =>
  `${fmtDay(start)} ${fmtTime(start)} – ${fmtTime(end)}`;

/** 현재 역할의 사용자에게 보이는 슬롯(마스킹 적용) */
export function useSlotViews(): SlotView[] {
  const lesson = useCalendarStore((s) => s.lesson);
  const role = useCalendarStore((s) => s.role);
  return useMemo(() => getSlotViews(lesson, actorForRole(role)), [lesson, role]);
}

/** 현재 사용자의 (동기화된) 외부 캘린더 일정 */
export function useMyExternalEvents(): ExternalEvent[] {
  const events = useCalendarStore((s) => s.externalEvents);
  const role = useCalendarStore((s) => s.role);
  return useMemo(() => {
    const userId = actorForRole(role).userId;
    return events.filter((e) => e.ownerId === userId);
  }, [events, role]);
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

export const SLOT_STYLES: Record<SlotDisplay, string> = {
  OPEN: "border border-dashed border-mint-500 bg-mint-50/80 text-mint-800",
  CONFIRMED: "border border-mint-600 bg-mint-600 text-white",
  PENDING_BOOKING: "border border-amber-400 bg-amber-100 text-amber-900",
  PENDING_CHANGE_FROM: "border border-violet-400 bg-violet-100 text-violet-900",
  PENDING_CHANGE_TO: "border border-dashed border-violet-500 bg-violet-50 text-violet-900",
  CLOSED: "border border-zinc-200 bg-closed-stripes text-zinc-500",
};

export const EXTERNAL_STYLES = {
  GOOGLE: "border border-blue-200 border-l-4 border-l-blue-500 bg-blue-50 text-blue-900",
  KAKAO: "border border-coral-200 border-l-4 border-l-coral-500 bg-coral-50 text-coral-800",
} as const;

export const STATUS_LABEL: Record<SlotDisplay, string> = {
  OPEN: "레슨 가능 (OPEN)",
  CONFIRMED: "확정 (CONFIRMED)",
  PENDING_BOOKING: "보강 승인 대기 (PENDING_BOOKING)",
  PENDING_CHANGE_FROM: "변경 요청 중 · 기존 일정 (PENDING_CHANGE)",
  PENDING_CHANGE_TO: "변경 요청 중 · 변경 희망 시간 (PENDING_CHANGE)",
  CLOSED: "마감됨",
};

/** 달력 배지에 표시할 짧은 제목 */
export function slotTitle(view: SlotView, role: UserRole): string {
  const makeup = view.slot.lessonType === "MAKEUP";
  if (role === "INSTRUCTOR") {
    const name = userName(view.slot.studentId);
    switch (view.display) {
      case "OPEN":
        return "빈 슬롯";
      case "CONFIRMED":
        return `${name} ${makeup ? "보강" : "레슨"}`;
      case "PENDING_BOOKING":
        return `${name} 보강 신청`;
      case "PENDING_CHANGE_FROM":
        return `${name} 변경 요청`;
      case "PENDING_CHANGE_TO":
        return `${name} 변경 희망`;
      default:
        return "마감됨";
    }
  }
  switch (view.display) {
    case "OPEN":
      return "신청 가능";
    case "CONFIRMED":
      return makeup ? "내 보강 레슨" : "내 레슨";
    case "PENDING_BOOKING":
      return "보강 승인 대기";
    case "PENDING_CHANGE_FROM":
      return "변경 요청 중";
    case "PENDING_CHANGE_TO":
      return "변경 희망 시간";
    default:
      return "마감됨";
  }
}

export const itemTitle = (item: CalendarItem, role: UserRole) =>
  item.kind === "external" ? item.event.title : slotTitle(item.view, role);

export const itemClass = (item: CalendarItem) =>
  item.kind === "external" ? EXTERNAL_STYLES[item.event.provider] : SLOT_STYLES[item.view.display];
