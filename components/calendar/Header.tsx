"use client";

import { addDays, addMonths, addWeeks, endOfWeek, format, startOfWeek } from "date-fns";
import { ChevronLeft, ChevronRight, GraduationCap, Menu, Music } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/lib/use-mobile";
import { cn } from "@/lib/utils";
import { INSTRUCTOR, STUDENTS } from "@/lib/mock-data";
import { useCalendarStore } from "@/store/calendar-store";
import type { CalendarViewMode } from "@/types/calendar";

const VIEWS: { id: CalendarViewMode; label: string }[] = [
  { id: "month", label: "월간" },
  { id: "week", label: "주간" },
];

export function Header({ onToggleSidebar }: { onToggleSidebar: () => void }) {
  const cursor = useCalendarStore((s) => s.cursor);
  const view = useCalendarStore((s) => s.view);
  const role = useCalendarStore((s) => s.role);
  const now = useCalendarStore((s) => s.now);
  const setCursor = useCalendarStore((s) => s.setCursor);
  const setView = useCalendarStore((s) => s.setView);
  const setRole = useCalendarStore((s) => s.setRole);
  const studentId = useCalendarStore((s) => s.studentId);
  const setStudent = useCalendarStore((s) => s.setStudent);

  const mobile = useIsMobile();
  const date = new Date(cursor);
  // 휴대폰 주간 화면은 3일씩 보여 주고 3일씩 넘긴다
  const move = (dir: 1 | -1) =>
    setCursor(
      view === "month" ? addMonths(date, dir) : mobile ? addDays(date, dir * 3) : addWeeks(date, dir),
    );

  let title = format(date, "yyyy년 M월");
  if (view === "week") {
    const ws = startOfWeek(date, { weekStartsOn: 0 });
    const we = endOfWeek(date, { weekStartsOn: 0 });
    title =
      ws.getMonth() === we.getMonth()
        ? format(ws, "yyyy년 M월")
        : `${format(ws, "yyyy년 M월")} – ${format(we, ws.getFullYear() === we.getFullYear() ? "M월" : "yyyy년 M월")}`;
  }

  if (view === "week" && mobile) {
    const last = addDays(date, 2);
    title =
      date.getMonth() === last.getMonth()
        ? format(date, "yyyy년 M월")
        : `${format(date, "M월")} – ${format(last, "M월")}`;
  }

  const isInstructor = role === "INSTRUCTOR";

  if (mobile) {
    const calendarTab = view === "month" || view === "week";
    const TAB_TITLE: Partial<Record<CalendarViewMode, string>> = {
      requests: "요청",
      students: "레슨생 관리",
      plan: "내 수강",
      menu: "메뉴",
    };
    return (
      <header className="border-b border-zinc-200 bg-white px-2 pt-[env(safe-area-inset-top)]">
        <div className="flex h-12 items-center gap-1">
          {calendarTab ? (
            <>
              <Button variant="ghost" size="icon" className="size-10" aria-label="이전" onClick={() => move(-1)}>
                <ChevronLeft />
              </Button>
              <h1 className="min-w-0 truncate text-center text-lg font-bold tracking-tight tabular-nums">{title}</h1>
              <Button variant="ghost" size="icon" className="size-10" aria-label="다음" onClick={() => move(1)}>
                <ChevronRight />
              </Button>
            </>
          ) : (
            <h1 className="px-2 text-lg font-bold">{TAB_TITLE[view]}</h1>
          )}
          <ActingUserSelect className="ml-auto" />
        </div>
        {calendarTab && (
          <div className="flex items-center gap-2 pb-2">
            <div role="tablist" aria-label="보기 전환" className="flex flex-1 rounded-lg bg-zinc-100 p-0.5">
              {[
                { id: "month" as const, label: "월간" },
                { id: "week" as const, label: "3일" },
              ].map((v) => (
                <button
                  key={v.id}
                  role="tab"
                  type="button"
                  aria-selected={view === v.id}
                  onClick={() => setView(v.id)}
                  className={cn(
                    "h-8 flex-1 rounded-md text-sm font-medium",
                    view === v.id ? "bg-white text-zinc-900 shadow-sm" : "text-zinc-600",
                  )}
                >
                  {v.label}
                </button>
              ))}
            </div>
            <Button size="sm" className="h-9" onClick={() => setCursor(new Date(now))}>
              오늘
            </Button>
          </div>
        )}
      </header>
    );
  }

  return (
    <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-zinc-200 px-3 py-2.5 sm:px-4">
      <Button
        variant="ghost"
        size="icon"
        className="lg:hidden"
        aria-label="캘린더 목록 열기"
        onClick={onToggleSidebar}
      >
        <Menu />
      </Button>

      <div className="flex items-center gap-1">
        <Button variant="ghost" size="icon" aria-label="이전" onClick={() => move(-1)}>
          <ChevronLeft />
        </Button>
        <h1 className="min-w-28 text-center text-lg font-bold tracking-tight tabular-nums sm:text-xl">
          {title}
        </h1>
        <Button variant="ghost" size="icon" aria-label="다음" onClick={() => move(1)}>
          <ChevronRight />
        </Button>
        <Button size="sm" className="ml-1" onClick={() => setCursor(new Date(now))}>
          오늘
        </Button>
      </div>

      <div role="tablist" aria-label="보기 전환" className="flex rounded-lg bg-zinc-100 p-0.5">
        {(isInstructor ? [...VIEWS, { id: "students" as const, label: "레슨생 관리" }] : VIEWS).map((v) => (
          <button
            key={v.id}
            role="tab"
            type="button"
            aria-selected={view === v.id}
            onClick={() => setView(v.id)}
            className={cn(
              "rounded-md px-3 py-1 text-sm font-medium transition-colors",
              view === v.id ? "bg-white text-zinc-900 shadow-sm" : "text-zinc-600 hover:text-zinc-900",
            )}
          >
            {v.label}
          </button>
        ))}
      </div>

      {/* 테스트용 역할 전환 토글 */}
      <div className="ml-auto flex items-center gap-2 rounded-full border border-zinc-200 bg-zinc-50 py-1 pr-1 pl-3">
        <span className="hidden text-xs text-zinc-500 sm:inline">테스트 역할</span>
        <span
          className={cn(
            "flex items-center gap-1 text-sm",
            isInstructor ? "font-semibold text-zinc-900" : "text-zinc-500",
          )}
        >
          <Music className="size-3.5" />
          강사
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={!isInstructor}
          aria-label="역할 전환: 강사 모드 / 레슨생 모드"
          onClick={() => setRole(isInstructor ? "STUDENT" : "INSTRUCTOR")}
          className={cn(
            "relative h-6 w-11 shrink-0 rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-mint-600",
            isInstructor ? "bg-zinc-700" : "bg-mint-600",
          )}
        >
          <span
            className={cn(
              "absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition-transform",
              !isInstructor && "translate-x-5",
            )}
          />
        </button>
        <span
          className={cn(
            "flex items-center gap-1 text-sm",
            !isInstructor ? "font-semibold text-zinc-900" : "text-zinc-500",
          )}
        >
          <GraduationCap className="size-3.5" />
          레슨생
        </span>
        {isInstructor ? (
          <span className="rounded-full bg-zinc-700 px-2.5 py-1 text-xs font-medium text-white">
            정유진 선생님
          </span>
        ) : (
          <select
            id="acting-student"
            aria-label="테스트할 레슨생 선택"
            value={studentId}
            onChange={(e) => setStudent(e.target.value)}
            className="h-7 rounded-full border-0 bg-mint-600 py-0 pr-7 pl-2.5 text-xs font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-mint-600"
          >
            {STUDENTS.map((s, i) => (
              <option key={s.id} value={s.id} className="bg-white text-zinc-900">
                레슨생 {i + 1} · {s.name}
              </option>
            ))}
          </select>
        )}
      </div>
    </header>
  );
}

/**
 * 휴대폰용 테스트 사용자 선택: 강사와 레슨생 전원을 한 목록에서 고른다.
 * (PC 에서는 역할 스위치 + 레슨생 선택을 쓴다)
 */
function ActingUserSelect({ className }: { className?: string }) {
  const role = useCalendarStore((s) => s.role);
  const studentId = useCalendarStore((s) => s.studentId);
  const setRole = useCalendarStore((s) => s.setRole);
  const setStudent = useCalendarStore((s) => s.setStudent);
  const value = role === "INSTRUCTOR" ? INSTRUCTOR.id : studentId;
  return (
    <label className={cn("relative flex items-center", className)}>
      <span className="sr-only">테스트 사용자</span>
      {role === "INSTRUCTOR" ? (
        <Music className="pointer-events-none absolute left-2.5 size-3.5 text-white" />
      ) : (
        <GraduationCap className="pointer-events-none absolute left-2.5 size-3.5 text-white" />
      )}
      <select
        id="acting-user"
        value={value}
        onChange={(e) => (e.target.value === INSTRUCTOR.id ? setRole("INSTRUCTOR") : setStudent(e.target.value))}
        className={cn(
          "h-9 max-w-40 truncate rounded-full border-0 py-0 pr-7 pl-7 text-sm font-medium text-white",
          role === "INSTRUCTOR" ? "bg-zinc-700" : "bg-mint-700",
        )}
      >
        <option value={INSTRUCTOR.id} className="bg-white text-zinc-900">
          강사 · {INSTRUCTOR.name}
        </option>
        {STUDENTS.map((st, i) => (
          <option key={st.id} value={st.id} className="bg-white text-zinc-900">
            레슨생 {i + 1} · {st.name}
          </option>
        ))}
      </select>
    </label>
  );
}
