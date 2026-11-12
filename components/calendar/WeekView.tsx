"use client";

import { addDays, addMinutes, isSameDay, startOfDay, startOfWeek } from "date-fns";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { WEEKDAYS } from "@/components/calendar/MonthView";
import {
  canDrag,
  fmtTime,
  itemClass,
  itemsOnDay,
  itemTitle,
  useCalendarItems,
  useItemClick,
  useLinkedSlotIds,
  type CalendarItem,
} from "@/lib/calendar-items";
import { mainHoliday } from "@/lib/holidays";
import { planDrop, type DropPlan } from "@/lib/lesson-machine";
import { cn } from "@/lib/utils";
import { useActor, useCalendarStore } from "@/store/calendar-store";

const HOUR_START = 7;
const HOUR_END = 23;
/** 15분 = 16px */
const HOUR_PX = 64;
/** 드래그 스냅 단위 = 15분 선 */
const SNAP_MIN = 15;
const HOURS = Array.from({ length: HOUR_END - HOUR_START }, (_, i) => HOUR_START + i);
const TOTAL_MIN = (HOUR_END - HOUR_START) * 60;
const DRAG_THRESHOLD_PX = 4;

const minToPx = (min: number) => (min / 60) * HOUR_PX;

interface Placed {
  item: CalendarItem;
  top: number;
  height: number;
  col: number;
  cols: number;
}

/** 하루 시작(HOUR_START) 기준 분 */
const minutesFromDayStart = (date: Date) =>
  (date.getTime() - startOfDay(date).getTime()) / 60000 - HOUR_START * 60;

/** 겹치는 일정을 좌우 컬럼으로 나눠 배치한다 (레슨 슬롯과 개인 일정의 충돌을 한눈에 비교) */
function layoutDay(items: CalendarItem[]): Placed[] {
  const spans = items
    .map((item) => {
      const s = Math.max(0, minutesFromDayStart(item.start));
      const e = Math.min(TOTAL_MIN, s + (item.end.getTime() - item.start.getTime()) / 60000);
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
        top: minToPx(span.s),
        height: minToPx(span.e - span.s),
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

/** 빈 시간 드래그 → 슬롯 생성 */
interface CreateDrag {
  dayIndex: number;
  anchor: number;
  current: number;
}

const createRange = (d: CreateDrag) => {
  const start = Math.min(d.anchor, d.current);
  const end = Math.max(d.anchor, d.current) + SNAP_MIN;
  // 클릭(드래그 없음)은 기본 60분 슬롯
  return end - start <= SNAP_MIN
    ? { start, end: Math.min(start + 60, TOTAL_MIN) }
    : { start, end };
};

/** 일정 드래그 → 이동 */
interface MoveDrag {
  slotId: string;
  duration: number;
  /** 일정 윗변에서 잡은 위치까지의 분 */
  grabOffset: number;
  dayIndex: number;
  startMin: number;
  moved: boolean;
  x0: number;
  y0: number;
}

const GHOST_TEXT: Record<Exclude<DropPlan["kind"], "none" | "invalid">, string> = {
  move: "여기로 이동",
  change: "이 빈 슬롯으로 변경 요청",
  "change-new": "새 시간으로 변경 요청",
};

export function WeekView() {
  const cursor = useCalendarStore((s) => s.cursor);
  const now = useCalendarStore((s) => s.now);
  const role = useCalendarStore((s) => s.role);
  const lesson = useCalendarStore((s) => s.lesson);
  const drawer = useCalendarStore((s) => s.drawer);
  const lessonFilter = useCalendarStore((s) => s.filters.LESSON);
  const openDrawer = useCalendarStore((s) => s.openDrawer);
  const createSlot = useCalendarStore((s) => s.createSlot);
  const dropSlot = useCalendarStore((s) => s.dropSlot);
  const actor = useActor();
  const items = useCalendarItems();
  const linked = useLinkedSlotIds();
  const onItemClick = useItemClick();

  const scrollRef = useRef<HTMLDivElement>(null);
  const columnsRef = useRef<(HTMLDivElement | null)[]>([]);
  const justDragged = useRef(false);
  const [create, setCreate] = useState<CreateDrag | null>(null);
  const [move, setMove] = useState<MoveDrag | null>(null);

  useEffect(() => {
    // 처음 열 때 오전 9시 부근이 보이도록
    scrollRef.current?.scrollTo({ top: minToPx((9 - HOUR_START) * 60) - 8 });
  }, []);

  const weekStart = startOfWeek(new Date(cursor), { weekStartsOn: 0 });
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const today = new Date(now);
  const nowMin = minutesFromDayStart(today);
  const picking = drawer.type === "reschedule";
  const canCreate = role === "INSTRUCTOR" && lessonFilter && !picking;

  const dayBase = (dayIndex: number) => addMinutes(startOfDay(days[dayIndex]), HOUR_START * 60);

  /* ---------------- 빈 시간 드래그 → 슬롯 생성 ---------------- */

  const minuteAt = (e: PointerEvent<HTMLDivElement>) => {
    const y = e.clientY - e.currentTarget.getBoundingClientRect().top;
    const min = Math.floor(((y / HOUR_PX) * 60) / SNAP_MIN) * SNAP_MIN;
    return Math.min(Math.max(min, 0), TOTAL_MIN - SNAP_MIN);
  };

  const onColumnPointerDown = (dayIndex: number) => (e: PointerEvent<HTMLDivElement>) => {
    if (!canCreate || e.button !== 0 || e.target !== e.currentTarget) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const min = minuteAt(e);
    setCreate({ dayIndex, anchor: min, current: min });
  };
  const onColumnPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!create) return;
    const min = minuteAt(e);
    if (min !== create.current) setCreate({ ...create, current: min });
  };
  const onColumnPointerUp = () => {
    if (!create) return;
    const { start, end } = createRange(create);
    const base = dayBase(create.dayIndex);
    setCreate(null);
    const id = createSlot(addMinutes(base, start), addMinutes(base, end));
    if (id) openDrawer({ type: "slot", slotId: id });
  };

  /* ---------------- 일정 드래그 → 이동 ---------------- */

  const columnAt = (clientX: number) => {
    const cols = columnsRef.current;
    for (let i = 0; i < cols.length; i++) {
      const r = cols[i]?.getBoundingClientRect();
      if (r && clientX >= r.left && clientX < r.right) return i;
    }
    // 바깥으로 나가면 가장 가까운 끝 열
    const first = cols[0]?.getBoundingClientRect();
    return first && clientX < first.left ? 0 : cols.length - 1;
  };

  const onItemPointerDown =
    (item: CalendarItem, dayIndex: number, top: number) => (e: PointerEvent<HTMLButtonElement>) => {
      // 터치는 스크롤을 우선하고, 일정 변경은 상세 화면의 '일정 변경 요청'으로 한다
      if (e.button !== 0 || e.pointerType === "touch" || picking || !canDrag(item, role)) return;
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      const colTop = columnsRef.current[dayIndex]!.getBoundingClientRect().top;
      const pointerMin = ((e.clientY - colTop) / HOUR_PX) * 60;
      const startMin = (top / HOUR_PX) * 60;
      setMove({
        slotId: item.id,
        duration: (item.end.getTime() - item.start.getTime()) / 60000,
        grabOffset: pointerMin - startMin,
        dayIndex,
        startMin,
        moved: false,
        x0: e.clientX,
        y0: e.clientY,
      });
    };

  const onItemPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    if (!move) return;
    const moved =
      move.moved || Math.hypot(e.clientX - move.x0, e.clientY - move.y0) > DRAG_THRESHOLD_PX;
    if (!moved) return;
    const dayIndex = columnAt(e.clientX);
    const colTop = columnsRef.current[dayIndex]!.getBoundingClientRect().top;
    const raw = ((e.clientY - colTop) / HOUR_PX) * 60 - move.grabOffset;
    const snapped = Math.round(raw / SNAP_MIN) * SNAP_MIN;
    const startMin = Math.min(Math.max(snapped, 0), TOTAL_MIN - Math.min(move.duration, TOTAL_MIN));
    if (moved !== move.moved || dayIndex !== move.dayIndex || startMin !== move.startMin) {
      setMove({ ...move, moved, dayIndex, startMin });
    }
  };

  const onItemPointerUp = () => {
    if (!move) return;
    setMove(null);
    if (!move.moved) return;
    justDragged.current = true;
    dropSlot(move.slotId, addMinutes(dayBase(move.dayIndex), move.startMin));
  };

  const moveStartIso = move?.moved
    ? addMinutes(dayBase(move.dayIndex), move.startMin).toISOString()
    : null;
  const plan: DropPlan | null =
    move && moveStartIso
      ? planDrop(lesson, actor, move.slotId, moveStartIso, now)
      : null;

  const pendingRange = drawer.type === "reschedule" ? drawer.toRange : undefined;

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
      <div className="min-w-[720px]">
        <div className="sticky top-0 z-20 grid grid-cols-[3.5rem_repeat(7,minmax(0,1fr))] border-b border-zinc-300 bg-white">
          <div />
          {days.map((day, i) => {
            const isToday = isSameDay(day, today);
            const holiday = mainHoliday(day);
            const red = i === 0 || holiday?.dayOff;
            return (
              <button
                key={day.toISOString()}
                type="button"
                onClick={() => openDrawer({ type: "day", date: day.toISOString() })}
                className="flex min-w-0 flex-col items-center gap-0.5 border-l border-zinc-200 px-1 pt-1.5 pb-1 hover:bg-zinc-50"
              >
                <span
                  className={cn(
                    "text-xs font-medium",
                    red ? "text-red-600" : i === 6 ? "text-blue-600" : "text-zinc-600",
                  )}
                >
                  {WEEKDAYS[i]}
                </span>
                <span
                  className={cn(
                    "flex size-7 items-center justify-center rounded-full text-sm tabular-nums",
                    isToday
                      ? "bg-mint-600 font-bold text-white"
                      : red
                        ? "font-semibold text-red-600"
                        : "text-zinc-900",
                  )}
                >
                  {day.getDate()}
                </span>
                <span
                  title={holiday?.name}
                  className={cn(
                    "h-4 max-w-full truncate text-[11px] leading-4",
                    holiday?.dayOff ? "font-medium text-red-600" : "text-zinc-500",
                  )}
                >
                  {holiday?.name}
                </span>
              </button>
            );
          })}
        </div>

        <div className="grid grid-cols-[3.5rem_repeat(7,minmax(0,1fr))]">
          <div className="relative" style={{ height: minToPx(TOTAL_MIN) }}>
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
            const placed = layoutDay(itemsOnDay(items, day));
            const isToday = isSameDay(day, today);
            const createPreview = create?.dayIndex === dayIndex ? createRange(create) : null;
            const ghost =
              plan && plan.kind !== "none" && isSameDay(new Date(plan.start), day) ? plan : null;
            const pendingHere =
              pendingRange && isSameDay(new Date(pendingRange.start), day) ? pendingRange : null;
            return (
              <div
                key={day.toISOString()}
                ref={(el) => {
                  columnsRef.current[dayIndex] = el;
                }}
                onPointerDown={onColumnPointerDown(dayIndex)}
                onPointerMove={onColumnPointerMove}
                onPointerUp={onColumnPointerUp}
                onPointerCancel={() => setCreate(null)}
                className={cn(
                  "relative border-l border-zinc-200 select-none",
                  isToday && "bg-mint-50/40",
                  canCreate && "cursor-cell",
                )}
                style={{ height: minToPx(TOTAL_MIN) }}
              >
                {/* 1시간 실선 · 30분 점선 · 15분 얇은 점선 */}
                {HOURS.map((h, i) => (
                  <div key={h} className="pointer-events-none absolute inset-x-0" style={{ top: i * HOUR_PX }}>
                    {i > 0 && <div className="border-t border-zinc-300" />}
                    {[1, 3].map((q) => (
                      <div
                        key={q}
                        className="absolute inset-x-0 border-t-[0.5px] border-dotted border-zinc-200"
                        style={{ top: (HOUR_PX / 4) * q }}
                      />
                    ))}
                    <div
                      className="absolute inset-x-0 border-t border-dashed border-zinc-300/80"
                      style={{ top: HOUR_PX / 2 }}
                    />
                  </div>
                ))}

                {placed.map(({ item, top, height, col, cols }) => {
                  const compact = height < 40;
                  const draggable = canDrag(item, role) && !picking;
                  const dragging = move?.moved && move.slotId === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onPointerDown={onItemPointerDown(item, dayIndex, top)}
                      onPointerMove={onItemPointerMove}
                      onPointerUp={onItemPointerUp}
                      onPointerCancel={() => setMove(null)}
                      onClick={() => {
                        if (justDragged.current) {
                          justDragged.current = false;
                          return;
                        }
                        onItemClick(item);
                      }}
                      title={`${fmtTime(item.start)}–${fmtTime(item.end)} ${itemTitle(item, role)}`}
                      className={cn(
                        "absolute overflow-hidden rounded-md px-1.5 py-0.5 text-left text-xs leading-tight shadow-[0_1px_2px_rgba(0,0,0,0.08)] transition-shadow hover:z-10 hover:shadow-md focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-zinc-900",
                        itemClass(item),
                        compact && "flex items-center gap-1",
                        draggable && "cursor-grab active:cursor-grabbing",
                        linked.has(item.id) && "z-10 ring-2 ring-zinc-900 ring-offset-1",
                        picking &&
                          item.kind === "slot" &&
                          item.view.display === "OPEN" &&
                          "ring-2 ring-violet-500",
                        dragging && "opacity-40",
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

                {createPreview && (
                  <div
                    className="pointer-events-none absolute inset-x-0.5 rounded-md border-2 border-dashed border-mint-600 bg-mint-200/60 px-1.5 py-0.5 text-xs font-semibold text-mint-800"
                    style={{
                      top: minToPx(createPreview.start),
                      height: minToPx(createPreview.end - createPreview.start),
                    }}
                  >
                    새 슬롯 {fmtMin(createPreview.start)}–{fmtMin(createPreview.end)}
                  </div>
                )}

                {pendingHere && !ghost && (
                  <div
                    className="pointer-events-none absolute inset-x-0.5 z-10 rounded-md border-2 border-dashed border-violet-600 bg-violet-100/80 px-1.5 py-0.5 text-xs font-semibold text-violet-900"
                    style={{
                      top: minToPx(minutesFromDayStart(new Date(pendingHere.start))),
                      height: minToPx(
                        (Date.parse(pendingHere.end) - Date.parse(pendingHere.start)) / 60000,
                      ),
                    }}
                  >
                    변경 희망 (전송 전)
                  </div>
                )}

                {ghost && (
                  <div
                    className={cn(
                      "pointer-events-none absolute inset-x-0.5 z-30 rounded-md border-2 border-dashed px-1.5 py-0.5 text-xs leading-tight font-semibold shadow-lg",
                      ghost.kind === "invalid"
                        ? "border-red-600 bg-red-50/95 text-red-800"
                        : ghost.kind === "move"
                          ? "border-mint-700 bg-mint-100/95 text-mint-900"
                          : "border-violet-600 bg-violet-100/95 text-violet-900",
                    )}
                    style={{
                      top: minToPx(minutesFromDayStart(new Date(ghost.start))),
                      height: minToPx((Date.parse(ghost.end) - Date.parse(ghost.start)) / 60000),
                    }}
                  >
                    <span className="block tabular-nums">
                      {fmtTime(ghost.start)}–{fmtTime(ghost.end)}
                    </span>
                    <span className="block">
                      {ghost.kind === "invalid" ? ghost.reason : GHOST_TEXT[ghost.kind]}
                    </span>
                  </div>
                )}

                {isToday && nowMin >= 0 && nowMin <= TOTAL_MIN && (
                  <div
                    className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-coral-500"
                    style={{ top: minToPx(nowMin) }}
                  >
                    <span className="absolute -top-1.5 -left-1 size-2.5 rounded-full bg-coral-500" />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {lessonFilter && !picking && (
        <p className="sticky bottom-0 left-0 border-t border-zinc-200 bg-white/95 px-4 py-1.5 text-xs text-zinc-600">
          {role === "INSTRUCTOR" ? (
            <>
              빈 시간대를 <strong>클릭</strong>(60분)하거나 <strong>드래그</strong>해 슬롯 열기 · 일정을{" "}
              <strong>끌어서</strong> 15분 단위로 옮기기
            </>
          ) : (
            <>
              내 레슨을 <strong>빈 슬롯(가능) 위로 끌어 놓으면</strong> 일정 변경을 요청할 수 있습니다.
            </>
          )}
        </p>
      )}
    </div>
  );
}

const fmtMin = (min: number) => {
  const total = HOUR_START * 60 + min;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
};
