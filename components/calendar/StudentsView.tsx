"use client";

import { addDays, addMonths, endOfMonth } from "date-fns";
import { AlertTriangle, CalendarPlus, Pencil, Plus, Trash2, UserPlus, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { fmtDateTime, fmtDay, fmtTime, won } from "@/lib/calendar-items";
import {
  changeEnrollmentSchedule,
  countLessonsAfter,
  daysLeft,
  extendEnrollment,
  monthProgress,
  nextPaymentDate,
  pendingScheduleRequest,
  planLabel,
  registerEnrollment,
  timesLabel,
  toDateKey,
} from "@/lib/enrollment";
import { LessonError, makeupSummary, type MachineContext } from "@/lib/lesson-machine";

import { studentColor } from "@/lib/student-colors";
import { cn } from "@/lib/utils";
import { useCalendarStore, useInstructor, useStudents } from "@/store/calendar-store";
import type { Enrollment, LessonState, User, WeeklyTime } from "@/types/calendar";

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

const WEEK_PATTERNS: { id: string; label: string; weeks: number[] }[] = [
  { id: "weekly", label: "매주 (5주차 쉼)", weeks: [1, 2, 3, 4] },
  { id: "odd", label: "격주 1·3주", weeks: [1, 3] },
  { id: "even", label: "격주 2·4주", weeks: [2, 4] },
  { id: "every", label: "매주 (5주차 포함)", weeks: [1, 2, 3, 4, 5] },
];
const patternOf = (weeks: number[]) =>
  WEEK_PATTERNS.find((p) => p.weeks.join() === weeks.join())?.id ?? "weekly";

const DEADLINES = [0, 6, 12, 24, 48, 72];

/** 종료 며칠 전부터 '만료 임박'으로 보여 줄지 */
export const EXPIRY_NOTICE_DAYS = 30;

type StudentFilter = "all" | "expiring" | "makeup" | "unregistered";
const FILTERS: { id: StudentFilter; label: string }[] = [
  { id: "all", label: "전체" },
  { id: "expiring", label: "만료 임박" },
  { id: "makeup", label: "보강 남음" },
  { id: "unregistered", label: "미등록" },
];

function matchesFilter(filter: StudentFilter, studentId: string, lesson: LessonState, now: string) {
  const todayKey = toDateKey(new Date(now));
  const current = lesson.enrollments.filter(
    (e) => e.studentId === studentId && e.endDate >= todayKey,
  );
  switch (filter) {
    case "all":
      return true;
    case "unregistered":
      return current.length === 0;
    case "makeup":
      return makeupSummary(lesson, studentId, now).remaining > 0;
    case "expiring": {
      // 다음 기간이 이미 등록돼 있으면 만료 임박이 아니다
      const lastEnd = current
        .map((e) => e.endDate)
        .sort()
        .at(-1);
      if (!lastEnd) return false;
      return daysLeft({ ...current[0], endDate: lastEnd }, now) <= EXPIRY_NOTICE_DAYS;
    }
  }
}
const deadlineLabel = (h: number) => (h > 0 ? `레슨 ${h}시간 전까지` : "제한 없음");
const shortDate = (key: string) => key.replaceAll("-", ".");

type Mode = { type: "register" } | { type: "edit" | "extend" | "end"; id: string };

const inputCls =
  "h-9 w-full rounded-lg border border-zinc-300 bg-white px-2 text-sm text-zinc-900 disabled:bg-zinc-100";
const labelCls = "block text-xs font-medium text-zinc-600";

/** 강사용: 레슨생별 수강 등록(기간·고정 시간·횟수·변경 마감·수강료) 관리 */
export function StudentsView() {
  const STUDENTS = useStudents();
  const session = useCalendarStore((s) => s.session);
  const lesson = useCalendarStore((s) => s.lesson);
  const now = useCalendarStore((s) => s.now);
  const conflicts = useCalendarStore((s) => s.conflicts);
  const clearConflicts = useCalendarStore((s) => s.clearConflicts);
  const todayKey = toDateKey(new Date(now));
  const enrolled = STUDENTS.filter((u) =>
    lesson.enrollments.some((e) => e.studentId === u.id && e.endDate >= todayKey),
  ).length;
  const [filter, setFilter] = useState<StudentFilter>("all");
  const counts = Object.fromEntries(
    FILTERS.map((f) => [
      f.id,
      STUDENTS.filter((u) => matchesFilter(f.id, u.id, lesson, now)).length,
    ]),
  ) as Record<StudentFilter, number>;
  const shown = STUDENTS.filter((u) => matchesFilter(filter, u.id, lesson, now));

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-zinc-50 p-4">
      <div className="mx-auto max-w-5xl">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="hidden text-lg font-bold md:block">레슨생 관리</h2>
          <p className="text-sm text-zinc-600">
            레슨생 {STUDENTS.length}명 · 수강 중 {enrolled}명
          </p>
        </div>
        {session && <InviteStudent />}

        {conflicts.length > 0 && (
          <div className="mb-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-700" />
              <div className="min-w-0 flex-1">
                <p className="font-semibold">
                  다른 레슨과 겹쳐 만들지 못한 날 {conflicts.length}건
                </p>
                <p className="mt-0.5 text-xs">
                  {conflicts.map((c) => fmtDateTime(c.start)).join(" · ")}
                </p>
                <p className="mt-1 text-xs">
                  달력에서 해당 날짜를 확인하고 필요하면 빈 슬롯을 열어 따로 잡아 주세요.
                </p>
              </div>
              <Button variant="ghost" size="icon" aria-label="알림 닫기" onClick={clearConflicts}>
                <X />
              </Button>
            </div>
          </div>
        )}

        <div
          role="tablist"
          aria-label="레슨생 필터"
          className="mb-3 flex gap-1.5 overflow-x-auto pb-1"
        >
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              role="tab"
              aria-selected={filter === f.id}
              onClick={() => setFilter(f.id)}
              className={cn(
                "flex h-9 shrink-0 items-center gap-1 rounded-full border px-3 text-sm",
                filter === f.id
                  ? "border-zinc-800 bg-zinc-800 text-white"
                  : "border-zinc-300 bg-white text-zinc-700",
              )}
            >
              {f.label}
              <span className="text-xs tabular-nums opacity-80">{counts[f.id]}</span>
            </button>
          ))}
        </div>

        <ul className="grid gap-3 lg:grid-cols-2">
          {shown.length === 0 && (
            <li className="rounded-xl bg-white p-6 text-center text-sm text-zinc-500">
              해당하는 레슨생이 없습니다.
            </li>
          )}
          {shown.map((student) => (
            <li key={student.id}>
              <StudentCard student={student} />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function StudentCard({ student }: { student: User }) {
  const lesson = useCalendarStore((s) => s.lesson);
  const now = useCalendarStore((s) => s.now);
  const [mode, setMode] = useState<Mode | null>(null);
  const todayKey = toDateKey(new Date(now));
  const all = lesson.enrollments
    .filter((e) => e.studentId === student.id)
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
  const current = all.filter((e) => e.endDate >= todayKey);
  const past = all.filter((e) => e.endDate < todayKey);
  const close = () => setMode(null);

  return (
    <article className="rounded-xl border border-zinc-200 bg-white p-4">
      <header className="mb-2 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-base font-bold">
          <span className={cn("size-3 rounded-full", studentColor(student.id)?.dot)} aria-hidden />
          {student.name}
        </h3>
        {current.length === 0 && (
          <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600">
            수강 등록 없음
          </span>
        )}
      </header>

      {current.map((e) => {
        const left = daysLeft(e, now);
        const progress = monthProgress(lesson, e, now);
        const due = nextPaymentDate(e, now);
        const upcoming = e.startDate > todayKey;
        return (
          <div key={e.id} className="mb-3 last:mb-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="rounded-full bg-mint-100 px-2 py-0.5 text-xs font-semibold text-mint-800">
                {planLabel(e)}
              </span>
              <span className="text-sm font-medium text-zinc-900">{timesLabel(e.times)}</span>
              {upcoming && (
                <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-900">
                  시작 전
                </span>
              )}
              {!upcoming && left <= EXPIRY_NOTICE_DAYS && (
                <span className="rounded-full bg-coral-100 px-2 py-0.5 text-xs font-semibold text-coral-800">
                  등록 종료 D-{left}
                </span>
              )}
            </div>
            {pendingScheduleRequest(lesson, e.id) && (
              <p className="mt-2 rounded-lg bg-sky-50 px-2.5 py-1.5 text-xs text-sky-900">
                고정 시간 변경 요청 진행 중:{" "}
                {timesLabel(pendingScheduleRequest(lesson, e.id)!.schedule!.times)} (
                {fmtDay(new Date(pendingScheduleRequest(lesson, e.id)!.toStart))}부터) ·{" "}
                {pendingScheduleRequest(lesson, e.id)!.requestedBy === "INSTRUCTOR"
                  ? "레슨생 동의 대기"
                  : "내 승인 필요 (요청 탭)"}
              </p>
            )}
            <dl className="mt-2 grid grid-cols-[5.5rem_1fr] gap-x-2 gap-y-1 text-sm">
              <dt className="text-zinc-500">등록 기간</dt>
              <dd className="tabular-nums">
                {shortDate(e.startDate)} ~ {shortDate(e.endDate)}
              </dd>
              <dt className="text-zinc-500">이번 달</dt>
              <dd className="tabular-nums">
                {progress.total + progress.skipped === 0
                  ? "레슨 없음"
                  : `${progress.done}/${progress.total}회 진행`}
                {progress.skipped > 0 && (
                  <span className="text-zinc-500" title="공휴일 휴강 · 보강으로 미룸 · 미배정">
                    {" "}
                    · 미진행 {progress.skipped}
                  </span>
                )}
              </dd>
              <dt className="text-zinc-500">일정 변경</dt>
              <dd>{deadlineLabel(e.changeDeadlineHours)}</dd>
              <dt className="text-zinc-500">수강료</dt>
              <dd className="tabular-nums">
                {e.fee !== undefined ? `월 ${won(e.fee)}` : "미입력"}
                {e.paymentDay && (
                  <span className="text-zinc-500">
                    {" "}
                    · 매월 {e.paymentDay}일{due ? ` (다음 ${fmtDay(due)})` : " (남은 결제 없음)"}
                  </span>
                )}
              </dd>
            </dl>

            {mode && mode.type !== "register" && mode.id === e.id ? (
              <div className="mt-3 rounded-lg border border-zinc-200 bg-zinc-50 p-3">
                {mode.type === "edit" && (
                  <PlanForm student={student} enrollment={e} onDone={close} />
                )}
                {mode.type === "extend" && <ExtendForm enrollment={e} onDone={close} />}
                {mode.type === "end" && <EndForm enrollment={e} onDone={close} />}
              </div>
            ) : (
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" onClick={() => setMode({ type: "edit", id: e.id })}>
                  <Pencil />
                  수정
                </Button>
                <Button size="sm" onClick={() => setMode({ type: "extend", id: e.id })}>
                  <CalendarPlus />
                  연장
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => setMode({ type: "end", id: e.id })}
                >
                  <Trash2 />
                  종료
                </Button>
              </div>
            )}
          </div>
        );
      })}

      {mode?.type === "register" ? (
        <div className="mt-2 rounded-lg border border-zinc-200 bg-zinc-50 p-3">
          <PlanForm
            student={student}
            template={all.at(-1)}
            defaultStart={
              current.length > 0
                ? toDateKey(addDays(new Date(`${current.at(-1)!.endDate}T00:00`), 1))
                : toDateKey(addDays(new Date(now), 1))
            }
            onDone={close}
          />
        </div>
      ) : current.length === 0 ? (
        <Button variant="primary" size="sm" onClick={() => setMode({ type: "register" })}>
          <UserPlus />
          수강 등록
        </Button>
      ) : (
        // 현재 등록이 끝난 다음 기간을 미리(다른 조건으로) 등록할 수 있다
        mode === null && (
          <Button
            variant="ghost"
            size="sm"
            className="mt-2 text-xs"
            onClick={() => setMode({ type: "register" })}
          >
            <UserPlus />
            다음 기간 등록 (종료일 다음 날부터)
          </Button>
        )
      )}

      <MakeupPanel student={student} />

      {past.length > 0 && (
        <p className="mt-3 border-t border-zinc-100 pt-2 text-xs text-zinc-500">
          지난 등록:{" "}
          {past
            .map((e) => `${shortDate(e.startDate)}~${shortDate(e.endDate)} (${planLabel(e)})`)
            .join(", ")}
        </p>
      )}
    </article>
  );
}

/** 수강 등록 / 수정 폼 */
function PlanForm({
  student,
  enrollment,
  template,
  defaultStart,
  onDone,
}: {
  student: User;
  enrollment?: Enrollment;
  /** 새 등록일 때 이전 등록의 조건(시간·주차·마감·수강료·결제일)을 기본값으로 가져온다 */
  template?: Enrollment;
  defaultStart?: string;
  onDone: () => void;
}) {
  const instructorId = useInstructor().id;
  const STUDENTS = useStudents();
  const base = enrollment ?? template;
  const lesson = useCalendarStore((s) => s.lesson);
  const now = useCalendarStore((s) => s.now);
  const store = useCalendarStore.getState;
  const editing = !!enrollment;
  const uid = `${student.id}-${enrollment?.id ?? "new"}`;
  const tomorrow = toDateKey(addDays(new Date(now), 1));

  const monthsEnd = (startKey: string, months: number) =>
    toDateKey(addDays(addMonths(new Date(`${startKey}T00:00`), months), -1));

  const [startDate, setStartDate] = useState(enrollment?.startDate ?? defaultStart ?? tomorrow);
  const [months, setMonths] = useState("3");
  const [endDate, setEndDate] = useState(
    enrollment?.endDate ?? monthsEnd(defaultStart ?? tomorrow, 3),
  );
  const [times, setTimes] = useState<WeeklyTime[]>(
    base?.times ?? [{ weekday: 2, time: "19:00", durationMin: 60 }],
  );
  const [pattern, setPattern] = useState(patternOf(base?.weeks ?? [1, 2, 3, 4]));
  const [deadline, setDeadline] = useState(base?.changeDeadlineHours ?? 24);
  const [fee, setFee] = useState(base?.fee?.toString() ?? "");
  const [paymentDay, setPaymentDay] = useState(base?.paymentDay?.toString() ?? "");
  const [applyFrom, setApplyFrom] = useState(
    enrollment && enrollment.startDate > tomorrow ? enrollment.startDate : tomorrow,
  );

  const weeks = WEEK_PATTERNS.find((p) => p.id === pattern)!.weeks;
  const scheduleChanged =
    editing &&
    (JSON.stringify(times) !== JSON.stringify(enrollment.times) ||
      weeks.join() !== enrollment.weeks.join());
  const valid = startDate && endDate && startDate <= endDate && times.every((t) => t.time);
  // 저장할 때와 같은 로직을 미리 돌려 정확한 생성 수·겹침·오류를 보여 준다 (상태는 바뀌지 않음)
  let preview: { created: number; conflicts: number; details: string[] } | null = null;
  let previewError: string | null = null;
  if (valid && (!editing || scheduleChanged)) {
    const dry: MachineContext = { now: () => now, id: (p) => `preview-${p}` };
    const instructor = { userId: instructorId, role: "INSTRUCTOR" as const };
    const noHoliday = () => undefined;
    try {
      const r = editing
        ? changeEnrollmentSchedule(
            lesson,
            instructor,
            enrollment.id,
            { times, weeks },
            applyFrom,
            dry,
            noHoliday,
          )
        : registerEnrollment(
            lesson,
            instructor,
            {
              studentId: student.id,
              startDate,
              endDate,
              times,
              weeks,
              changeDeadlineHours: deadline,
            },
            dry,
            noHoliday,
          );
      // 겹치는 날짜와 상대(강사 화면이므로 이름 표시)를 몇 건 보여 준다
      const details = r.conflicts.slice(0, 3).map((c) => {
        const other = lesson.slots.find(
          (x) =>
            x.status !== "SKIPPED" &&
            x.status !== "OPEN" &&
            x.enrollmentId !== enrollment?.id &&
            Date.parse(x.start) < Date.parse(c.end) &&
            Date.parse(c.start) < Date.parse(x.end),
        );
        return `${fmtDateTime(c.start)}${other?.studentId ? ` ${STUDENTS.find((u) => u.id === other.studentId)?.name ?? ""}` : ""}`;
      });
      preview = { created: r.created, conflicts: r.conflicts.length, details };
    } catch (e) {
      if (!(e instanceof LessonError)) throw e;
      previewError = e.message;
    }
  }

  const setTime = (i: number, patch: Partial<WeeklyTime>) =>
    setTimes(times.map((t, j) => (j === i ? { ...t, ...patch } : t)));

  const submit = () => {
    const terms = {
      changeDeadlineHours: deadline,
      fee: fee.trim() ? Number(fee) : undefined,
      paymentDay: paymentDay.trim() ? Number(paymentDay) : undefined,
    };
    if (!editing) {
      if (
        store().registerEnrollment({
          studentId: student.id,
          startDate,
          endDate,
          times,
          weeks,
          ...terms,
        })
      )
        onDone();
      return;
    }
    if (!store().updateEnrollmentTerms(enrollment.id, terms)) return;
    if (
      scheduleChanged &&
      !store().requestScheduleChange(enrollment.id, { times, weeks }, applyFrom)
    )
      return;
    onDone();
  };

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <h4 className="text-sm font-bold">{editing ? "등록 수정" : `${student.name} 수강 등록`}</h4>

      {!editing && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <label className={labelCls} htmlFor={`start-${uid}`}>
            시작일
            <input
              id={`start-${uid}`}
              type="date"
              required
              min={toDateKey(new Date(now))}
              value={startDate}
              onChange={(e) => {
                setStartDate(e.target.value);
                if (months !== "custom" && e.target.value)
                  setEndDate(monthsEnd(e.target.value, Number(months)));
              }}
              className={cn(inputCls, "mt-1")}
            />
          </label>
          <label className={labelCls} htmlFor={`months-${uid}`}>
            등록 기간
            <select
              id={`months-${uid}`}
              value={months}
              onChange={(e) => {
                setMonths(e.target.value);
                if (e.target.value !== "custom" && startDate)
                  setEndDate(monthsEnd(startDate, Number(e.target.value)));
              }}
              className={cn(inputCls, "mt-1")}
            >
              <option value="1">1개월</option>
              <option value="3">3개월</option>
              <option value="6">6개월</option>
              <option value="12">12개월</option>
              <option value="custom">직접 입력</option>
            </select>
          </label>
          <label className={labelCls} htmlFor={`end-${uid}`}>
            종료일
            <input
              id={`end-${uid}`}
              type="date"
              required
              value={endDate}
              min={startDate}
              onChange={(e) => {
                setEndDate(e.target.value);
                setMonths("custom");
              }}
              className={cn(inputCls, "mt-1")}
            />
          </label>
        </div>
      )}

      <fieldset>
        <legend className={labelCls}>고정 레슨 시간 (주 {times.length}회)</legend>
        <ul className="mt-1 space-y-1.5">
          {times.map((t, i) => (
            <li key={i} className="flex items-center gap-1.5">
              <select
                aria-label={`${i + 1}번째 레슨 요일`}
                value={t.weekday}
                onChange={(e) => setTime(i, { weekday: Number(e.target.value) })}
                className={cn(inputCls, "w-20")}
              >
                {WEEKDAYS.map((d, w) => (
                  <option key={d} value={w}>
                    {d}요일
                  </option>
                ))}
              </select>
              <input
                type="time"
                aria-label={`${i + 1}번째 레슨 시작 시간`}
                step={900}
                required
                value={t.time}
                onChange={(e) => setTime(i, { time: e.target.value })}
                className={cn(inputCls, "w-28")}
              />
              <select
                aria-label={`${i + 1}번째 레슨 길이`}
                value={t.durationMin}
                onChange={(e) => setTime(i, { durationMin: Number(e.target.value) })}
                className={cn(inputCls, "w-20")}
              >
                {[30, 45, 60, 90, 120].map((m) => (
                  <option key={m} value={m}>
                    {m}분
                  </option>
                ))}
              </select>
              {times.length > 1 && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`${i + 1}번째 레슨 시간 삭제`}
                  onClick={() => setTimes(times.filter((_, j) => j !== i))}
                >
                  <X />
                </Button>
              )}
            </li>
          ))}
        </ul>
        <Button
          variant="ghost"
          size="sm"
          className="mt-1 text-xs"
          onClick={() => setTimes([...times, { weekday: 4, time: "19:00", durationMin: 60 }])}
        >
          <Plus />
          주당 횟수 추가
        </Button>
      </fieldset>

      <div className="grid grid-cols-2 gap-2">
        <label className={labelCls} htmlFor={`pattern-${uid}`}>
          진행 주차
          <select
            id={`pattern-${uid}`}
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            className={cn(inputCls, "mt-1")}
          >
            {WEEK_PATTERNS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className={labelCls} htmlFor={`deadline-${uid}`}>
          레슨생 일정 변경 마감 (합의)
          <select
            id={`deadline-${uid}`}
            value={deadline}
            onChange={(e) => setDeadline(Number(e.target.value))}
            className={cn(inputCls, "mt-1")}
          >
            {DEADLINES.map((h) => (
              <option key={h} value={h}>
                {deadlineLabel(h)}
              </option>
            ))}
          </select>
        </label>
        <label className={labelCls} htmlFor={`fee-${uid}`}>
          월 수강료 (원)
          <input
            id={`fee-${uid}`}
            type="number"
            inputMode="numeric"
            min={0}
            step={1000}
            placeholder="예: 200000"
            value={fee}
            onChange={(e) => setFee(e.target.value)}
            className={cn(inputCls, "mt-1")}
          />
        </label>
        <label className={labelCls} htmlFor={`payday-${uid}`}>
          결제 예정일 (매월 n일)
          <input
            id={`payday-${uid}`}
            type="number"
            inputMode="numeric"
            min={1}
            max={31}
            placeholder="예: 25"
            value={paymentDay}
            onChange={(e) => setPaymentDay(e.target.value)}
            className={cn(inputCls, "mt-1")}
          />
        </label>
      </div>

      {scheduleChanged && (
        <label className={labelCls} htmlFor={`apply-${uid}`}>
          새 고정 시간 적용 시작일 (이 날짜의 레슨부터 일괄 변경)
          <input
            id={`apply-${uid}`}
            type="date"
            required
            min={tomorrow}
            max={enrollment.endDate}
            value={applyFrom}
            onChange={(e) => setApplyFrom(e.target.value)}
            className={cn(inputCls, "mt-1 block w-44")}
          />
          <span className="mt-1 block font-normal text-amber-800">
            레슨생에게 변경 요청을 보냅니다. 레슨생이 동의하면 이 날짜 이후의 정규 레슨이 새
            시간으로 일괄 변경되고, 걸려 있던 변경 요청은 취소됩니다.
          </span>
        </label>
      )}

      <p className="text-xs text-zinc-600">
        {planLabel({ times, weeks })}
        {preview && ` · 정규 레슨 ${preview.created}건이 만들어집니다`}
      </p>
      {previewError && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-900">
          {previewError}
        </p>
      )}
      {preview && preview.conflicts > 0 && (
        <p className="flex items-start gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-950">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-700" />
          <span>
            그 밖에 <strong>{preview.conflicts}건</strong>은 다른 레슨과 겹쳐 &lsquo;미배정&rsquo;이
            되고 보강 필요로 집계됩니다: {preview.details.join(", ")}
            {preview.conflicts > preview.details.length &&
              ` 외 ${preview.conflicts - preview.details.length}건`}
            . 시간을 바꾸는 것을 검토해 주세요.
          </span>
        </p>
      )}

      <FormActions onCancel={onDone}>
        <Button type="submit" variant="primary" size="sm" disabled={!valid || !!previewError}>
          {editing ? (scheduleChanged ? "저장 · 변경 요청 보내기" : "저장") : "등록"}
        </Button>
      </FormActions>
    </form>
  );
}

function ExtendForm({ enrollment, onDone }: { enrollment: Enrollment; onDone: () => void }) {
  const instructorId = useInstructor().id;
  const store = useCalendarStore.getState;
  const plus = (months: number) =>
    toDateKey(endOfMonth(addMonths(new Date(`${enrollment.endDate}T00:00`), months)));
  const [endDate, setEndDate] = useState(plus(3));
  const from = toDateKey(addDays(new Date(`${enrollment.endDate}T00:00`), 1));
  const lesson = useCalendarStore((s) => s.lesson);
  const now = useCalendarStore((s) => s.now);
  // 저장할 때와 같은 로직으로 정확한 추가 건수를 미리 계산 (상태는 바뀌지 않음)
  let count = 0;
  let conflicts = 0;
  if (endDate > enrollment.endDate) {
    try {
      const r = extendEnrollment(
        lesson,
        { userId: instructorId, role: "INSTRUCTOR" },
        enrollment.id,
        endDate,
        { now: () => now, id: (p) => `preview-${p}` },
        () => undefined,
      );
      count = r.created;
      conflicts = r.conflicts.length;
    } catch (e) {
      if (!(e instanceof LessonError)) throw e;
    }
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (store().extendEnrollment(enrollment.id, endDate)) onDone();
      }}
    >
      <h4 className="text-sm font-bold">등록 연장</h4>
      <div className="flex flex-wrap items-end gap-2">
        {[1, 3, 6].map((m) => (
          <Button key={m} size="sm" onClick={() => setEndDate(plus(m))}>
            +{m}개월
          </Button>
        ))}
        <label className={labelCls} htmlFor={`extend-${enrollment.id}`}>
          새 종료일
          <input
            id={`extend-${enrollment.id}`}
            type="date"
            required
            min={from}
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className={cn(inputCls, "mt-1 block w-44")}
          />
        </label>
      </div>
      <p className="text-xs text-zinc-600">
        같은 시간({timesLabel(enrollment.times)})으로 정규 레슨 {count}건이 추가됩니다.
        {conflicts > 0 && ` 다른 레슨과 겹친 ${conflicts}건은 '미배정'으로 기록됩니다 (보강 필요).`}
      </p>
      <FormActions onCancel={onDone}>
        <Button type="submit" variant="primary" size="sm" disabled={count === 0}>
          연장
        </Button>
      </FormActions>
    </form>
  );
}

function EndForm({ enrollment, onDone }: { enrollment: Enrollment; onDone: () => void }) {
  const lesson = useCalendarStore((s) => s.lesson);
  const now = useCalendarStore((s) => s.now);
  const store = useCalendarStore.getState;
  const todayKey = toDateKey(new Date(now));
  const monthEnd = toDateKey(endOfMonth(new Date(now)));
  const clamp = (key: string) =>
    key > enrollment.endDate
      ? enrollment.endDate
      : key < enrollment.startDate
        ? enrollment.startDate
        : key;
  const minEnd = todayKey > enrollment.startDate ? todayKey : enrollment.startDate;
  const [endDate, setEndDate] = useState(clamp(monthEnd) < minEnd ? minEnd : clamp(monthEnd));
  const removed = endDate ? countLessonsAfter(lesson, enrollment.id, endDate, now) : 0;

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (store().endEnrollment(enrollment.id, endDate)) onDone();
      }}
    >
      <h4 className="text-sm font-bold">등록 종료</h4>
      <div className="flex flex-wrap items-end gap-2">
        <Button size="sm" onClick={() => setEndDate(clamp(monthEnd))}>
          이번 달까지
        </Button>
        <Button size="sm" onClick={() => setEndDate(minEnd)}>
          오늘까지
        </Button>
        <label className={labelCls} htmlFor={`end-${enrollment.id}`}>
          마지막 날
          <input
            id={`end-${enrollment.id}`}
            type="date"
            required
            min={minEnd}
            max={enrollment.endDate}
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className={cn(inputCls, "mt-1 block w-44")}
          />
        </label>
      </div>
      {endDate > enrollment.endDate ? (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-900">
          마지막 날은 현재 종료일({shortDate(enrollment.endDate)}) 이전이어야 합니다. 기간을
          늘리려면 &lsquo;연장&rsquo;을 사용해 주세요.
        </p>
      ) : endDate < minEnd ? (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-900">
          마지막 날은 오늘({shortDate(minEnd)}) 이후로 정해 주세요. 지난 레슨 기록은 지우지
          않습니다.
        </p>
      ) : endDate === enrollment.endDate ? (
        <p className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-700">
          이미 {shortDate(endDate)}에 끝나는 등록입니다. 바꿀 것이 없습니다. 이어서 받으려면
          &lsquo;연장&rsquo; 또는 &lsquo;다음 기간 등록&rsquo;을 사용해 주세요.
        </p>
      ) : (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-900">
          {shortDate(endDate)} 이후의 레슨 <strong>{removed}건</strong>이 삭제되고, 걸려 있던 요청은
          취소됩니다. 지난 레슨 기록은 남고, 비는 시간은 자동으로 열리지 않습니다.
        </p>
      )}
      <FormActions onCancel={onDone}>
        <Button
          type="submit"
          variant="danger"
          size="sm"
          disabled={!endDate || endDate < minEnd || endDate >= enrollment.endDate}
        >
          종료 확정
        </Button>
      </FormActions>
    </form>
  );
}

const FormActions = ({ onCancel, children }: { onCancel: () => void; children: ReactNode }) => (
  <div className="flex justify-end gap-2">
    <Button size="sm" onClick={onCancel}>
      취소
    </Button>
    {children}
  </div>
);

/** 레슨생별 보강 현황과 강사 조정 */
function MakeupPanel({ student }: { student: User }) {
  const lesson = useCalendarStore((s) => s.lesson);
  const now = useCalendarStore((s) => s.now);
  const store = useCalendarStore.getState;
  const [adjust, setAdjust] = useState<1 | -1 | null>(null);
  const [reason, setReason] = useState("");
  const [picking, setPicking] = useState(false);
  const m = makeupSummary(lesson, student.id, now);
  const uid = `adj-${student.id}`;

  return (
    <section aria-label={`${student.name} 보강`} className="mt-3 border-t border-zinc-100 pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">보강</h4>
        <button
          type="button"
          aria-expanded={picking}
          onClick={() => setPicking((v) => !v)}
          className={cn(
            "flex min-h-9 items-center gap-1 rounded-full px-3 text-sm font-semibold tabular-nums",
            m.remaining > 0
              ? "bg-orange-100 text-orange-900 hover:bg-orange-200"
              : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200",
          )}
        >
          {m.remaining >= 0 ? `남은 보강 ${m.remaining}회` : `추가 레슨 ${-m.remaining}회`}
          <CalendarPlus className="size-4" />
          <span className="sr-only">· 보강 잡기</span>
        </button>
      </div>
      {picking && (
        <MakeupPicker student={student} remaining={m.remaining} onDone={() => setPicking(false)} />
      )}
      <p className="mt-1 text-xs text-zinc-600 tabular-nums">
        필요 {m.owed} · 완료 {m.done} · 예정 {m.scheduled}
        {m.requested > 0 && ` · 신청 중 ${m.requested}`}
      </p>

      {m.entries.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs text-zinc-700">
          {m.entries.slice(0, 4).map((e, i) => (
            <li key={`${e.at}-${i}`} className="flex gap-2">
              <span
                className={cn(
                  "w-6 shrink-0 font-semibold tabular-nums",
                  e.delta > 0 ? "text-orange-800" : "text-mint-700",
                )}
              >
                {e.delta > 0 ? `+${e.delta}` : e.delta}
              </span>
              <span className="shrink-0 text-zinc-500 tabular-nums">{fmtDay(e.at)}</span>
              <span className="min-w-0 truncate">{e.label}</span>
            </li>
          ))}
          {m.entries.length > 4 && <li className="text-zinc-500">외 {m.entries.length - 4}건</li>}
        </ul>
      )}

      {adjust === null ? (
        <div className="mt-2 flex gap-2">
          <Button size="sm" onClick={() => setAdjust(1)}>
            보강 +1
          </Button>
          <Button
            size="sm"
            disabled={m.owed <= 0}
            title={m.owed <= 0 ? "보강 필요가 0회라 줄일 수 없습니다" : undefined}
            onClick={() => setAdjust(-1)}
          >
            보강 −1
          </Button>
        </div>
      ) : (
        <form
          className="mt-2 flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (store().adjustMakeup(student.id, adjust, reason)) {
              setAdjust(null);
              setReason("");
            }
          }}
        >
          <label className={cn(labelCls, "min-w-0 flex-1")} htmlFor={uid}>
            {adjust > 0 ? "보강 1회 추가 사유" : "보강 1회 차감 사유"}
            <input
              id={uid}
              autoFocus
              required
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={
                adjust > 0 ? "예: 11/10 결석, 강사 사정 취소" : "예: 보강 없이 정리, 환불"
              }
              className={cn(inputCls, "mt-1")}
            />
          </label>
          <Button size="sm" onClick={() => setAdjust(null)}>
            취소
          </Button>
          <Button type="submit" size="sm" variant="primary" disabled={!reason.trim()}>
            저장
          </Button>
        </form>
      )}
    </section>
  );
}

/** 남은 보강을 누르면: 강사가 열어 둔 빈 시간 중에서 골라 레슨생에게 보강을 제안한다 */
function MakeupPicker({
  student,
  remaining,
  onDone,
}: {
  student: User;
  remaining: number;
  onDone: () => void;
}) {
  const lesson = useCalendarStore((s) => s.lesson);
  const now = useCalendarStore((s) => s.now);
  const store = useCalendarStore.getState;
  const [slotId, setSlotId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const mine = lesson.slots.filter((s) => s.studentId === student.id && s.status !== "SKIPPED");
  const open = lesson.slots
    .filter((s) => s.status === "OPEN" && s.start > now)
    .sort((a, b) => a.start.localeCompare(b.start))
    .slice(0, 20);
  const clashes = (start: string, end: string) =>
    mine.some(
      (x) => Date.parse(x.start) < Date.parse(end) && Date.parse(start) < Date.parse(x.end),
    );

  return (
    <form
      aria-label={`${student.name} 보강 잡기`}
      className="mt-2 space-y-2 rounded-lg border border-emerald-200 bg-emerald-50/60 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (slotId && store().proposeMakeup(slotId, student.id, message)) onDone();
      }}
    >
      <p className="text-xs text-emerald-950">
        열어 둔 빈 시간 중에서 고르면 <strong>{student.name}</strong>에게 보강을 제안합니다.
        레슨생이 동의하면 확정됩니다.
        {remaining <= 0 && " (남은 보강이 없어 추가 레슨이 됩니다)"}
      </p>
      {open.length === 0 ? (
        <p className="rounded-lg bg-white px-3 py-3 text-xs text-zinc-600">
          열어 둔 빈 시간이 없습니다. 달력에서 시간대를 눌러 빈 슬롯을 먼저 열어 주세요.
        </p>
      ) : (
        <ul className="max-h-64 space-y-1 overflow-y-auto">
          {open.map((s) => {
            const clash = clashes(s.start, s.end);
            return (
              <li key={s.id}>
                <label
                  className={cn(
                    "flex min-h-10 items-center gap-2.5 rounded-lg border bg-white px-3 py-1.5 text-sm",
                    slotId === s.id ? "border-emerald-600" : "border-zinc-200",
                    clash ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-zinc-50",
                  )}
                >
                  <input
                    type="radio"
                    name={`makeup-${student.id}`}
                    className="size-4 accent-emerald-600"
                    disabled={clash}
                    checked={slotId === s.id}
                    onChange={() => setSlotId(s.id)}
                  />
                  <span className="tabular-nums">
                    {fmtDateTime(s.start)}–{fmtTime(s.end)}
                  </span>
                  {clash && <span className="ml-auto text-xs text-zinc-500">레슨과 겹침</span>}
                </label>
              </li>
            );
          })}
        </ul>
      )}
      <input
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="함께 전할 메시지 (선택)"
        aria-label="보강 제안 메시지"
        className={inputCls}
      />
      <FormActions onCancel={onDone}>
        <Button type="submit" variant="primary" size="sm" disabled={!slotId}>
          보강 제안 보내기
        </Button>
      </FormActions>
    </form>
  );
}

/** 서버 모드: 이메일로 레슨생 초대. 레슨생이 그 이메일로 로그인하면 이 레슨실에 연결된다 */
function InviteStudent() {
  const inviteStudent = useCalendarStore((s) => s.inviteStudent);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  if (!open)
    return (
      <Button variant="primary" size="sm" className="mb-3" onClick={() => setOpen(true)}>
        <UserPlus />
        레슨생 초대
      </Button>
    );
  return (
    <form
      className="mb-3 grid gap-2 rounded-xl border border-zinc-200 bg-white p-3 sm:grid-cols-[1fr_1.4fr_1fr_auto] sm:items-end"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const ok = await inviteStudent(name.trim(), email.trim(), phone.trim() || undefined);
        setBusy(false);
        if (ok) {
          setName("");
          setEmail("");
          setPhone("");
          setOpen(false);
        }
      }}
    >
      <label className={labelCls} htmlFor="invite-name">
        이름
        <input
          id="invite-name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={cn(inputCls, "mt-1")}
        />
      </label>
      <label className={labelCls} htmlFor="invite-email">
        로그인 이메일
        <input
          id="invite-email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={cn(inputCls, "mt-1")}
        />
      </label>
      <label className={labelCls} htmlFor="invite-phone">
        휴대폰 (알림톡, 선택)
        <input
          id="invite-phone"
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          className={cn(inputCls, "mt-1")}
        />
      </label>
      <div className="flex gap-2">
        <Button size="sm" onClick={() => setOpen(false)}>
          취소
        </Button>
        <Button type="submit" variant="primary" size="sm" disabled={busy}>
          초대
        </Button>
      </div>
      <p className="text-xs text-zinc-500 sm:col-span-4">
        초대한 레슨생이 이 이메일로 로그인하면 바로 연결됩니다. 이어서 &lsquo;수강 등록&rsquo;으로
        고정 시간을 정해 주세요.
      </p>
    </form>
  );
}
