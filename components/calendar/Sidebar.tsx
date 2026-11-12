"use client";

import { BellRing, Check, Hourglass, Loader2, RefreshCw, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fmtDateTime, fmtTime, SLOT_STYLES, timeAgo } from "@/lib/calendar-items";
import { CALENDARS } from "@/lib/calendars";
import { canCancel, canResolve } from "@/lib/lesson-machine";
import { userName } from "@/lib/mock-data";
import { cn } from "@/lib/utils";
import { syncKey, useActor, useCalendarStore } from "@/store/calendar-store";
import type { ExternalProvider, ScheduleRequest, SlotDisplay, UserRole } from "@/types/calendar";

const LEGEND: { display: SlotDisplay; label: string; hint: string }[] = [
  { display: "OPEN", label: "가능", hint: "신청할 수 있는 빈 시간" },
  { display: "CONFIRMED", label: "확정", hint: "정규 · 보강 레슨" },
  { display: "PENDING_BOOKING", label: "승인 대기", hint: "보강 신청 응답 전" },
  { display: "PENDING_CHANGE_FROM", label: "변경 요청", hint: "움직이는 점선" },
  { display: "CLOSED", label: "마감", hint: "다른 레슨생 일정" },
];

const describe = (r: ScheduleRequest, role: UserRole) => {
  const who = role === "INSTRUCTOR" ? `${userName(r.studentId)} · ` : "";
  return r.kind === "BOOKING"
    ? `${who}${fmtDateTime(r.toStart)}`
    : `${who}${fmtDateTime(r.fromStart!)} → ${fmtDateTime(r.toStart)}`;
};

const describeHistory = (r: ScheduleRequest, role: UserRole) =>
  `${r.kind === "BOOKING" ? "보강 신청" : "변경"} ${describe(r, role)}`;

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const role = useCalendarStore((s) => s.role);
  const now = useCalendarStore((s) => s.now);
  const filters = useCalendarStore((s) => s.filters);
  const sync = useCalendarStore((s) => s.sync);
  const requests = useCalendarStore((s) => s.lesson.requests);
  const slots = useCalendarStore((s) => s.lesson.slots);
  const toggleFilter = useCalendarStore((s) => s.toggleFilter);
  const setAllFilters = useCalendarStore((s) => s.setAllFilters);
  const syncCalendar = useCalendarStore((s) => s.syncCalendar);
  const openDrawer = useCalendarStore((s) => s.openDrawer);
  const setCursor = useCalendarStore((s) => s.setCursor);
  const resetDemo = useCalendarStore((s) => s.resetDemo);

  const actor = useActor();
  const allOn = CALENDARS.every((c) => filters[c.id]);

  const mine = requests.filter((r) => role === "INSTRUCTOR" || r.studentId === actor.userId);
  // 오래 기다린 요청이 위로
  const byAge = (a: ScheduleRequest, b: ScheduleRequest) => a.createdAt.localeCompare(b.createdAt);
  const todo = mine.filter((r) => canResolve(r, actor)).sort(byAge);
  const waiting = mine.filter((r) => canCancel(r, actor)).sort(byAge);
  const history = mine
    .filter((r) => r.status !== "PENDING")
    .sort((a, b) => (b.resolvedAt ?? "").localeCompare(a.resolvedAt ?? ""))
    .slice(0, 5);

  const goTo = (r: ScheduleRequest) => {
    // 승인된 변경은 새 슬롯, 그 외에는 유지되는 기존 레슨(없으면 대상 슬롯)으로 이동
    const slotId = r.status === "APPROVED" ? r.toSlotId : (r.fromSlotId ?? r.toSlotId);
    const slot = slots.find((s) => s.id === slotId);
    if (!slot) return;
    setCursor(new Date(slot.start));
    openDrawer({ type: "slot", slotId });
    onClose();
  };

  return (
    <>
      {open && (
        <button
          type="button"
          aria-label="캘린더 목록 닫기"
          className="absolute inset-0 z-20 bg-black/30 lg:hidden"
          onClick={onClose}
        />
      )}
      <aside
        className={cn(
          "z-30 w-64 shrink-0 flex-col gap-5 overflow-y-auto border-r border-zinc-200 bg-white p-4",
          "absolute inset-y-0 left-0 lg:static",
          open ? "flex shadow-xl lg:shadow-none" : "hidden lg:flex",
        )}
      >
        <section>
          <h2 className="mb-2 text-xs font-semibold text-zinc-500">캘린더</h2>
          <ul className="space-y-0.5">
            <li>
              <label className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-zinc-50">
                <input
                  type="checkbox"
                  className="size-4 accent-zinc-700"
                  checked={allOn}
                  onChange={() => setAllFilters(!allOn)}
                />
                <span className="text-sm font-medium">전체보기</span>
              </label>
            </li>
            {CALENDARS.map((c) => {
              const provider = c.id === "LESSON" ? null : (c.id as ExternalProvider);
              const state = provider ? sync[syncKey(actor.userId, provider)] : undefined;
              const syncing = state?.status === "syncing";
              return (
                <li key={c.id} className="rounded-lg px-2 py-1.5 hover:bg-zinc-50">
                  <label className="flex cursor-pointer items-center gap-2.5">
                    <input
                      type="checkbox"
                      className={cn("size-4", c.check)}
                      checked={filters[c.id]}
                      onChange={() => toggleFilter(c.id)}
                    />
                    <span className={cn("size-2.5 rounded-full", c.dot)} />
                    <span className="text-sm">{c.label}</span>
                  </label>
                  {provider && (
                    <div className="mt-1.5 ml-6.5 flex items-center gap-2">
                      <Button
                        size="sm"
                        className="h-7 text-xs"
                        disabled={syncing}
                        onClick={() => syncCalendar(provider)}
                      >
                        {syncing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                        {provider === "GOOGLE" ? "구글" : "카카오"} 캘린더 동기화
                      </Button>
                      {state?.status === "synced" && state.lastSyncedAt && (
                        <span className="flex items-center gap-0.5 text-[11px] text-zinc-500">
                          <Check className="size-3 text-mint-600" />
                          {fmtTime(state.lastSyncedAt)}
                        </span>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>

        <section>
          <h2 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-zinc-500">
            <BellRing className="size-3.5 text-amber-600" />
            내 응답이 필요한 요청
            {todo.length > 0 && (
              <span className="rounded-full bg-amber-500 px-1.5 py-0.5 text-[11px] font-bold text-amber-950">
                {todo.length}
              </span>
            )}
          </h2>
          {todo.length === 0 ? (
            <p className="px-2 text-xs text-zinc-500">처리할 요청이 없습니다.</p>
          ) : (
            <RequestList items={todo} role={role} now={now} onPick={goTo} tone="todo" />
          )}
        </section>

        {waiting.length > 0 && (
          <section>
            <h2 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-zinc-500">
              <Hourglass className="size-3.5" />
              상대방 응답 대기 중
            </h2>
            <RequestList items={waiting} role={role} now={now} onPick={goTo} tone="waiting" />
          </section>
        )}

        {history.length > 0 && (
          <section>
            <h2 className="mb-2 text-xs font-semibold text-zinc-500">최근 처리 내역</h2>
            <ul className="space-y-1.5">
              {history.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => goTo(r)}
                    className="w-full rounded-lg border border-zinc-200 px-2.5 py-2 text-left text-xs hover:bg-zinc-50"
                  >
                  <span
                    className={cn(
                      "mr-1.5 font-semibold",
                      r.status === "APPROVED" && "text-mint-700",
                      r.status === "REJECTED" && "text-red-700",
                      r.status === "CANCELLED" && "text-zinc-500",
                    )}
                  >
                    {r.status === "APPROVED" ? "승인" : r.status === "REJECTED" ? "반려" : "취소"}
                  </span>
                  {describeHistory(r, role)}
                  {r.rejectReason && (
                    <span className="mt-1 block text-zinc-600">사유: {r.rejectReason}</span>
                  )}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section>
          <h2 className="mb-2 text-xs font-semibold text-zinc-500">레슨 상태</h2>
          <ul className="space-y-1.5">
            {LEGEND.filter((l) => role === "STUDENT" || l.display !== "CLOSED").map((l) => (
              <li key={l.display} className="flex items-center gap-2 text-xs text-zinc-700">
                <span className={cn("h-4 w-7 shrink-0 rounded", SLOT_STYLES[l.display])} />
                <span className="shrink-0 font-medium whitespace-nowrap text-zinc-900">{l.label}</span>
                <span className="min-w-0 truncate text-zinc-500" title={l.hint}>
                  {l.hint}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <div className="mt-auto flex items-center justify-between pt-2">
          <Button variant="ghost" size="sm" className="text-xs text-zinc-600" onClick={resetDemo}>
            <RotateCcw />
            데모 데이터 초기화
          </Button>
          <Button variant="ghost" size="icon" className="lg:hidden" aria-label="닫기" onClick={onClose}>
            <X />
          </Button>
        </div>
      </aside>
    </>
  );
}

function RequestList({
  items,
  role,
  now,
  onPick,
  tone,
}: {
  items: ScheduleRequest[];
  role: UserRole;
  now: string;
  onPick: (r: ScheduleRequest) => void;
  tone: "todo" | "waiting";
}) {
  return (
    <ul className="space-y-1.5">
      {items.map((r) => (
        <li key={r.id}>
          <button
            type="button"
            onClick={() => onPick(r)}
            className={cn(
              "w-full rounded-lg border px-2.5 py-2 text-left text-xs transition-colors",
              tone === "todo"
                ? "border-amber-500 bg-amber-50 text-amber-950 hover:bg-amber-100"
                : "border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50",
            )}
          >
            <span className="mb-1 flex items-center justify-between gap-2">
              <span
                className={cn(
                  "rounded px-1.5 py-0.5 text-[11px] font-semibold",
                  r.kind === "BOOKING" ? "bg-amber-200 text-amber-950" : "bg-violet-100 text-violet-900",
                )}
              >
                {r.kind === "BOOKING" ? "보강 신청" : "일정 변경"}
              </span>
              <span className={cn("text-[11px]", tone === "todo" ? "font-semibold text-amber-800" : "text-zinc-500")}>
                {tone === "todo" ? "응답 필요" : "대기 중"} · {timeAgo(r.createdAt, now)}
              </span>
            </span>
            {describe(r, role)}
          </button>
        </li>
      ))}
    </ul>
  );
}
