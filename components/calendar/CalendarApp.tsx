"use client";

import { useEffect, useState } from "react";
import { Drawer } from "@/components/calendar/Drawer";
import { Header } from "@/components/calendar/Header";
import { BottomNav, MobileTabView } from "@/components/calendar/MobileNav";
import { MonthView } from "@/components/calendar/MonthView";
import { FocusBanner, RescheduleBanner } from "@/components/calendar/RescheduleBanner";
import { Sidebar } from "@/components/calendar/Sidebar";
import { StudentsView } from "@/components/calendar/StudentsView";
import { ToastHost } from "@/components/calendar/ToastHost";
import { WeekView } from "@/components/calendar/WeekView";
import { useIsMobile } from "@/lib/use-mobile";
import { useCalendarStore } from "@/store/calendar-store";

export function CalendarApp() {
  const initialized = useCalendarStore((s) => s.initialized);
  const view = useCalendarStore((s) => s.view);
  const drawerOpen = useCalendarStore((s) => s.drawer.type !== "closed");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const mobile = useIsMobile();

  // Mock 데이터는 '오늘' 기준으로 만들어지므로 브라우저에서만 초기화한다 (정적 export 와 hydration 일치)
  useEffect(() => {
    const { init, tick, setView } = useCalendarStore.getState();
    init();
    // 휴대폰은 월간(선택한 날 목록) 화면으로 시작한다
    if (window.matchMedia("(max-width: 767px)").matches) setView("month");
    const timer = setInterval(tick, 60_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!sidebarOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSidebarOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sidebarOpen]);

  if (!initialized) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-zinc-500">
        캘린더를 불러오는 중…
      </div>
    );
  }

  if (mobile) {
    const calendar = view === "month" || view === "week";
    return (
      <div className="flex h-full flex-col overflow-hidden bg-white">
        <Header onToggleSidebar={() => {}} />
        <main className="flex min-h-0 flex-1 flex-col">
          {calendar && <RescheduleBanner />}
          {calendar && <FocusBanner />}
          {view === "month" && <MonthView />}
          {view === "week" && <WeekView />}
          {view === "students" && <StudentsView />}
          {(view === "requests" || view === "plan" || view === "menu") && <MobileTabView view={view} />}
        </main>
        <BottomNav />
        {drawerOpen && <Drawer />}
        <ToastHost />
      </div>
    );
  }

  // PC: 휴대폰 전용 탭 화면(요청·내 수강·메뉴)은 사이드바에 있으므로 달력으로 보여 준다
  const desktopView = view === "requests" || view === "plan" || view === "menu" ? "month" : view;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-white">
      <Header onToggleSidebar={() => setSidebarOpen((v) => !v)} />
      <div className="relative flex min-h-0 flex-1">
        <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
        <main className="flex min-w-0 flex-1 flex-col">
          <RescheduleBanner />
          {desktopView !== "students" && <FocusBanner />}
          {desktopView === "students" ? (
            <StudentsView />
          ) : desktopView === "month" ? (
            <MonthView />
          ) : (
            <WeekView />
          )}
        </main>
        {drawerOpen && <Drawer />}
      </div>
      <ToastHost />
    </div>
  );
}
