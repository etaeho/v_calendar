"use client";

import { BellRing, BookOpen, Check, Hourglass, Loader2, RefreshCw, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  fmtDateTime,
  fmtDay,
  fmtTime,
  REQUEST_KIND_CHIP,
  requestKindLabel,
  SLOT_STYLES,
  timeAgo,
  won,
} from "@/lib/calendar-items";
import {
  activeEnrollments,
  daysLeft,
  monthProgress,
  nextPaymentDate,
  planLabel,
  timesLabel,
} from "@/lib/enrollment";
import { CALENDARS } from "@/lib/calendars";
import { canCancel, canResolve, makeupSummary } from "@/lib/lesson-machine";
import { studentColor } from "@/lib/student-colors";
import { STUDENTS, userName } from "@/lib/mock-data";
import { cn } from "@/lib/utils";
import { syncKey, useActor, useCalendarStore } from "@/store/calendar-store";
import type { ExternalProvider, ScheduleRequest, SlotDisplay, UserRole } from "@/types/calendar";

const LEGEND: { display: SlotDisplay; label: string; hint: string }[] = [
  { display: "OPEN", label: "가능", hint: "신청할 수 있는 빈 시간" },
  { display: "CONFIRMED", label: "확정", hint: "정규 · 보강 레슨" },
  { display: "PENDING_BOOKING", label: "승인 대기", hint: "응답·결정이 필요한 일정" },
  { display: "PENDING_CHANGE_FROM", label: "변경 요청", hint: "움직이는 점선" },
  { display: "SKIPPED", label: "휴강", hint: "쉬기로 한 레슨" },
  { display: "CLOSED", label: "마감", hint: "다른 레슨생 일정" },
];

const describe = (r: ScheduleRequest, role: UserRole) => {
  const who = role === "INSTRUCTOR" ? `${userName(r.studentId)} · ` : "";
  if (r.kind === "DEFER") return `${who}${fmtDateTime(r.toStart)} 레슨 → 보강으로`;
  if (r.kind === "HOLIDAY")
    return `${who}${fmtDateTime(r.toStart)} · ${r.holidayProposal === "SKIP" ? "휴강" : "그대로 진행"} 제안`;
  return r.kind === "BOOKING"
    ? `${who}${fmtDateTime(r.toStart)}`
    : `${who}${fmtDateTime(r.fromStart!)} → ${fmtDateTime(r.toStart)}`;
};

const describeHistory = (r: ScheduleRequest, role: UserRole) =>
  `${requestKindLabel(r)} ${describe(r, role)}`;

const HISTORY_STATUS: Record<string, { text: string; cls: string }> = {
  APPROVED: { text: "승인", cls: "text-mint-700" },
  REJECTED: { text: "반려", cls: "text-red-700" },
  CANCELLED: { text: "취소", cls: "text-zinc-500" },
  EXPIRED: { text: "만료", cls: "text-zinc-500" },
};

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const role = useCalendarStore((s) => s.role);
  const now = useCalendarStore((s) => s.now);
  const filters = useCalendarStore((s) => s.filters);
  const sync = useCalendarStore((s) => s.sync);
  const requests = useCalendarStore((s) => s.lesson.requests);
  const slots = useCalendarStore((s) => s.lesson.slots);
  const lesson = useCalendarStore((s) => s.lesson);
  const toggleFilter = useCalendarStore((s) => s.toggleFilter);
  const setAllFilters = useCalendarStore((s) => s.setAllFilters);
  const syncCalendar = useCalendarStore((s) => s.syncCalendar);
  const openDrawer = useCalendarStore((s) => s.openDrawer);
  const setCursor = useCalendarStore((s) => s.setCursor);
  const resetDemo = useCalendarStore((s) => s.resetDemo);
  const focusStudentId = useCalendarStore((s) => s.focusStudentId);
  const setFocusStudent = useCalendarStore((s) => s.setFocusStudent);

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

  // 아직 아무도 제안하지 않은 공휴일 레슨 (강사는 전체, 레슨생은 본인 것)
  const undecided = slots
    .filter(
      (s) =>
        s.status === "CONFIRMED" &&
        s.holidayDecision === "UNDECIDED" &&
        !s.requestId &&
        (role === "INSTRUCTOR" || s.studentId === actor.userId),
    )
    .sort((a, b) => a.start.localeCompare(b.start));
  const todoCount = todo.length + undecided.length;
  const myPlans = role === "STUDENT" ? activeEnrollments(lesson, actor.userId, now) : [];

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

        {myPlans.map((plan) => {
          const left = daysLeft(plan, now);
          const progress = monthProgress(lesson, plan, now);
          const due = nextPaymentDate(plan, now);
          return (
            <section key={plan.id} aria-label="내 수강 정보" className="rounded-xl border border-zinc-200 p-3 text-xs">
              <h2 className="mb-1.5 flex items-center gap-1.5 font-semibold text-zinc-500">
                <BookOpen className="size-3.5" />
                내 수강
              </h2>
              <p className="text-sm font-semibold text-zinc-900">{planLabel(plan)}</p>
              <p className="text-zinc-700">{timesLabel(plan.times)}</p>
              <dl className="mt-2 space-y-1 text-zinc-700">
                <div className="flex justify-between gap-2">
                  <dt className="text-zinc-500">등록 기간</dt>
                  <dd className="text-right tabular-nums">
                    {plan.startDate.replaceAll("-", ".")} ~ {plan.endDate.slice(2).replaceAll("-", ".")}
                    {left <= 14 && (
                      <span className="ml-1 rounded bg-coral-100 px-1 font-semibold text-coral-800">
                        종료 D-{left}
                      </span>
                    )}
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-zinc-500">이번 달</dt>
                  <dd className="tabular-nums">
                    {progress.total + progress.skipped === 0
                      ? "레슨 없음"
                      : `${progress.done}/${progress.total}회 진행`}
                    {progress.skipped > 0 && ` · 미진행 ${progress.skipped}`}
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-zinc-500">일정 변경</dt>
                  <dd>
                    {plan.changeDeadlineHours > 0
                      ? `레슨 ${plan.changeDeadlineHours}시간 전까지`
                      : "제한 없음"}
                  </dd>
                </div>
                <MakeupRow studentId={plan.studentId} />
                {plan.fee !== undefined && (
                  <div className="flex justify-between gap-2">
                    <dt className="text-zinc-500">결제 예정</dt>
                    <dd className="tabular-nums">
                      {due ? `${fmtDay(due)} · ${won(plan.fee)}` : `남은 결제 없음 (월 ${won(plan.fee)})`}
                    </dd>
                  </div>
                )}
              </dl>
            </section>
          );
        })}

        <section>
          <h2 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-zinc-500">
            <BellRing className="size-3.5 text-amber-600" />
            내 응답이 필요한 요청
            {todoCount > 0 && (
              <span className="rounded-full bg-amber-500 px-1.5 py-0.5 text-[11px] font-bold text-amber-950">
                {todoCount}
              </span>
            )}
          </h2>
          {todoCount === 0 ? (
            <p className="px-2 text-xs text-zinc-500">처리할 요청이 없습니다.</p>
          ) : (
            <div className="space-y-1.5">
              <RequestList items={todo} role={role} now={now} onPick={goTo} tone="todo" />
              <ul className="space-y-1.5">
                {undecided.map((slot) => (
                  <li key={slot.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setCursor(new Date(slot.start));
                        openDrawer({ type: "slot", slotId: slot.id });
                        onClose();
                      }}
                      className="w-full rounded-lg border border-amber-500 bg-amber-50 px-2.5 py-2 text-left text-xs text-amber-950 transition-colors hover:bg-amber-100"
                    >
                      <span className="mb-1 flex items-center justify-between gap-2">
                        <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-semibold", REQUEST_KIND_CHIP.HOLIDAY)}>
                          공휴일 결정
                        </span>
                        <span className="text-[11px] font-semibold text-amber-800">{slot.holidayName}</span>
                      </span>
                      {role === "INSTRUCTOR" ? `${userName(slot.studentId)} · ` : ""}
                      {fmtDateTime(slot.start)} · 진행/휴강을 정해 주세요
                    </button>
                  </li>
                ))}
              </ul>
            </div>
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
                  <span className={cn("mr-1.5 font-semibold", HISTORY_STATUS[r.status]?.cls)}>
                    {HISTORY_STATUS[r.status]?.text}
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

        {role === "INSTRUCTOR" && (
          <section aria-label="레슨생">
            <h2 className="mb-2 flex items-center justify-between text-xs font-semibold text-zinc-500">
              레슨생 · 남은 보강
              {focusStudentId && (
                <button
                  type="button"
                  onClick={() => setFocusStudent(null)}
                  className="rounded px-1.5 py-0.5 text-[11px] font-medium text-mint-700 hover:bg-mint-50"
                >
                  모두 보기
                </button>
              )}
            </h2>
            <ul className="space-y-0.5">
              {STUDENTS.map((st) => {
                const m = makeupSummary(lesson, st.id, now);
                const active = focusStudentId === st.id;
                return (
                  <li key={st.id}>
                    <button
                      type="button"
                      aria-pressed={active}
                      onClick={() => setFocusStudent(active ? null : st.id)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-zinc-50",
                        active && "bg-zinc-100 font-semibold",
                      )}
                    >
                      <span className={cn("size-3 shrink-0 rounded-full", studentColor(st.id)?.dot)} />
                      <span className="flex-1">{st.name}</span>
                      <span
                        className={cn(
                          "rounded-full px-1.5 text-[11px] tabular-nums",
                          m.remaining > 0 ? "bg-orange-100 font-semibold text-orange-900" : "text-zinc-400",
                        )}
                        title={`보강 필요 ${m.owed} · 완료 ${m.done} · 예정 ${m.scheduled}`}
                      >
                        {m.remaining > 0 ? `보강 ${m.remaining}` : m.remaining < 0 ? `추가 ${-m.remaining}` : "0"}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <p className="mt-1 px-2 text-[11px] text-zinc-500">이름을 누르면 그 레슨생 일정만 강조합니다.</p>
          </section>
        )}

        <section>
          <h2 className="mb-2 text-xs font-semibold text-zinc-500">레슨 상태</h2>
          <ul className="space-y-1.5">
            {LEGEND.filter((l) => role === "STUDENT" || l.display !== "CLOSED").map((l) => (
              <li key={l.display} className="flex items-center gap-2 text-xs text-zinc-700">
                {role === "INSTRUCTOR" && l.display === "CONFIRMED" ? (
                  <span className="flex h-4 w-7 shrink-0 overflow-hidden rounded" aria-hidden>
                    {STUDENTS.map((st) => (
                      <span key={st.id} className={cn("flex-1", studentColor(st.id)?.dot)} />
                    ))}
                  </span>
                ) : (
                  <span className={cn("h-4 w-7 shrink-0 rounded", SLOT_STYLES[l.display])} />
                )}
                <span className="shrink-0 font-medium whitespace-nowrap text-zinc-900">{l.label}</span>
                <span className="min-w-0 truncate text-zinc-500" title={l.hint}>
                  {role === "INSTRUCTOR" && l.display === "CONFIRMED" ? "레슨생별 색" : l.hint}
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
                  REQUEST_KIND_CHIP[r.kind],
                )}
              >
                {requestKindLabel(r)}
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

/** 레슨생 '내 수강' 카드의 보강 현황 */
function MakeupRow({ studentId }: { studentId: string }) {
  const lesson = useCalendarStore((s) => s.lesson);
  const now = useCalendarStore((s) => s.now);
  const m = makeupSummary(lesson, studentId, now);
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-zinc-500">보강</dt>
      <dd className="text-right tabular-nums">
        <span className={cn(m.remaining > 0 && "font-semibold text-orange-800")}>
          {m.remaining >= 0 ? `남은 ${m.remaining}회` : `추가 레슨 ${-m.remaining}회`}
        </span>
        <span className="text-zinc-500">
          {" "}
          · 예정 {m.scheduled}
          {m.requested > 0 && ` · 신청 중 ${m.requested}`}
        </span>
      </dd>
    </div>
  );
}
