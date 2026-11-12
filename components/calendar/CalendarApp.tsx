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
import { AuthGate } from "@/components/calendar/AuthGate";
import { completeKakaoLogin, preloadIntegrations, subscribeIntegrationErrors } from "@/lib/integrations";
import { remoteConfigured } from "@/lib/remote";
import { useIsMobile } from "@/lib/use-mobile";
import { useCalendarStore } from "@/store/calendar-store";

export function CalendarApp() {
  const app = <CalendarAppInner />;
  return remoteConfigured() ? <AuthGate>{app}</AuthGate> : app;
}

function CalendarAppInner() {
  const initialized = useCalendarStore((s) => s.initialized);
  const view = useCalendarStore((s) => s.view);
  const drawerOpen = useCalendarStore((s) => s.drawer.type !== "closed");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const mobile = useIsMobile();

  // Mock 데이터는 '오늘' 기준으로 만들어지므로 브라우저에서만 초기화한다 (정적 export 와 hydration 일치)
  useEffect(() => {
    const { init, initServerShell, tick, setView } = useCalendarStore.getState();
    // 서버 모드는 로그인 후 서버 데이터로 채운다 (데모 데이터를 만들지 않음)
    if (remoteConfigured()) initServerShell();
    else init();
    // 휴대폰은 월간(선택한 날 목록) 화면으로 시작한다
    if (window.matchMedia("(max-width: 767px)").matches) setView("month");
    const timer = setInterval(tick, 60_000);
    // 외부 캘린더: 로그인 스크립트 미리 받기, 카카오 로그인에서 돌아왔으면 마무리, 백그라운드 오류 알림
    void preloadIntegrations();
    void completeKakaoLogin().then((r) => {
      const store = useCalendarStore.getState();
      if (r.status === "connected") void store.syncCalendar("KAKAO");
      else if (r.status === "error") store.notify("error", r.error.message);
    });
    const unsubscribe = subscribeIntegrationErrors((e) => useCalendarStore.getState().notify("error", e.message));
    return () => {
      clearInterval(timer);
      unsubscribe();
    };
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
