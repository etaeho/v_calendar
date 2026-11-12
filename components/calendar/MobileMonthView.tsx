"use client";

import {
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  isSameDay,
  isSameMonth,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
import {
  fmtDay,
  fmtTime,
  isDimmed,
  itemClass,
  itemsOnDay,
  itemTitle,
  STATUS_LABEL,
  useCalendarItems,
  useFocusStudent,
  useItemClick,
  type CalendarItem,
} from "@/lib/calendar-items";
import { holidaysOn, mainHoliday } from "@/lib/holidays";
import { studentColor } from "@/lib/student-colors";
import { cn } from "@/lib/utils";
import { useCalendarStore } from "@/store/calendar-store";
import type { UserRole } from "@/types/calendar";

/** 달력 칸에 그리는 얇은 막대 색 (일정 종류·상태별) */
function barClass(item: CalendarItem, role: UserRole): string {
  if (item.kind === "external") return item.event.provider === "GOOGLE" ? "bg-blue-400" : "bg-coral-400";
  switch (item.view.display) {
    case "OPEN":
      return role === "STUDENT" ? "bg-emerald-500" : "bg-white ring-1 ring-inset ring-mint-500";
    case "CONFIRMED":
      return (role === "INSTRUCTOR" && studentColor(item.view.slot.studentId)?.dot) || "bg-mint-700";
    case "PENDING_CHANGE_FROM":
    case "PENDING_CHANGE_TO":
      return "bg-violet-400";
    case "SKIPPED":
    case "CLOSED":
      return "bg-zinc-300";
    default:
      return "bg-amber-400";
  }
}

const MAX_BARS = 4;

/** 휴대폰 월간: 날짜 칸에는 막대만, 선택한 날의 일정은 아래 목록으로 */
export function MobileMonthView() {
  const cursor = useCalendarStore((s) => s.cursor);
  const selected = useCalendarStore((s) => s.selectedDate);
  const now = useCalendarStore((s) => s.now);
  const role = useCalendarStore((s) => s.role);
  const lessonFilter = useCalendarStore((s) => s.filters.LESSON);
  const selectDate = useCalendarStore((s) => s.selectDate);
  const openDrawer = useCalendarStore((s) => s.openDrawer);
  const items = useCalendarItems();
  const onItemClick = useItemClick();
  const focus = useFocusStudent();
  const picking = useCalendarStore((s) => s.drawer.type === "reschedule");

  const month = new Date(cursor);
  const today = new Date(now);
  // 다른 달로 넘기면 그 달 1일(오늘이 있으면 오늘)을 선택한 것으로 본다
  const selectedDay =
    selected && isSameMonth(new Date(selected), month)
      ? new Date(selected)
      : isSameMonth(today, month)
        ? today
        : startOfMonth(month);
  const days = eachDayOfInterval({
    start: startOfWeek(startOfMonth(month), { weekStartsOn: 0 }),
    end: endOfWeek(endOfMonth(month), { weekStartsOn: 0 }),
  });
  const dayItems = itemsOnDay(items, selectedDay);
  const holidays = holidaysOn(selectedDay);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid grid-cols-7 border-b border-zinc-200 bg-white">
        {WEEKDAYS.map((d, i) => (
          <div
            key={d}
            className={cn(
              "py-1 text-center text-[11px] font-medium",
              i === 0 ? "text-red-600" : i === 6 ? "text-blue-600" : "text-zinc-500",
            )}
          >
            {d}
          </div>
        ))}
      </div>

      <div className="grid shrink-0 grid-cols-7 border-b border-zinc-200 bg-white">
        {days.map((day) => {
          const list = itemsOnDay(items, day);
          const inMonth = isSameMonth(day, month);
          const isToday = isSameDay(day, today);
          const isSelected = isSameDay(day, selectedDay);
          const holiday = mainHoliday(day);
          const red = day.getDay() === 0 || holiday?.dayOff;
          // 레슨생: 강사가 열어 둔 빈 시간이 있는 날은 초록으로 표시
          const hasOpen =
            role === "STUDENT" && list.some((i) => i.kind === "slot" && i.view.display === "OPEN");
          return (
            <button
              key={day.toISOString()}
              type="button"
              aria-label={`${day.getMonth() + 1}월 ${day.getDate()}일${holiday ? ` ${holiday.name}` : ""}, 일정 ${list.length}개`}
              aria-pressed={isSelected}
              onClick={() => selectDate(day)}
              className={cn(
                "flex h-[3.4rem] min-w-0 flex-col items-center gap-0.5 border-t border-zinc-100 pt-1",
                hasOpen && !isSelected && "bg-emerald-50",
                isSelected && "bg-mint-50",
                !inMonth && "opacity-40",
              )}
            >
              <span
                className={cn(
                  "flex size-6 items-center justify-center rounded-full text-[13px] tabular-nums",
                  isToday
                    ? "bg-mint-700 font-bold text-white"
                    : isSelected
                      ? "font-bold text-zinc-900 ring-2 ring-mint-600"
                      : red
                        ? "font-semibold text-red-600"
                        : day.getDay() === 6
                          ? "text-blue-600"
                          : "text-zinc-800",
                )}
              >
                {day.getDate()}
              </span>
              <span className="flex w-full flex-col gap-[2px] px-1" aria-hidden>
                {list.slice(0, MAX_BARS).map((item) => (
                  <span
                    key={item.id}
                    className={cn(
                      "h-[4px] w-full rounded-full",
                      barClass(item, role),
                      isDimmed(item, focus, picking) && "opacity-30",
                    )}
                  />
                ))}
              </span>
            </button>
          );
        })}
      </div>

      <section aria-label={`${fmtDay(selectedDay)} 일정`} className="min-h-0 flex-1 overflow-y-auto bg-zinc-50 px-4 py-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="text-sm font-bold">
            {fmtDay(selectedDay)}
            {holidays.map((h) => (
              <span
                key={h.name}
                className={cn("ml-1.5 text-xs font-medium", h.dayOff ? "text-red-600" : "text-zinc-500")}
              >
                {h.name}
              </span>
            ))}
          </h2>
          {role === "INSTRUCTOR" && lessonFilter && (
            <Button
              size="sm"
              className="h-9"
              onClick={() => openDrawer({ type: "day", date: selectedDay.toISOString() })}
            >
              <Plus />
              빈 슬롯 열기
            </Button>
          )}
        </div>
        {dayItems.length === 0 ? (
          <p className="rounded-xl bg-white px-3 py-6 text-center text-sm text-zinc-500">이 날은 일정이 없습니다.</p>
        ) : (
          <ul className="space-y-2">
            {dayItems.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => onItemClick(item)}
                  className={cn(
                    "flex min-h-12 w-full items-center gap-3 rounded-xl px-3 py-2 text-left",
                    itemClass(item, role),
                    isDimmed(item, focus, picking) && "opacity-45",
                  )}
                >
                  <span className="w-12 shrink-0 text-xs leading-tight tabular-nums opacity-90">
                    {fmtTime(item.start)}
                    <br />
                    {fmtTime(item.end)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">{itemTitle(item, role)}</span>
                    <span className="block truncate text-xs opacity-80">
                      {item.kind === "external"
                        ? item.event.provider === "GOOGLE"
                          ? "구글 캘린더"
                          : "카카오 캘린더"
                        : STATUS_LABEL[item.view.display]}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
