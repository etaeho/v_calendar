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
  itemTitle,
  useCalendarItems,
  useItemClick,
  useLinkedSlotIds,
} from "@/lib/calendar-items";
import { cn } from "@/lib/utils";
import { useCalendarStore } from "@/store/calendar-store";

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
  const dropSlot = useCalendarStore((s) => s.dropSlot);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overDay, setOverDay] = useState<string | null>(null);

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
                const item = items.find((i) => i.id === dragId);
                setDragId(null);
                setOverDay(null);
                if (!item) return;
                // 다른 날로 옮겨도 시간은 그대로 둔다
                const minutes = differenceInMinutes(item.start, startOfDay(item.start));
                dropSlot(item.id, addMinutes(startOfDay(day), minutes));
              }}
              className={cn(
                "relative min-w-0 border-r border-b border-zinc-200 p-1",
                !inMonth && "bg-zinc-50/70",
                selected && "bg-mint-50",
                overDay === key && "bg-violet-50 outline-2 -outline-offset-2 outline-violet-500 outline-dashed",
              )}
            >
              <button
                type="button"
                aria-label={`${day.getMonth() + 1}월 ${day.getDate()}일 일정 보기`}
                onClick={() => openDrawer({ type: "day", date: day.toISOString() })}
                className="absolute inset-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-mint-600"
              />
              <div className="pointer-events-none relative mb-0.5 flex justify-center sm:justify-start">
                <span
                  className={cn(
                    "flex size-6 items-center justify-center rounded-full text-xs tabular-nums",
                    isToday
                      ? "bg-mint-600 font-bold text-white"
                      : !inMonth
                        ? "text-zinc-400"
                        : dow === 0
                          ? "text-red-600"
                          : dow === 6
                            ? "text-blue-600"
                            : "text-zinc-800",
                  )}
                >
                  {day.getDate()}
                </span>
              </div>
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
                        itemClass(item),
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
