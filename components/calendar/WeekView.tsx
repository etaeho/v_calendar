"use client";

import { addDays, addMinutes, isSameDay, startOfDay, startOfWeek } from "date-fns";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { WEEKDAYS } from "@/components/calendar/MonthView";
import {
  fmtTime,
  itemClass,
  itemsOnDay,
  itemTitle,
  useCalendarItems,
  useItemClick,
  useLinkedSlotIds,
  type CalendarItem,
} from "@/lib/calendar-items";
import { cn } from "@/lib/utils";
import { useCalendarStore } from "@/store/calendar-store";

const HOUR_START = 7;
const HOUR_END = 23;
const HOUR_PX = 56;
const SNAP_MIN = 30;
const HOURS = Array.from({ length: HOUR_END - HOUR_START }, (_, i) => HOUR_START + i);
const TOTAL_MIN = (HOUR_END - HOUR_START) * 60;

interface Placed {
  item: CalendarItem;
  top: number;
  height: number;
  col: number;
  cols: number;
}

/** 겹치는 일정을 좌우 컬럼으로 나눠 배치한다 (레슨 슬롯과 개인 일정의 충돌을 한눈에 비교) */
function layoutDay(items: CalendarItem[], day: Date): Placed[] {
  const dayStart = addMinutes(startOfDay(day), HOUR_START * 60).getTime();
  const spans = items
    .map((item) => {
      const s = Math.max(0, (item.start.getTime() - dayStart) / 60000);
      const e = Math.min(TOTAL_MIN, (item.end.getTime() - dayStart) / 60000);
      return { item, s, e: Math.max(e, s + 20) };
    })
    .filter((x) => x.s < TOTAL_MIN && x.e > 0)
    .sort((a, b) => a.s - b.s || b.e - a.e);

  const placed: Placed[] = [];
  let cluster: { span: (typeof spans)[number]; col: number }[] = [];
  let clusterEnd = -1;
  const flush = () => {
    const cols = Math.max(0, ...cluster.map((c) => c.col)) + 1;
    for (const { span, col } of cluster) {
      placed.push({
        item: span.item,
        top: (span.s / 60) * HOUR_PX,
        height: ((span.e - span.s) / 60) * HOUR_PX,
        col,
        cols,
      });
    }
    cluster = [];
  };
  for (const span of spans) {
    if (cluster.length && span.s >= clusterEnd) flush();
    const used = new Set(cluster.filter((c) => c.span.e > span.s).map((c) => c.col));
    let col = 0;
    while (used.has(col)) col++;
    cluster.push({ span, col });
    clusterEnd = Math.max(clusterEnd, span.e);
  }
  if (cluster.length) flush();
  return placed;
}

interface DragState {
  dayIndex: number;
  anchor: number;
  current: number;
}

const dragRange = (d: DragState) => {
  const start = Math.min(d.anchor, d.current);
  const end = Math.max(d.anchor, d.current) + SNAP_MIN;
  // 클릭(드래그 없음)은 기본 60분 슬롯
  return end - start <= SNAP_MIN
    ? { start, end: Math.min(start + 60, TOTAL_MIN) }
    : { start, end };
};

export function WeekView() {
  const cursor = useCalendarStore((s) => s.cursor);
  const now = useCalendarStore((s) => s.now);
  const role = useCalendarStore((s) => s.role);
  const drawer = useCalendarStore((s) => s.drawer);
  const lessonFilter = useCalendarStore((s) => s.filters.LESSON);
  const openDrawer = useCalendarStore((s) => s.openDrawer);
  const createSlot = useCalendarStore((s) => s.createSlot);
  const items = useCalendarItems();
  const linked = useLinkedSlotIds();
  const onItemClick = useItemClick();

  const scrollRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  useEffect(() => {
    // 처음 열 때 오전 9시 부근이 보이도록
    scrollRef.current?.scrollTo({ top: (9 - HOUR_START) * HOUR_PX - 8 });
  }, []);

  const weekStart = startOfWeek(new Date(cursor), { weekStartsOn: 0 });
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const today = new Date(now);
  const nowMin = (today.getTime() - startOfDay(today).getTime()) / 60000 - HOUR_START * 60;
  const canCreate = role === "INSTRUCTOR" && lessonFilter && drawer.type !== "reschedule";
  const picking = drawer.type === "reschedule";

  const minuteAt = (e: PointerEvent<HTMLDivElement>) => {
    const y = e.clientY - e.currentTarget.getBoundingClientRect().top;
    const min = Math.floor(((y / HOUR_PX) * 60) / SNAP_MIN) * SNAP_MIN;
    return Math.min(Math.max(min, 0), TOTAL_MIN - SNAP_MIN);
  };

  const onPointerDown = (dayIndex: number) => (e: PointerEvent<HTMLDivElement>) => {
    if (!canCreate || e.button !== 0 || e.target !== e.currentTarget) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const min = minuteAt(e);
    setDrag({ dayIndex, anchor: min, current: min });
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const min = minuteAt(e);
    if (min !== drag.current) setDrag({ ...drag, current: min });
  };
  const onPointerUp = () => {
    if (!drag) return;
    const { start, end } = dragRange(drag);
    const base = addMinutes(startOfDay(days[drag.dayIndex]), HOUR_START * 60);
    setDrag(null);
    const id = createSlot(addMinutes(base, start), addMinutes(base, end));
    if (id) openDrawer({ type: "slot", slotId: id });
  };

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
      <div className="min-w-[720px]">
        <div className="sticky top-0 z-20 grid grid-cols-[3.5rem_repeat(7,minmax(0,1fr))] border-b border-zinc-200 bg-white">
          <div />
          {days.map((day, i) => {
            const isToday = isSameDay(day, today);
            return (
              <button
                key={day.toISOString()}
                type="button"
                onClick={() => openDrawer({ type: "day", date: day.toISOString() })}
                className="flex flex-col items-center gap-0.5 border-l border-zinc-100 py-1.5 hover:bg-zinc-50"
              >
                <span
                  className={cn(
                    "text-xs font-medium",
                    i === 0 ? "text-red-600" : i === 6 ? "text-blue-600" : "text-zinc-600",
                  )}
                >
                  {WEEKDAYS[i]}
                </span>
                <span
                  className={cn(
                    "flex size-7 items-center justify-center rounded-full text-sm tabular-nums",
                    isToday ? "bg-mint-600 font-bold text-white" : "text-zinc-900",
                  )}
                >
                  {day.getDate()}
                </span>
              </button>
            );
          })}
        </div>

        <div className="grid grid-cols-[3.5rem_repeat(7,minmax(0,1fr))]">
          <div className="relative" style={{ height: HOURS.length * HOUR_PX }}>
            {HOURS.map((h, i) => (
              <span
                key={h}
                className="absolute right-2 -translate-y-1/2 text-[11px] text-zinc-500 tabular-nums"
                style={{ top: i * HOUR_PX }}
              >
                {i === 0 ? "" : `${String(h).padStart(2, "0")}:00`}
              </span>
            ))}
          </div>

          {days.map((day, dayIndex) => {
            const placed = layoutDay(itemsOnDay(items, day), day);
            const isToday = isSameDay(day, today);
            const preview = drag?.dayIndex === dayIndex ? dragRange(drag) : null;
            return (
              <div
                key={day.toISOString()}
                onPointerDown={onPointerDown(dayIndex)}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={() => setDrag(null)}
                className={cn(
                  "relative border-l border-zinc-100 select-none",
                  isToday && "bg-mint-50/40",
                  canCreate && "cursor-cell",
                )}
                style={{
                  height: HOURS.length * HOUR_PX,
                  backgroundImage:
                    "linear-gradient(to bottom, #e4e4e7 1px, transparent 1px), linear-gradient(to bottom, #f4f4f5 1px, transparent 1px)",
                  backgroundSize: `100% ${HOUR_PX}px, 100% ${HOUR_PX / 2}px`,
                }}
              >
                {placed.map(({ item, top, height, col, cols }) => {
                  const compact = height < 40;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => onItemClick(item)}
                      title={`${fmtTime(item.start)}–${fmtTime(item.end)} ${itemTitle(item, role)}`}
                      className={cn(
                        "absolute overflow-hidden rounded-md px-1.5 py-0.5 text-left text-xs leading-tight transition-shadow hover:z-10 hover:shadow-md focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-zinc-900",
                        itemClass(item),
                        compact && "flex items-center gap-1",
                        linked.has(item.id) && "z-10 ring-2 ring-zinc-900 ring-offset-1",
                        picking &&
                          item.kind === "slot" &&
                          item.view.display === "OPEN" &&
                          "ring-2 ring-violet-500",
                      )}
                      style={{
                        top: top + 1,
                        height: height - 2,
                        left: `calc(${(col / cols) * 100}% + 2px)`,
                        width: `calc(${100 / cols}% - 4px)`,
                      }}
                    >
                      <span className="block truncate font-semibold">{itemTitle(item, role)}</span>
                      <span className="block truncate tabular-nums opacity-85">
                        {fmtTime(item.start)}–{fmtTime(item.end)}
                      </span>
                    </button>
                  );
                })}

                {preview && (
                  <div
                    className="pointer-events-none absolute inset-x-0.5 rounded-md border-2 border-dashed border-mint-600 bg-mint-200/60 px-1.5 py-0.5 text-xs font-semibold text-mint-800"
                    style={{
                      top: (preview.start / 60) * HOUR_PX,
                      height: ((preview.end - preview.start) / 60) * HOUR_PX,
                    }}
                  >
                    새 슬롯
                  </div>
                )}

                {isToday && nowMin >= 0 && nowMin <= TOTAL_MIN && (
                  <div
                    className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-coral-500"
                    style={{ top: (nowMin / 60) * HOUR_PX }}
                  >
                    <span className="absolute -top-1.5 -left-1 size-2.5 rounded-full bg-coral-500" />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {canCreate && (
        <p className="sticky bottom-0 left-0 border-t border-zinc-200 bg-white/95 px-4 py-1.5 text-xs text-zinc-600">
          빈 시간대를 <strong>클릭</strong>(60분)하거나 <strong>드래그</strong>해서 레슨 가능 슬롯을 열 수 있습니다.
        </p>
      )}
    </div>
  );
}
