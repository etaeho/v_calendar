"use client";

import { useEffect, useState } from "react";
import { Drawer } from "@/components/calendar/Drawer";
import { Header } from "@/components/calendar/Header";
import { MonthView } from "@/components/calendar/MonthView";
import { RescheduleBanner } from "@/components/calendar/RescheduleBanner";
import { Sidebar } from "@/components/calendar/Sidebar";
import { ToastHost } from "@/components/calendar/ToastHost";
import { WeekView } from "@/components/calendar/WeekView";
import { useCalendarStore } from "@/store/calendar-store";

export function CalendarApp() {
  const initialized = useCalendarStore((s) => s.initialized);
  const view = useCalendarStore((s) => s.view);
  const drawerOpen = useCalendarStore((s) => s.drawer.type !== "closed");
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Mock 데이터는 '오늘' 기준으로 만들어지므로 브라우저에서만 초기화한다 (정적 export 와 hydration 일치)
  useEffect(() => {
    const { init, tick } = useCalendarStore.getState();
    init();
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

  return (
    <div className="flex h-full flex-col overflow-hidden bg-white">
      <Header onToggleSidebar={() => setSidebarOpen((v) => !v)} />
      <div className="relative flex min-h-0 flex-1">
        <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
        <main className="flex min-w-0 flex-1 flex-col">
          <RescheduleBanner />
          {view === "month" ? <MonthView /> : <WeekView />}
        </main>
        {drawerOpen && <Drawer />}
      </div>
      <ToastHost />
    </div>
  );
}
