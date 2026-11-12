"use client";

import { Bell, CalendarClock, CheckCheck, MessageCircle, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { timeAgo } from "@/lib/calendar-items";
import type { AppNotification } from "@/lib/notifications";
import { cn } from "@/lib/utils";
import { useActor, useCalendarStore } from "@/store/calendar-store";

/** 지금 사용자에게 온 알림 (최신순) */
export function useMyNotifications(): AppNotification[] {
  const all = useCalendarStore((s) => s.notifications);
  const { userId } = useActor();
  return all.filter((n) => n.recipient === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** 헤더의 종 아이콘: 안 읽은 알림 수 */
export function NotificationBell({ className }: { className?: string }) {
  const mine = useMyNotifications();
  const openDrawer = useCalendarStore((s) => s.openDrawer);
  const unread = mine.filter((n) => !n.readAt).length;
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn("relative size-10", className)}
      aria-label={unread > 0 ? `알림 ${unread}개 안 읽음` : "알림"}
      onClick={() => openDrawer({ type: "notifications" })}
    >
      <Bell />
      {unread > 0 && (
        <span className="absolute top-1 right-1 min-w-4 rounded-full bg-coral-600 px-1 text-center text-[10px] leading-4 font-bold text-white">
          {unread > 9 ? "9+" : unread}
        </span>
      )}
    </Button>
  );
}

const ICON = {
  REQUEST: <Send className="size-4 text-amber-700" />,
  RESOLVED: <CalendarClock className="size-4 text-mint-700" />,
  MESSAGE: <MessageCircle className="size-4 text-sky-700" />,
};

/** 알림 목록 (상세 창 안). 열면 모두 읽음으로 표시한다 */
export function NotificationsPanel() {
  const mine = useMyNotifications();
  const now = useCalendarStore((s) => s.now);
  const slots = useCalendarStore((s) => s.lesson.slots);
  const openDrawer = useCalendarStore((s) => s.openDrawer);
  const setCursor = useCalendarStore((s) => s.setCursor);
  const markRead = useCalendarStore((s) => s.markNotificationsRead);
  const unread = mine.filter((n) => !n.readAt).length;

  return (
    <div className="flex-1 overflow-y-auto p-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs text-zinc-500">
          {mine.length === 0 ? "아직 알림이 없습니다." : `안 읽음 ${unread}개 · 전체 ${mine.length}개`}
        </p>
        {unread > 0 && (
          <Button size="sm" variant="ghost" className="text-xs" onClick={markRead}>
            <CheckCheck />
            모두 읽음
          </Button>
        )}
      </div>
      <ul className="space-y-1.5">
        {mine.map((n) => {
          const slot = n.slotId ? slots.find((s) => s.id === n.slotId) : undefined;
          return (
            <li key={n.id}>
              <button
                type="button"
                disabled={!slot}
                onClick={() => {
                  if (!slot) return;
                  markRead();
                  setCursor(new Date(slot.start));
                  openDrawer({ type: "slot", slotId: slot.id });
                }}
                className={cn(
                  "flex w-full items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left",
                  n.readAt ? "border-zinc-200 bg-white" : "border-amber-300 bg-amber-50",
                  slot ? "hover:bg-zinc-50" : "cursor-default",
                )}
              >
                <span className="mt-0.5 shrink-0">{ICON[n.kind]}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-zinc-900">{n.title}</span>
                  <span className="block text-xs text-zinc-600">{n.body}</span>
                </span>
                <span className="shrink-0 text-[11px] text-zinc-500">{timeAgo(n.createdAt, now)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
