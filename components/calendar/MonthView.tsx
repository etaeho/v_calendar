"use client";

import {
  addMinutes,
  differenceInMinutes,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  isSameDay,
  isSameMonth,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import { useState } from "react";
import {
  canDrag,
  fmtTime,
  itemClass,
  itemsOnDay,
  isDimmed,
  itemTitle,
  useCalendarItems,
  useFocusStudent,
  useItemClick,
  useLinkedSlotIds,
} from "@/lib/calendar-items";
import { mainHoliday } from "@/lib/holidays";
import { planDrop } from "@/lib/lesson-machine";
import { cn } from "@/lib/utils";
import { useActor, useCalendarStore } from "@/store/calendar-store";

export const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
const MAX_CHIPS = 3;

export function MonthView() {
  const cursor = useCalendarStore((s) => s.cursor);
  const now = useCalendarStore((s) => s.now);
  const role = useCalendarStore((s) => s.role);
  const drawer = useCalendarStore((s) => s.drawer);
  const openDrawer = useCalendarStore((s) => s.openDrawer);
  const items = useCalendarItems();
  const linked = useLinkedSlotIds();
  const onItemClick = useItemClick();
  const focus = useFocusStudent();
  const dropSlot = useCalendarStore((s) => s.dropSlot);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overDay, setOverDay] = useState<string | null>(null);
  const lesson = useCalendarStore((s) => s.lesson);
  const actor = useActor();

  /** 다른 날로 옮겨도 시간은 그대로 둔다 */
  const dropStart = (itemId: string, day: Date) => {
    const item = items.find((i) => i.id === itemId);
    if (!item) return null;
    return addMinutes(startOfDay(day), differenceInMinutes(item.start, startOfDay(item.start)));
  };
  const overPlan = (() => {
    if (!dragId || !overDay) return null;
    const start = dropStart(dragId, new Date(overDay));
    return start ? planDrop(lesson, actor, dragId, start.toISOString(), now) : null;
  })();

  const month = new Date(cursor);
  const today = new Date(now);
  const days = eachDayOfInterval({
    start: startOfWeek(startOfMonth(month), { weekStartsOn: 0 }),
    end: endOfWeek(endOfMonth(month), { weekStartsOn: 0 }),
  });
  const picking = drawer.type === "reschedule";

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="sticky top-0 z-10 grid grid-cols-7 border-b border-zinc-200 bg-white">
        {WEEKDAYS.map((d, i) => (
          <div
            key={d}
            className={cn(
              "py-1.5 text-center text-xs font-medium",
              i === 0 ? "text-red-600" : i === 6 ? "text-blue-600" : "text-zinc-600",
            )}
          >
            {d}
          </div>
        ))}
      </div>
      <div
        className="grid flex-1 grid-cols-7"
        style={{ gridTemplateRows: `repeat(${days.length / 7}, minmax(6.5rem, 1fr))` }}
      >
        {days.map((day) => {
          const dayItems = itemsOnDay(items, day);
          const inMonth = isSameMonth(day, month);
          const isToday = isSameDay(day, today);
          const selected = drawer.type === "day" && isSameDay(new Date(drawer.date), day);
          const dow = day.getDay();
          const key = day.toISOString();
          const holiday = mainHoliday(day);
          const red = dow === 0 || holiday?.dayOff;
          return (
            <div
              key={key}
              onDragOver={(e) => {
                if (!dragId) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (overDay !== key) setOverDay(key);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setOverDay(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                const id = dragId;
                setDragId(null);
                setOverDay(null);
                const start = id ? dropStart(id, day) : null;
                if (id && start) dropSlot(id, start);
              }}
              className={cn(
                "relative min-w-0 border-r border-b border-zinc-200 p-1",
                !inMonth && "bg-zinc-50/70",
                selected && "bg-mint-50",
                overDay === key &&
                  (overPlan?.kind === "invalid"
                    ? "bg-red-50 outline-2 -outline-offset-2 outline-red-500 outline-dashed"
                    : "bg-violet-50 outline-2 -outline-offset-2 outline-violet-500 outline-dashed"),
              )}
            >
              <button
                type="button"
                aria-label={`${day.getMonth() + 1}월 ${day.getDate()}일 일정 보기`}
                onClick={() => openDrawer({ type: "day", date: day.toISOString() })}
                className="absolute inset-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-mint-600"
              />
              <div className="pointer-events-none relative mb-0.5 flex min-w-0 items-center justify-center gap-1 sm:justify-start">
                <span
                  className={cn(
                    "flex size-6 shrink-0 items-center justify-center rounded-full text-xs tabular-nums",
                    isToday
                      ? "bg-mint-600 font-bold text-white"
                      : !inMonth
                        ? red
                          ? "text-red-300"
                          : "text-zinc-400"
                        : red
                          ? "font-semibold text-red-600"
                          : dow === 6
                            ? "text-blue-600"
                            : "text-zinc-800",
                  )}
                >
                  {day.getDate()}
                </span>
                {holiday && (
                  <span
                    title={holiday.name}
                    className={cn(
                      "hidden min-w-0 truncate text-[11px] sm:inline",
                      holiday.dayOff ? "font-medium text-red-600" : "text-zinc-500",
                      !inMonth && "opacity-60",
                    )}
                  >
                    {holiday.name}
                  </span>
                )}
              </div>
              {overDay === key && overPlan?.kind === "invalid" && (
                <p className="pointer-events-none relative mb-0.5 rounded bg-red-600 px-1 text-[11px] leading-4 text-white">
                  {overPlan.reason}
                </p>
              )}
              <ul className="relative space-y-0.5">
                {dayItems.slice(0, MAX_CHIPS).map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      draggable={canDrag(item, role) && !picking}
                      onDragStart={(e) => {
                        e.dataTransfer.setData("text/plain", item.id);
                        e.dataTransfer.effectAllowed = "move";
                        setDragId(item.id);
                      }}
                      onDragEnd={() => {
                        setDragId(null);
                        setOverDay(null);
                      }}
                      onClick={() => onItemClick(item)}
                      title={`${fmtTime(item.start)} ${itemTitle(item, role)}`}
                      className={cn(
                        "block w-full truncate rounded px-1 py-px text-left text-[11px] leading-4.5",
                        itemClass(item, role),
                        isDimmed(item, focus) && "opacity-30 saturate-50 hover:opacity-80",
                        canDrag(item, role) && !picking && "cursor-grab active:cursor-grabbing",
                        dragId === item.id && "opacity-40",
                        linked.has(item.id) && "ring-2 ring-zinc-900 ring-offset-1",
                        picking &&
                          item.kind === "slot" &&
                          item.view.display === "OPEN" &&
                          "ring-2 ring-violet-500",
                      )}
                    >
                      <span className="mr-1 hidden tabular-nums opacity-80 sm:inline">
                        {fmtTime(item.start)}
                      </span>
                      {itemTitle(item, role)}
                    </button>
                  </li>
                ))}
                {dayItems.length > MAX_CHIPS && (
                  <li className="pointer-events-none px-1 text-[11px] text-zinc-500">
                    +{dayItems.length - MAX_CHIPS}<span className="hidden sm:inline">개 더보기</span>
                  </li>
                )}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}
