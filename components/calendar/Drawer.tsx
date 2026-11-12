"use client";

import { addMinutes, endOfDay, format, isSameDay, startOfDay } from "date-fns";
import {
  AlertTriangle,
  ArrowDown,
  ArrowRightLeft,
  BellRing,
  CalendarClock,
  Check,
  ChevronRight,
  ClipboardList,
  Hourglass,
  Lock,
  MessageCircle,
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
  fmtDateTime,
  fmtDay,
  fmtRange,
  fmtTime,
  itemClass,
  itemsOnDay,
  itemTitle,
  SLOT_STYLES,
  slotTitle,
  requestKindLabel,
  STATUS_LABEL,
  timeAgo,
  useCalendarItems,
  useItemClick,
  useMyExternalEvents,
  useSlotViews,
} from "@/lib/calendar-items";
import { calendarLabel } from "@/lib/calendars";
import { changeImpact, planLabel } from "@/lib/enrollment";
import { holidaysOn, mainHoliday } from "@/lib/holidays";
import {
  canCancel,
  canResolve,
  changeDeadlinePassed,
  enrollmentEndMs,
  enrollmentOf,
} from "@/lib/lesson-machine";
import { INSTRUCTOR, userName } from "@/lib/mock-data";
import { cn } from "@/lib/utils";
import { useActor, useCalendarStore } from "@/store/calendar-store";
import type {
  Comment,
  ExternalEvent,
  LessonSlot,
  ScheduleRequest,
  SlotView,
} from "@/types/calendar";

export function Drawer() {
  const drawer = useCalendarStore((s) => s.drawer);
  // 테스트베드에서 사용자를 바꾸면 입력 중이던 내용이 다음 사용자에게 남지 않도록 사용자별로 새로 그린다
  const { userId } = useActor();
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
    body = <DayPanel key={`${drawer.date}-${userId}`} date={drawer.date} />;
  } else if (drawer.type === "slot") {
    title = "레슨 일정";
    body = <SlotPanel key={`${drawer.slotId}-${userId}`} slotId={drawer.slotId} />;
  } else if (drawer.type === "external") {
    title = "개인 일정";
    body = <ExternalPanel eventId={drawer.eventId} />;
  } else if (drawer.type === "reschedule") {
    title = "일정 변경 요청";
    body = (
      <ReschedulePanel
        key={`${drawer.fromSlotId}-${userId}`}
        fromSlotId={drawer.fromSlotId}
        toSlotId={drawer.toSlotId}
        toRange={drawer.toRange}
      />
    );
  }

  return (
    <aside
      aria-label={title}
      className="absolute inset-y-0 right-0 z-40 flex w-full animate-slide-in sm:max-w-sm flex-col border-l border-zinc-200 bg-white shadow-2xl xl:static xl:w-96 xl:shadow-none"
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
  const now = useCalendarStore((s) => s.now);
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

  const holidays = holidaysOn(new Date(date));
  const isPastDay = endOfDay(new Date(date)) < new Date(now);

  return (
    <div className="flex-1 space-y-4 overflow-y-auto p-4">
      {holidays.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="공휴일·기념일">
          {holidays.map((h) => (
            <li
              key={h.name}
              className={cn(
                "rounded-full px-2.5 py-0.5 text-xs font-medium",
                h.dayOff ? "bg-red-50 text-red-700" : "bg-zinc-100 text-zinc-600",
              )}
            >
              {h.name}
              {h.dayOff ? " · 공휴일" : " · 기념일"}
            </li>
          ))}
        </ul>
      )}
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

      {role === "INSTRUCTOR" && isPastDay && (
        <Hint>지난 날짜에는 레슨 가능 슬롯을 열 수 없습니다.</Hint>
      )}

      {role === "INSTRUCTOR" && !isPastDay && (
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

type SlotTab = "detail" | "chat";

function SlotPanel({ slotId }: { slotId: string }) {
  const role = useCalendarStore((s) => s.role);
  const now = useCalendarStore((s) => s.now);
  const comments = useCalendarStore((s) => s.lesson.comments);
  const requests = useCalendarStore((s) => s.lesson.requests);
  const store = useCalendarStore.getState;
  const views = useSlotViews();
  const myEvents = useMyExternalEvents();
  const [tab, setTab] = useState<SlotTab>("detail");
  const [message, setMessage] = useState("");
  const actor = useActor();
  const lesson = useCalendarStore((s) => s.lesson);

  const view = views.find((v) => v.slot.id === slotId);
  if (!view) return <Empty>삭제되었거나 볼 수 없는 슬롯입니다.</Empty>;

  const { slot, display, request } = view;
  const enrollment = enrollmentOf(lesson, slot);
  // 레슨생의 변경 요청 마감 (등록 시 합의한 n시간 전)
  const deadlinePassed = role === "STUDENT" && changeDeadlinePassed(lesson, slot, now);
  const isPast = new Date(slot.start) < new Date(now);
  const isEnded = new Date(slot.end) <= new Date(now);
  // 이 슬롯에서 처리가 끝난 요청 (강사는 전부, 레슨생은 자기 요청만 — 재사용된 슬롯의 남의 기록은 숨김)
  const pastRequests = requests
    .filter(
      (r) =>
        r.status !== "PENDING" &&
        (r.toSlotId === slot.id || r.fromSlotId === slot.id) &&
        (actor.role === "INSTRUCTOR" || r.studentId === actor.userId),
    )
    .sort((a, b) => (b.resolvedAt ?? "").localeCompare(a.resolvedAt ?? ""))
    .slice(0, 3);

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
  const thread = comments.filter((c) => c.threadId === slot.threadId);
  const chat = thread.filter((c) => c.kind === "USER");
  const log = thread.filter((c) => c.kind === "SYSTEM");
  const hasChat = display !== "OPEN";
  const needsMe = !!request && canResolve(request, actor);
  const activeTab: SlotTab = hasChat ? tab : "detail";

  return (
    <>
      {hasChat && (
        <div role="tablist" aria-label="레슨 일정 보기" className="flex border-b border-zinc-200 px-2">
          <TabButton active={activeTab === "detail"} onClick={() => setTab("detail")}>
            <ClipboardList />
            상세 · 요청
            {needsMe && <span className="size-2 rounded-full bg-amber-500" aria-label="응답 필요" />}
          </TabButton>
          <TabButton active={activeTab === "chat"} onClick={() => setTab("chat")}>
            <MessageCircle />
            메시지
            {chat.length > 0 && (
              <span className="rounded-full bg-zinc-200 px-1.5 text-[11px] text-zinc-700 tabular-nums">
                {chat.length}
              </span>
            )}
          </TabButton>
        </div>
      )}

      {activeTab === "chat" ? (
        <>
          <Messenger comments={chat} studentId={slot.studentId} />
          <CommentInput slotId={slot.id} />
        </>
      ) : (
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
                {view.seq &&
                  ` · ${new Date(slot.start).getMonth() + 1}월 ${view.seq.total}회 중 ${view.seq.n}번째`}
              </p>
            )}
            {enrollment && (
              <p className="mt-0.5 text-xs text-zinc-500">
                {planLabel(enrollment)} · 등록 {enrollment.startDate.slice(5).replace("-", "/")} ~{" "}
                {enrollment.endDate.slice(5).replace("-", "/")}
              </p>
            )}
            <div className="mt-1.5 flex flex-wrap gap-1.5 empty:hidden">
              {slot.holidayDecision === "PROCEED" && (
                <span className="rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700">
                  {slot.holidayName} · 진행하기로 함
                </span>
              )}
              {slot.movedFrom && (
                <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600">
                  {fmtDateTime(slot.movedFrom)}에서 옮긴 레슨
                </span>
              )}
            </div>
          </div>

          {request && request.status === "PENDING" && (
            <RequestCard view={view} views={views} />
          )}

          {pastRequests.length > 0 && <PastRequests items={pastRequests} />}

          {conflicts.length > 0 && <ConflictNotice events={conflicts} />}

          {/* ---- 요청이 없는 상태에서 할 수 있는 일 ---- */}
          {display === "OPEN" && role === "STUDENT" && (
            <section className="space-y-2">
              {isPast ? (
                <Hint>이미 지난 시간이라 신청할 수 없습니다.</Hint>
              ) : (
                <>
                  <label className="block text-xs font-semibold text-zinc-500" htmlFor="booking-message">
                    요청 메시지 (선택)
                  </label>
                  <textarea
                    id="booking-message"
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    placeholder="강사에게 함께 전할 내용"
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
              )}
            </section>
          )}

          {display === "OPEN" && role === "INSTRUCTOR" && (
            <section className="space-y-2">
              <Hint>레슨생에게 신청 가능한 빈 슬롯으로 보입니다. 달력에서 끌어서 시간을 옮길 수 있습니다.</Hint>
              <Button variant="danger" className="w-full" onClick={() => store().deleteSlot(slot.id)}>
                <Trash2 />
                슬롯 삭제
              </Button>
            </section>
          )}

          {display === "HOLIDAY_DECISION" && !request && !isEnded && (
            <section
              aria-label="공휴일 레슨 결정"
              className="overflow-hidden rounded-xl border-2 border-amber-500"
            >
              <header className="flex items-center gap-2 bg-amber-300 px-3 py-2 text-amber-950">
                <BellRing className="size-4" />
                <span className="text-sm font-bold">공휴일 레슨, 결정이 필요해요</span>
              </header>
              <div className="space-y-2 bg-white p-3 text-sm">
                <p className="text-zinc-700">
                  이 레슨은 <strong className="text-red-700">{slot.holidayName}</strong>에 잡혀 있습니다.
                  한쪽이 제안하고 상대방이 동의하면 확정됩니다. 당일까지 정하지 않으면 휴강으로 처리됩니다.
                </p>
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="함께 전할 메시지 (선택)"
                  aria-label="함께 전할 메시지"
                  rows={2}
                  className="w-full resize-none rounded-lg border border-zinc-300 px-3 py-2 text-sm placeholder:text-zinc-400"
                />
                <div className="flex gap-2">
                  <Button
                    variant="primary"
                    className="flex-1"
                    onClick={() => {
                      store().proposeHoliday(slot.id, "PROCEED", message);
                      setMessage("");
                    }}
                  >
                    그대로 진행 제안
                  </Button>
                  <Button
                    className="flex-1"
                    onClick={() => {
                      store().proposeHoliday(slot.id, "SKIP", message);
                      setMessage("");
                    }}
                  >
                    휴강 제안
                  </Button>
                </div>
                {deadlinePassed ? (
                  <Hint>다른 날로 옮기기는 레슨 {enrollment?.changeDeadlineHours}시간 전까지만 요청할 수 있습니다.</Hint>
                ) : (
                  <Button className="w-full" onClick={() => store().startReschedule(slot.id)}>
                    <ArrowRightLeft />
                    다른 날로 옮기기
                  </Button>
                )}
              </div>
            </section>
          )}

          {display === "SKIPPED" && (
            <Hint>
              {slot.holidayName ? `${slot.holidayName}이라 ` : ""}쉬기로 한 레슨입니다. 이 시간은 비어 있는 것으로
              처리됩니다.
            </Hint>
          )}

          {display === "CONFIRMED" && isEnded && <Hint>이미 끝난 레슨이라 일정을 변경할 수 없습니다.</Hint>}

          {display === "CONFIRMED" && !isEnded && deadlinePassed && (
            <Hint>
              레슨 시작 {enrollment?.changeDeadlineHours}시간 전까지만 일정 변경을 요청할 수 있습니다 (등록 시 합의).
              급한 사정은 메시지로 알려 주세요.
            </Hint>
          )}

          {display === "CONFIRMED" && !isEnded && !deadlinePassed && (
            <section className="space-y-2">
              <Button className="w-full" onClick={() => store().startReschedule(slot.id)}>
                <ArrowRightLeft />
                일정 변경 요청
              </Button>
              <Hint>
                {role === "INSTRUCTOR"
                  ? "빈 슬롯을 고르거나 달력에서 레슨을 끌어 놓으면, 레슨생의 동의 후 확정됩니다."
                  : "빈 슬롯을 고르거나 달력에서 레슨을 빈 슬롯 위로 끌어 놓으면, 강사의 승인 후 확정됩니다."}
              </Hint>
            </section>
          )}

          {log.length > 0 && <ProgressLog entries={log} />}

          {hasChat && (
            <button
              type="button"
              onClick={() => setTab("chat")}
              className="flex w-full items-center gap-2 rounded-xl border border-zinc-200 px-3 py-2.5 text-left text-sm text-zinc-700 hover:bg-zinc-50"
            >
              <MessageCircle className="size-4 text-mint-700" />
              {chat.length > 0 ? (
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium">{userName(chat[chat.length - 1].authorId)}</span>
                  {": "}
                  {chat[chat.length - 1].body}
                </span>
              ) : (
                <span className="flex-1">메시지 보내기</span>
              )}
              <ChevronRight className="size-4 text-zinc-400" />
            </button>
          )}
        </div>
      )}
    </>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm font-medium [&_svg]:size-4",
        active ? "border-mint-600 text-zinc-900" : "border-transparent text-zinc-500 hover:text-zinc-800",
      )}
    >
      {children}
    </button>
  );
}

/** 진행 중인 요청: 누가 응답해야 하는지, 진행 단계, 요청 메시지, 응답 버튼 */
function RequestCard({ view, views }: { view: SlotView; views: SlotView[] }) {
  const role = useCalendarStore((s) => s.role);
  const now = useCalendarStore((s) => s.now);
  const store = useCalendarStore.getState;
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const request = view.request!;
  const actor = useActor();
  const resolvable = canResolve(request, actor);
  const cancellable = canCancel(request, actor);

  const requester =
    request.requestedBy === "INSTRUCTOR" ? INSTRUCTOR.name : userName(request.studentId);
  const responder =
    request.requestedBy === "INSTRUCTOR" ? userName(request.studentId) : INSTRUCTOR.name;

  const linkedId =
    request.kind === "CHANGE"
      ? view.display === "PENDING_CHANGE_FROM"
        ? request.toSlotId
        : request.fromSlotId
      : undefined;
  const linked = views.find((v) => v.slot.id === linkedId);
  const fromView = view.display === "PENDING_CHANGE_FROM" ? view : linked;
  const toView = view.display === "PENDING_CHANGE_TO" ? view : linked;

  return (
    <section
      aria-label="진행 중인 요청"
      className={cn(
        "overflow-hidden rounded-xl border-2",
        resolvable ? "border-amber-500" : "border-zinc-300",
      )}
    >
      <header
        className={cn(
          "flex items-center gap-2 px-3 py-2",
          resolvable ? "bg-amber-300 text-amber-950" : "bg-zinc-100 text-zinc-800",
        )}
      >
        {resolvable ? <BellRing className="size-4" /> : <Hourglass className="size-4" />}
        <span className="text-sm font-bold">
          {resolvable ? "내 응답이 필요해요" : `${responder}의 응답을 기다리는 중`}
        </span>
        <span className="ml-auto rounded bg-white/70 px-1.5 py-0.5 text-[11px] font-semibold">
          {requestKindLabel(request)}
        </span>
      </header>

      <div className="space-y-3 bg-white p-3 text-sm">
        <ol className="flex items-center gap-1 text-[11px]" aria-label="진행 단계">
          <Step done label="요청" />
          <StepLine done />
          <Step current label={`${request.requestedBy === "INSTRUCTOR" ? "레슨생" : "강사"} 응답`} />
          <StepLine />
          <Step label="확정" />
        </ol>

        <p className="text-xs text-zinc-600">
          <span className="font-semibold text-zinc-800">{requester}</span> 요청 · {timeAgo(request.createdAt, now)}
        </p>

        {request.kind === "CHANGE" && fromView && toView && (
          <div>
            <LinkRow label="기존" view={fromView} active={fromView === view} />
            <ArrowDown className="mx-auto my-1 size-4 text-violet-500" />
            <LinkRow label="희망" view={toView} active={toView === view} />
            <ChangeWarnings from={fromView.slot} toStart={toView.slot.start} />
          </div>
        )}

        {request.kind === "HOLIDAY" && (
          <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-zinc-800">
            <span className="mb-0.5 block text-[11px] font-semibold text-red-700">
              {view.slot.holidayName} 레슨에 대한 제안
            </span>
            <strong>{request.holidayProposal === "SKIP" ? "이 날은 쉬기 (휴강)" : "공휴일이지만 그대로 진행"}</strong>
          </p>
        )}

        {request.message && (
          <blockquote className="rounded-lg bg-zinc-50 px-3 py-2 text-zinc-800">
            <span className="mb-0.5 block text-[11px] font-semibold text-zinc-500">요청 메시지</span>
            {request.message}
          </blockquote>
        )}

        {resolvable && !rejecting && (
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

        {resolvable && rejecting && (
          <div className="space-y-2 rounded-lg border border-red-200 bg-red-50 p-3">
            <label className="block text-sm font-medium text-red-900" htmlFor="reject-reason">
              거절 사유
            </label>
            <textarea
              id="reject-reason"
              autoFocus
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="상대방에게 전달할 사유 (선택)"
              rows={2}
              className="w-full resize-none rounded-lg border border-red-200 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400"
            />
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

        {cancellable && (
          <Button className="w-full" onClick={() => store().cancel(request.id)}>
            {request.kind === "BOOKING"
              ? "보강 신청 취소"
              : request.kind === "HOLIDAY"
                ? "제안 취소"
                : "변경 요청 취소"}
          </Button>
        )}
      </div>
    </section>
  );
}

function Step({ label, done, current }: { label: string; done?: boolean; current?: boolean }) {
  return (
    <li className="flex items-center gap-1">
      <span
        className={cn(
          "flex size-4 items-center justify-center rounded-full border",
          done && "border-mint-600 bg-mint-600 text-white",
          current && "border-amber-600 bg-amber-300",
          !done && !current && "border-zinc-300 bg-white",
        )}
      >
        {done && <Check className="size-3" />}
      </span>
      <span className={cn(current ? "font-semibold text-zinc-900" : "text-zinc-500")}>{label}</span>
    </li>
  );
}

const StepLine = ({ done }: { done?: boolean }) => (
  <li aria-hidden className={cn("h-px flex-1", done ? "bg-mint-600" : "bg-zinc-300")} />
);

const RESULT_LABEL = {
  APPROVED: { text: "승인", cls: "bg-mint-100 text-mint-800" },
  REJECTED: { text: "반려", cls: "bg-red-100 text-red-800" },
  CANCELLED: { text: "취소", cls: "bg-zinc-100 text-zinc-700" },
  EXPIRED: { text: "만료", cls: "bg-zinc-100 text-zinc-700" },
} as const;

/** 일정 변경 시 알아 둘 점: 달이 바뀌어 월별 횟수가 달라지는 경우, 옮길 날이 공휴일인 경우 */
function ChangeWarnings({ from, toStart }: { from: LessonSlot; toStart: string }) {
  const lesson = useCalendarStore((s) => s.lesson);
  const impact = changeImpact(lesson, from, toStart);
  const holiday = mainHoliday(new Date(toStart));
  if (!impact && !holiday?.dayOff) return null;
  return (
    <ul className="mt-2 space-y-1 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-950">
      {impact && (
        <li className="flex items-start gap-1.5">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-700" />
          <span>
            다른 달로 옮깁니다. {userName(from.studentId)} 레슨이{" "}
            <strong>
              {impact.fromMonth}월 {impact.fromCount}회 / {impact.toMonth}월 {impact.toCount}회
            </strong>
            가 됩니다.
          </span>
        </li>
      )}
      {holiday?.dayOff && (
        <li className="flex items-start gap-1.5">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-700" />
          <span>
            옮길 날이 공휴일(<strong>{holiday.name}</strong>)입니다.
          </span>
        </li>
      )}
    </ul>
  );
}

/** 처리가 끝난 요청: 결과, 요청 메시지, 반려 사유를 남겨 둔다 */
function PastRequests({ items }: { items: ScheduleRequest[] }) {
  return (
    <section>
      <h4 className="mb-2 text-xs font-semibold text-zinc-500">지난 요청</h4>
      <ul className="space-y-2">
        {items.map((r) => {
          const result = RESULT_LABEL[r.status as keyof typeof RESULT_LABEL];
          return (
            <li key={r.id} className="rounded-lg border border-zinc-200 px-3 py-2 text-xs text-zinc-700">
              <p className="flex items-center gap-1.5">
                <span className={cn("rounded px-1.5 py-0.5 font-semibold", result.cls)}>{result.text}</span>
                <span className="font-medium text-zinc-900">{requestKindLabel(r)}</span>
                <span>· {r.requestedBy === "INSTRUCTOR" ? INSTRUCTOR.name : userName(r.studentId)} 요청</span>
              </p>
              {r.message && <p className="mt-1">요청 메시지: {r.message}</p>}
              {r.rejectReason && <p className="mt-1 text-red-800">반려 사유: {r.rejectReason}</p>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** 요청 접수·승인·거절 같은 자동 기록 (메신저와 분리) */
function ProgressLog({ entries }: { entries: Comment[] }) {
  return (
    <section>
      <h4 className="mb-2 text-xs font-semibold text-zinc-500">진행 기록</h4>
      <ol className="space-y-2 border-l-2 border-zinc-200 pl-3">
        {entries.map((c) => (
          <li key={c.id} className="relative text-xs text-zinc-700">
            <span className="absolute top-1 -left-[17px] size-2 rounded-full bg-zinc-400" />
            <time className="mr-1.5 text-zinc-500 tabular-nums">{fmtDateTime(c.createdAt)}</time>
            {c.body}
          </li>
        ))}
      </ol>
    </section>
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

function ReschedulePanel({
  fromSlotId,
  toSlotId,
  toRange,
}: {
  fromSlotId: string;
  toSlotId?: string;
  toRange?: { start: string; end: string };
}) {
  const role = useCalendarStore((s) => s.role);
  const now = useCalendarStore((s) => s.now);
  const store = useCalendarStore.getState;
  const views = useSlotViews();
  const lesson = useCalendarStore((s) => s.lesson);
  const myEvents = useMyExternalEvents();
  const [message, setMessage] = useState("");

  const from = views.find((v) => v.slot.id === fromSlotId);
  if (!from) return <Empty>레슨을 찾을 수 없습니다.</Empty>;

  // 등록 기간 안의 미래 빈 슬롯만 고를 수 있다
  const enrollment = enrollmentOf(lesson, from.slot);
  const limit = enrollment ? enrollmentEndMs(enrollment) : Infinity;
  const candidates = views
    .filter((v) => v.display === "OPEN" && v.slot.start > now && Date.parse(v.slot.start) <= limit)
    .sort((a, b) => a.slot.start.localeCompare(b.slot.start));
  const targetStart = toRange?.start ?? views.find((v) => v.slot.id === toSlotId)?.slot.start;

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
            변경할 빈 슬롯 선택 (달력에서 &lsquo;가능&rsquo; 슬롯을 눌러도 됩니다)
          </legend>
          {toRange && (
            <div className="mb-1.5 rounded-lg border-2 border-violet-500 bg-violet-50 px-3 py-2 text-sm">
              <span className="block text-xs font-semibold text-violet-800">끌어 놓은 새 시간</span>
              <span className="tabular-nums">{fmtRange(toRange.start, toRange.end)}</span>
              <span className="mt-0.5 block text-xs text-violet-800">
                요청을 보내면 이 시간에 빈 슬롯이 열리고, 레슨생이 동의하면 확정됩니다.
              </span>
              {conflictsFor(toRange, myEvents).length > 0 && (
                <span className="mt-0.5 flex items-center gap-1 text-xs text-amber-800">
                  <AlertTriangle className="size-3 shrink-0" />
                  내 일정과 겹침: {conflictsFor(toRange, myEvents).map((c) => c.title).join(", ")}
                </span>
              )}
            </div>
          )}
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

        {targetStart && <ChangeWarnings from={from.slot} toStart={targetStart} />}
        {enrollment && (
          <Hint>등록 기간({enrollment.endDate.replaceAll("-", ".")}까지) 안에서만 옮길 수 있습니다.</Hint>
        )}

        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="요청 메시지 · 변경 사유 (선택)"
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
          disabled={!toSlotId && !toRange}
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

/** 강사와 레슨생이 주고받는 메시지 (요청·자동 기록은 '상세 · 요청' 탭에 따로 표시) */
function Messenger({ comments, studentId }: { comments: Comment[]; studentId?: string }) {
  const meId = useActor().userId;
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [comments.length]);

  return (
    <div className="flex-1 overflow-y-auto bg-zinc-50 p-4">
      <p className="mb-3 text-center text-[11px] text-zinc-500">
        {INSTRUCTOR.name} · {userName(studentId)} 대화
      </p>
      {comments.length === 0 ? (
        <p className="rounded-lg bg-white px-3 py-6 text-center text-xs text-zinc-500">
          아직 메시지가 없습니다. 첫 메시지를 남겨 보세요.
        </p>
      ) : (
        <ol className="space-y-2.5">
          {comments.map((c, i) => {
            const prev = comments[i - 1];
            const newDay = !prev || !isSameDay(new Date(prev.createdAt), new Date(c.createdAt));
            const mine = c.authorId === meId;
            return (
              <li key={c.id}>
                {newDay && (
                  <p className="mb-2 text-center text-[11px] text-zinc-400">{fmtDay(c.createdAt)}</p>
                )}
                <div className={cn("flex flex-col", mine ? "items-end" : "items-start")}>
                  {!mine && <span className="mb-0.5 text-xs text-zinc-500">{userName(c.authorId)}</span>}
                  <div className={cn("flex max-w-[85%] items-end gap-1.5", mine && "flex-row-reverse")}>
                    <p
                      className={cn(
                        "rounded-2xl px-3 py-1.5 text-sm break-words whitespace-pre-wrap",
                        mine
                          ? "rounded-br-sm bg-mint-600 text-white"
                          : "rounded-bl-sm border border-zinc-200 bg-white text-zinc-900",
                      )}
                    >
                      {c.body}
                    </p>
                    <time className="shrink-0 text-[10px] text-zinc-400 tabular-nums">
                      {format(new Date(c.createdAt), "HH:mm")}
                    </time>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      <div ref={endRef} />
    </div>
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
        placeholder="메시지 입력…"
        aria-label="메시지 입력"
        className="h-10 min-w-0 flex-1 rounded-full border border-zinc-300 px-4 text-sm placeholder:text-zinc-400"
      />
      <Button
        type="submit"
        variant="primary"
        size="icon"
        className="size-10 rounded-full"
        aria-label="메시지 보내기"
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
