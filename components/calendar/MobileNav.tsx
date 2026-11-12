"use client";

import { BookOpen, CalendarDays, Inbox, Menu, Users } from "lucide-react";
import type { ReactNode } from "react";
import { fmtDateTime, slotTitle, SLOT_STYLES, useSlotViews } from "@/lib/calendar-items";
import { canResolve } from "@/lib/lesson-machine";
import { cn } from "@/lib/utils";
import { SidebarContent } from "@/components/calendar/Sidebar";
import { useActor, useCalendarStore } from "@/store/calendar-store";
import type { CalendarViewMode } from "@/types/calendar";

/** 내 응답이 필요한 요청 수 (요청 + 아직 아무도 정하지 않은 공휴일 레슨) */
export function useTodoCount(): number {
  const role = useCalendarStore((s) => s.role);
  const lesson = useCalendarStore((s) => s.lesson);
  const actor = useActor();
  const requests = lesson.requests.filter(
    (r) => (role === "INSTRUCTOR" || r.studentId === actor.userId) && canResolve(r, actor),
  ).length;
  const undecided = lesson.slots.filter(
    (s) =>
      s.status === "CONFIRMED" &&
      s.holidayDecision === "UNDECIDED" &&
      !s.requestId &&
      (role === "INSTRUCTOR" || s.studentId === actor.userId),
  ).length;
  return requests + undecided;
}

/** 휴대폰 하단 탭 */
export function BottomNav() {
  const view = useCalendarStore((s) => s.view);
  const role = useCalendarStore((s) => s.role);
  const setView = useCalendarStore((s) => s.setView);
  const closeDrawer = useCalendarStore((s) => s.closeDrawer);
  const todo = useTodoCount();
  const calendar = view === "month" || view === "week";

  const tabs: { id: CalendarViewMode; label: string; icon: ReactNode; active: boolean; badge?: number }[] = [
    { id: calendar ? view : "month", label: "달력", icon: <CalendarDays />, active: calendar },
    { id: "requests", label: "요청", icon: <Inbox />, active: view === "requests", badge: todo },
    role === "INSTRUCTOR"
      ? { id: "students", label: "레슨생", icon: <Users />, active: view === "students" }
      : { id: "plan", label: "내 수강", icon: <BookOpen />, active: view === "plan" },
    { id: "menu", label: "메뉴", icon: <Menu />, active: view === "menu" },
  ];

  return (
    <nav
      aria-label="화면 이동"
      className="grid shrink-0 grid-cols-4 border-t border-zinc-200 bg-white pb-[env(safe-area-inset-bottom)]"
    >
      {tabs.map((t) => (
        <button
          key={t.label}
          type="button"
          aria-current={t.active ? "page" : undefined}
          onClick={() => {
            if (!t.active || !calendar) closeDrawer();
            setView(t.id);
          }}
          className={cn(
            "relative flex h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-medium [&_svg]:size-5",
            t.active ? "text-mint-800" : "text-zinc-500",
          )}
        >
          {t.icon}
          {t.label}
          {!!t.badge && (
            <span className="absolute top-1.5 left-1/2 ml-2 min-w-4 rounded-full bg-amber-500 px-1 text-center text-[10px] leading-4 font-bold text-amber-950">
              {t.badge}
            </span>
          )}
        </button>
      ))}
    </nav>
  );
}

/** 휴대폰 탭 화면: 요청 / 내 수강 / 메뉴 */
export function MobileTabView({ view }: { view: "requests" | "plan" | "menu" }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-zinc-50">
      <div className="flex flex-col gap-5 p-4 [&>section]:rounded-xl [&>section]:bg-white [&>section]:p-3">
        {view === "requests" && <SidebarContent show={["requests"]} />}
        {view === "plan" && (
          <>
            <SidebarContent show={["plan"]} />
            <UpcomingLessons />
          </>
        )}
        {view === "menu" && (
          <SidebarContent
            show={["filters", "students", "legend", "reset"]}
            onFocusNavigate={() => useCalendarStore.getState().setView("month")}
          />
        )}
      </div>
    </div>
  );
}

/** 레슨생: 다가오는 내 레슨 */
function UpcomingLessons() {
  const views = useSlotViews();
  const now = useCalendarStore((s) => s.now);
  const role = useCalendarStore((s) => s.role);
  const openDrawer = useCalendarStore((s) => s.openDrawer);
  const setCursor = useCalendarStore((s) => s.setCursor);
  const upcoming = views
    .filter((v) => v.mine && v.display !== "SKIPPED" && v.slot.end > now)
    .sort((a, b) => a.slot.start.localeCompare(b.slot.start))
    .slice(0, 8);
  return (
    <section aria-label="다가오는 레슨">
      <h2 className="mb-2 text-xs font-semibold text-zinc-500">다가오는 레슨</h2>
      {upcoming.length === 0 ? (
        <p className="text-sm text-zinc-500">예정된 레슨이 없습니다.</p>
      ) : (
        <ul className="space-y-1.5">
          {upcoming.map((v) => (
            <li key={v.slot.id}>
              <button
                type="button"
                onClick={() => {
                  setCursor(new Date(v.slot.start));
                  openDrawer({ type: "slot", slotId: v.slot.id });
                }}
                className={cn(
                  "flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm",
                  SLOT_STYLES[v.display],
                )}
              >
                <span className="shrink-0 tabular-nums">{fmtDateTime(v.slot.start)}</span>
                <span className="truncate font-semibold">{slotTitle(v, role)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
