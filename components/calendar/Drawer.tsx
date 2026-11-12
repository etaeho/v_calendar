"use client";

import { addMinutes, format, isSameDay, startOfDay } from "date-fns";
import {
  AlertTriangle,
  ArrowDown,
  ArrowRightLeft,
  CalendarClock,
  Check,
  Lock,
  MapPin,
  Plus,
  Send,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  conflictsFor,
  fmtDay,
  fmtRange,
  fmtTime,
  itemClass,
  itemsOnDay,
  itemTitle,
  SLOT_STYLES,
  slotTitle,
  STATUS_LABEL,
  useCalendarItems,
  useItemClick,
  useMyExternalEvents,
  useSlotViews,
} from "@/lib/calendar-items";
import { calendarLabel } from "@/lib/calendars";
import { canCancel, canResolve } from "@/lib/lesson-machine";
import { userName } from "@/lib/mock-data";
import { cn } from "@/lib/utils";
import { actorForRole, useCalendarStore } from "@/store/calendar-store";
import type { ExternalEvent, SlotView } from "@/types/calendar";

export function Drawer() {
  const drawer = useCalendarStore((s) => s.drawer);
  const close = useCalendarStore((s) => s.closeDrawer);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  let title = "";
  let body: ReactNode = null;
  if (drawer.type === "day") {
    title = fmtDay(drawer.date);
    body = <DayPanel key={drawer.date} date={drawer.date} />;
  } else if (drawer.type === "slot") {
    title = "레슨 일정";
    body = <SlotPanel key={drawer.slotId} slotId={drawer.slotId} />;
  } else if (drawer.type === "external") {
    title = "개인 일정";
    body = <ExternalPanel eventId={drawer.eventId} />;
  } else if (drawer.type === "reschedule") {
    title = "일정 변경 요청";
    body = (
      <ReschedulePanel key={drawer.fromSlotId} fromSlotId={drawer.fromSlotId} toSlotId={drawer.toSlotId} />
    );
  }

  return (
    <aside
      aria-label={title}
      className="absolute inset-y-0 right-0 z-40 flex w-full max-w-sm animate-slide-in flex-col border-l border-zinc-200 bg-white shadow-2xl xl:static xl:w-96 xl:shadow-none"
    >
      <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-2.5">
        <h2 className="text-base font-bold">{title}</h2>
        <Button variant="ghost" size="icon" aria-label="닫기" onClick={close}>
          <X />
        </Button>
      </div>
      {body}
    </aside>
  );
}

/* ------------------------------------------------------------------ */
/* 날짜 상세                                                            */
/* ------------------------------------------------------------------ */

function DayPanel({ date }: { date: string }) {
  const role = useCalendarStore((s) => s.role);
  const createSlot = useCalendarStore((s) => s.createSlot);
  const openDrawer = useCalendarStore((s) => s.openDrawer);
  const items = itemsOnDay(useCalendarItems(), new Date(date));
  const onItemClick = useItemClick();
  const [start, setStart] = useState("18:00");
  const [end, setEnd] = useState("19:00");

  const submit = () => {
    const base = startOfDay(new Date(date));
    const toDate = (hhmm: string) => {
      const [h, m] = hhmm.split(":").map(Number);
      return addMinutes(base, h * 60 + m);
    };
    const id = createSlot(toDate(start), toDate(end));
    if (id) openDrawer({ type: "slot", slotId: id });
  };

  return (
    <div className="flex-1 space-y-4 overflow-y-auto p-4">
      {items.length === 0 ? (
        <p className="rounded-lg bg-zinc-50 px-3 py-6 text-center text-sm text-zinc-500">
          이 날은 표시할 일정이 없습니다.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => onItemClick(item)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm",
                  itemClass(item),
                )}
              >
                <span className="shrink-0 tabular-nums opacity-85">
                  {fmtTime(item.start)}–{fmtTime(item.end)}
                </span>
                <span className="truncate font-semibold">{itemTitle(item, role)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {role === "INSTRUCTOR" && (
        <section className="rounded-xl border border-dashed border-mint-500 bg-mint-50/60 p-3">
          <h3 className="mb-2 text-sm font-semibold text-mint-800">레슨 가능 슬롯 열기</h3>
          <div className="flex items-end gap-2">
            <label className="flex-1 text-xs text-zinc-600">
              시작
              <input
                type="time"
                step={1800}
                value={start}
                onChange={(e) => setStart(e.target.value)}
                className="mt-1 block h-9 w-full rounded-lg border border-zinc-300 bg-white px-2 text-sm text-zinc-900"
              />
            </label>
            <label className="flex-1 text-xs text-zinc-600">
              종료
              <input
                type="time"
                step={1800}
                value={end}
                onChange={(e) => setEnd(e.target.value)}
                className="mt-1 block h-9 w-full rounded-lg border border-zinc-300 bg-white px-2 text-sm text-zinc-900"
              />
            </label>
            <Button variant="primary" className="h-9" onClick={submit} disabled={!start || !end}>
              <Plus />
              추가
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 개인(외부 캘린더) 일정 상세                                          */
/* ------------------------------------------------------------------ */

function ExternalPanel({ eventId }: { eventId: string }) {
  const event = useCalendarStore((s) => s.externalEvents.find((e) => e.id === eventId));
  const views = useSlotViews();
  const role = useCalendarStore((s) => s.role);
  const openDrawer = useCalendarStore((s) => s.openDrawer);
  if (!event) return <Empty>일정을 찾을 수 없습니다.</Empty>;

  const overlapping = views.filter(
    (v) => !v.masked && conflictsFor(v.slot, [event]).length > 0,
  );

  return (
    <div className="flex-1 space-y-4 overflow-y-auto p-4">
      <div>
        <span
          className={cn(
            "inline-block rounded-full px-2.5 py-0.5 text-xs font-medium",
            event.provider === "GOOGLE" ? "bg-blue-100 text-blue-900" : "bg-coral-100 text-coral-800",
          )}
        >
          {calendarLabel(event.provider)}
        </span>
        <h3 className="mt-2 text-lg font-bold">{event.title}</h3>
        <p className="mt-1 flex items-center gap-1.5 text-sm text-zinc-700">
          <CalendarClock className="size-4 text-zinc-500" />
          {fmtRange(event.start, event.end)}
        </p>
        {event.location && (
          <p className="mt-1 flex items-center gap-1.5 text-sm text-zinc-700">
            <MapPin className="size-4 text-zinc-500" />
            {event.location}
          </p>
        )}
      </div>
      {overlapping.length > 0 && (
        <section>
          <h4 className="mb-1.5 text-xs font-semibold text-zinc-500">이 일정과 겹치는 레슨 시간</h4>
          <ul className="space-y-1.5">
            {overlapping.map((v) => (
              <li key={v.slot.id}>
                <button
                  type="button"
                  onClick={() => openDrawer({ type: "slot", slotId: v.slot.id })}
                  className={cn(
                    "w-full rounded-lg px-3 py-2 text-left text-sm",
                    SLOT_STYLES[v.display],
                  )}
                >
                  <span className="font-semibold">{slotTitle(v, role)}</span>{" "}
                  <span className="tabular-nums opacity-85">
                    {fmtTime(v.slot.start)}–{fmtTime(v.slot.end)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="text-xs text-zinc-500">
        외부 캘린더에서 가져온 읽기 전용 일정입니다. (MVP: Mock 데이터)
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 레슨 슬롯 상세                                                       */
/* ------------------------------------------------------------------ */

function SlotPanel({ slotId }: { slotId: string }) {
  const role = useCalendarStore((s) => s.role);
  const now = useCalendarStore((s) => s.now);
  const store = useCalendarStore.getState;
  const views = useSlotViews();
  const myEvents = useMyExternalEvents();
  const [message, setMessage] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");

  const view = views.find((v) => v.slot.id === slotId);
  if (!view) return <Empty>삭제되었거나 볼 수 없는 슬롯입니다.</Empty>;

  const { slot, display, request } = view;
  const actor = actorForRole(role);
  const isPast = new Date(slot.start) < new Date(now);

  if (view.masked) {
    return (
      <div className="flex-1 p-4">
        <StatusBadge view={view} />
        <p className="mt-3 text-sm font-semibold text-zinc-800">{fmtRange(slot.start, slot.end)}</p>
        <p className="mt-4 flex items-start gap-2 rounded-lg bg-zinc-50 px-3 py-3 text-sm text-zinc-600">
          <Lock className="mt-0.5 size-4 shrink-0" />
          다른 레슨생의 일정이 있어 마감된 시간입니다. 상세 내용은 표시되지 않습니다.
        </p>
      </div>
    );
  }

  const conflicts = conflictsFor(slot, myEvents);
  const linkedId =
    request?.kind === "CHANGE"
      ? display === "PENDING_CHANGE_FROM"
        ? request.toSlotId
        : request.fromSlotId
      : undefined;
  const linked = views.find((v) => v.slot.id === linkedId);
  const fromView = display === "PENDING_CHANGE_FROM" ? view : linked;
  const toView = display === "PENDING_CHANGE_TO" ? view : linked;

  const resolvable = !!request && canResolve(request, actor);
  const cancellable = !!request && canCancel(request, actor);

  return (
    <>
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        <div>
          <StatusBadge view={view} />
          <h3 className="mt-2 text-lg font-bold">{slotTitle(view, role)}</h3>
          <p className="mt-1 flex items-center gap-1.5 text-sm text-zinc-700">
            <CalendarClock className="size-4 text-zinc-500" />
            {fmtRange(slot.start, slot.end)}
          </p>
          {slot.studentId && (
            <p className="mt-1 text-sm text-zinc-600">
              레슨생 {userName(slot.studentId)} · {slot.lessonType === "MAKEUP" ? "보강" : "정규"} 레슨
            </p>
          )}
        </div>

        {request?.kind === "CHANGE" && fromView && toView && (
          <section className="rounded-xl border border-violet-200 bg-violet-50 p-3 text-sm">
            <h4 className="mb-2 flex items-center gap-1.5 font-semibold text-violet-900">
              <ArrowRightLeft className="size-4" />
              일정 변경 요청 ({request.requestedBy === "INSTRUCTOR" ? "강사" : "레슨생"} 요청)
            </h4>
            <LinkRow label="기존" view={fromView} active={fromView === view} />
            <ArrowDown className="mx-auto my-1 size-4 text-violet-500" />
            <LinkRow label="변경" view={toView} active={toView === view} />
          </section>
        )}

        {conflicts.length > 0 && <ConflictNotice events={conflicts} />}

        {/* ---- 역할·상태별 액션 ---- */}
        <section className="space-y-2">
          {display === "OPEN" && role === "STUDENT" && (
            isPast ? (
              <Hint>이미 지난 시간이라 신청할 수 없습니다.</Hint>
            ) : (
              <>
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="강사에게 남길 메시지 (선택)"
                  rows={2}
                  className="w-full resize-none rounded-lg border border-zinc-300 px-3 py-2 text-sm placeholder:text-zinc-400"
                />
                <Button
                  variant="primary"
                  className="w-full"
                  onClick={() => {
                    store().bookSlot(slot.id, message);
                    setMessage("");
                  }}
                >
                  <Plus />
                  보강 신청
                </Button>
              </>
            )
          )}

          {display === "OPEN" && role === "INSTRUCTOR" && (
            <>
              <Hint>레슨생에게 신청 가능한 빈 슬롯으로 보입니다.</Hint>
              <Button variant="danger" className="w-full" onClick={() => store().deleteSlot(slot.id)}>
                <Trash2 />
                슬롯 삭제
              </Button>
            </>
          )}

          {display === "CONFIRMED" && (
            <>
              <Button className="w-full" onClick={() => store().startReschedule(slot.id)}>
                <ArrowRightLeft />
                일정 변경 요청
              </Button>
              <Hint>
                {role === "INSTRUCTOR"
                  ? "변경할 빈 슬롯을 지정하면 레슨생의 동의 후 확정됩니다."
                  : "변경할 빈 슬롯을 지정하면 강사의 승인 후 확정됩니다."}
              </Hint>
            </>
          )}

          {resolvable && request && !rejecting && (
            <div className="flex gap-2">
              <Button variant="primary" className="flex-1" onClick={() => store().approve(request.id)}>
                <Check />
                {role === "INSTRUCTOR" ? "승인" : "동의"}
              </Button>
              <Button variant="danger" className="flex-1" onClick={() => setRejecting(true)}>
                <X />
                거절
              </Button>
            </div>
          )}

          {resolvable && request && rejecting && (
            <div className="space-y-2 rounded-xl border border-red-200 bg-red-50 p-3">
              <label className="block text-sm font-medium text-red-900">
                거절 사유
                <textarea
                  autoFocus
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="상대방에게 전달할 사유를 적어 주세요 (선택)"
                  rows={2}
                  className="mt-1 w-full resize-none rounded-lg border border-red-200 bg-white px-3 py-2 text-sm font-normal text-zinc-900 placeholder:text-zinc-400"
                />
              </label>
              <div className="flex gap-2">
                <Button className="flex-1" onClick={() => setRejecting(false)}>
                  돌아가기
                </Button>
                <Button
                  variant="danger"
                  className="flex-1"
                  onClick={() => {
                    store().reject(request.id, reason);
                    setRejecting(false);
                    setReason("");
                  }}
                >
                  거절 확정
                </Button>
              </div>
            </div>
          )}

          {cancellable && request && (
            <>
              <Hint>
                {request.requestedBy === "INSTRUCTOR"
                  ? "레슨생의 동의를 기다리는 중입니다."
                  : "강사의 승인을 기다리는 중입니다."}
              </Hint>
              <Button className="w-full" onClick={() => store().cancel(request.id)}>
                {request.kind === "BOOKING" ? "보강 신청 취소" : "변경 요청 취소"}
              </Button>
            </>
          )}
        </section>

        {display !== "OPEN" && <CommentThread threadId={slot.threadId} />}
      </div>
      {display !== "OPEN" && <CommentInput slotId={slot.id} />}
    </>
  );
}

function LinkRow({ label, view, active }: { label: string; view: SlotView; active: boolean }) {
  const openDrawer = useCalendarStore((s) => s.openDrawer);
  const setCursor = useCalendarStore((s) => s.setCursor);
  return (
    <button
      type="button"
      disabled={active}
      onClick={() => {
        setCursor(new Date(view.slot.start));
        openDrawer({ type: "slot", slotId: view.slot.id });
      }}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg border bg-white px-3 py-2 text-left",
        active ? "border-violet-500 font-semibold" : "border-violet-200 hover:bg-violet-100",
      )}
    >
      <span className="shrink-0 rounded bg-violet-100 px-1.5 py-0.5 text-xs text-violet-900">
        {label}
      </span>
      <span className="tabular-nums">{fmtRange(view.slot.start, view.slot.end)}</span>
      {active && <span className="ml-auto text-xs font-normal text-violet-700">보는 중</span>}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* 일정 변경: 대상 슬롯 선택                                            */
/* ------------------------------------------------------------------ */

function ReschedulePanel({ fromSlotId, toSlotId }: { fromSlotId: string; toSlotId?: string }) {
  const role = useCalendarStore((s) => s.role);
  const now = useCalendarStore((s) => s.now);
  const store = useCalendarStore.getState;
  const views = useSlotViews();
  const myEvents = useMyExternalEvents();
  const [message, setMessage] = useState("");

  const from = views.find((v) => v.slot.id === fromSlotId);
  if (!from) return <Empty>레슨을 찾을 수 없습니다.</Empty>;

  const candidates = views
    .filter((v) => v.display === "OPEN" && v.slot.start > now)
    .sort((a, b) => a.slot.start.localeCompare(b.slot.start));

  return (
    <>
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        <section>
          <h4 className="mb-1.5 text-xs font-semibold text-zinc-500">기존 레슨</h4>
          <div className={cn("rounded-lg px-3 py-2 text-sm", SLOT_STYLES.CONFIRMED)}>
            <span className="font-semibold">{slotTitle(from, role)}</span>
            <span className="ml-2 tabular-nums opacity-90">{fmtRange(from.slot.start, from.slot.end)}</span>
          </div>
        </section>

        <fieldset>
          <legend className="mb-1.5 text-xs font-semibold text-zinc-500">
            변경할 빈 슬롯 선택 (달력에서 점선 슬롯을 눌러도 됩니다)
          </legend>
          {candidates.length === 0 ? (
            <Hint>선택할 수 있는 빈 슬롯이 없습니다.</Hint>
          ) : (
            <ul className="space-y-1.5">
              {candidates.map((v) => {
                const conflicts = conflictsFor(v.slot, myEvents);
                const selected = v.slot.id === toSlotId;
                return (
                  <li key={v.slot.id}>
                    <label
                      className={cn(
                        "flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 text-sm",
                        selected
                          ? "border-violet-500 bg-violet-50"
                          : "border-zinc-200 hover:bg-zinc-50",
                      )}
                    >
                      <input
                        type="radio"
                        name="reschedule-target"
                        className="mt-0.5 size-4 accent-violet-600"
                        checked={selected}
                        onChange={() => {
                          store().setCursor(new Date(v.slot.start));
                          store().pickRescheduleTarget(v.slot.id);
                        }}
                      />
                      <span className="min-w-0">
                        <span className="tabular-nums">{fmtRange(v.slot.start, v.slot.end)}</span>
                        {conflicts.length > 0 && (
                          <span className="mt-0.5 flex items-center gap-1 text-xs text-amber-800">
                            <AlertTriangle className="size-3 shrink-0" />
                            내 일정과 겹침: {conflicts.map((c) => c.title).join(", ")}
                          </span>
                        )}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </fieldset>

        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="변경 사유 (선택)"
          rows={2}
          className="w-full resize-none rounded-lg border border-zinc-300 px-3 py-2 text-sm placeholder:text-zinc-400"
        />
      </div>
      <div className="flex gap-2 border-t border-zinc-200 p-3">
        <Button className="flex-1" onClick={() => store().openDrawer({ type: "slot", slotId: fromSlotId })}>
          취소
        </Button>
        <Button
          variant="primary"
          className="flex-1"
          disabled={!toSlotId}
          onClick={() => store().submitReschedule(message)}
        >
          <Send />
          변경 요청 보내기
        </Button>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 댓글 (미니 채팅)                                                     */
/* ------------------------------------------------------------------ */

function CommentThread({ threadId }: { threadId: string }) {
  const comments = useCalendarStore((s) => s.lesson.comments);
  const role = useCalendarStore((s) => s.role);
  const meId = actorForRole(role).userId;
  const thread = comments.filter((c) => c.threadId === threadId);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [thread.length]);

  return (
    <section>
      <h4 className="mb-2 text-xs font-semibold text-zinc-500">댓글 {thread.length > 0 && thread.length}</h4>
      {thread.length === 0 ? (
        <p className="rounded-lg bg-zinc-50 px-3 py-4 text-center text-xs text-zinc-500">
          아직 댓글이 없습니다. 첫 메시지를 남겨 보세요.
        </p>
      ) : (
        <ol className="space-y-2.5">
          {thread.map((c, i) => {
            const prev = thread[i - 1];
            const newDay = !prev || !isSameDay(new Date(prev.createdAt), new Date(c.createdAt));
            const mine = c.authorId === meId;
            return (
              <li key={c.id}>
                {newDay && (
                  <p className="mb-2 text-center text-[11px] text-zinc-400">{fmtDay(c.createdAt)}</p>
                )}
                {c.kind === "SYSTEM" ? (
                  <p className="mx-auto w-fit max-w-[90%] rounded-full bg-zinc-100 px-3 py-1 text-center text-xs text-zinc-600">
                    {c.body}
                  </p>
                ) : (
                  <div className={cn("flex flex-col", mine ? "items-end" : "items-start")}>
                    {!mine && (
                      <span className="mb-0.5 text-xs text-zinc-500">{userName(c.authorId)}</span>
                    )}
                    <div className={cn("flex max-w-[85%] items-end gap-1.5", mine && "flex-row-reverse")}>
                      <p
                        className={cn(
                          "rounded-2xl px-3 py-1.5 text-sm break-words whitespace-pre-wrap",
                          mine
                            ? "rounded-br-sm bg-mint-600 text-white"
                            : "rounded-bl-sm bg-zinc-100 text-zinc-900",
                        )}
                      >
                        {c.body}
                      </p>
                      <time className="shrink-0 text-[10px] text-zinc-400 tabular-nums">
                        {format(new Date(c.createdAt), "HH:mm")}
                      </time>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
      <div ref={endRef} />
    </section>
  );
}

function CommentInput({ slotId }: { slotId: string }) {
  const comment = useCalendarStore((s) => s.comment);
  const [text, setText] = useState("");
  return (
    <form
      className="flex gap-2 border-t border-zinc-200 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!text.trim()) return;
        comment(slotId, text);
        setText("");
      }}
    >
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="댓글 입력…"
        aria-label="댓글 입력"
        className="h-10 min-w-0 flex-1 rounded-full border border-zinc-300 px-4 text-sm placeholder:text-zinc-400"
      />
      <Button
        type="submit"
        variant="primary"
        size="icon"
        className="size-10 rounded-full"
        aria-label="댓글 보내기"
        disabled={!text.trim()}
      >
        <Send />
      </Button>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* 공용 조각                                                            */
/* ------------------------------------------------------------------ */

function StatusBadge({ view }: { view: SlotView }) {
  return (
    <span
      className={cn(
        "inline-block rounded-full px-2.5 py-0.5 text-xs font-medium",
        SLOT_STYLES[view.display],
      )}
    >
      {STATUS_LABEL[view.display]}
    </span>
  );
}

function ConflictNotice({ events }: { events: ExternalEvent[] }) {
  return (
    <div className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-950">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-700" />
      <div>
        <p className="font-semibold">내 개인 일정과 시간이 겹칩니다</p>
        <ul className="mt-0.5 text-xs">
          {events.map((e) => (
            <li key={e.id}>
              {calendarLabel(e.provider)} · {e.title} {fmtTime(e.start)}–{fmtTime(e.end)}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

const Hint = ({ children }: { children: ReactNode }) => (
  <p className="text-xs text-zinc-500">{children}</p>
);

const Empty = ({ children }: { children: ReactNode }) => (
  <p className="p-6 text-center text-sm text-zinc-500">{children}</p>
);
