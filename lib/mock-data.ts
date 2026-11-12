/**
 * Mock 데이터. 접속한 주(일요일 시작)를 기준으로 상대 날짜로 생성해
 * 언제 열어도 이번 주 ~ 다음 주에 데이터가 보이도록 한다.
 */
import { addDays, addMinutes, addMonths, endOfMonth, startOfMonth, startOfWeek } from "date-fns";
import {
  registerEnrollment,
  toDateKey,
  type EnrollmentInput,
  type HolidayLookup,
} from "@/lib/enrollment";
import { overlaps, type MachineContext } from "@/lib/lesson-machine";
import type {
  Actor,
  Comment,
  ExternalEvent,
  ExternalProvider,
  LessonSlot,
  LessonState,
  ScheduleRequest,
  User,
} from "@/types/calendar";

/** 테스트베드: 강사 1명 + 레슨생 5명 */
export const INSTRUCTOR: User = { id: "t1", name: "정유진 선생님", role: "INSTRUCTOR" };

export const STUDENTS: User[] = [
  { id: "s1", name: "김하은", role: "STUDENT" },
  { id: "s2", name: "이도윤", role: "STUDENT" },
  { id: "s3", name: "박서연", role: "STUDENT" },
  { id: "s4", name: "최민준", role: "STUDENT" },
  { id: "s5", name: "정서아", role: "STUDENT" },
];

export const USERS: User[] = [INSTRUCTOR, ...STUDENTS];

export const userName = (id: string | undefined) =>
  USERS.find((u) => u.id === id)?.name ?? "알 수 없음";

/** 이번 주 일요일 기준 day 일 뒤의 HH:MM */
const makeAt = (now: Date) => {
  const base = startOfWeek(now, { weekStartsOn: 0 });
  return (day: number, hour: number, minute = 0) =>
    addMinutes(addDays(base, day), hour * 60 + minute);
};

/** 테스트베드 수강 등록: 접속한 달 기준 상대 기간 */
function seedEnrollments(now: Date): EnrollmentInput[] {
  const monthStart = (offset: number) => toDateKey(startOfMonth(addMonths(now, offset)));
  const monthEnd = (offset: number) => toDateKey(endOfMonth(addMonths(now, offset)));
  const weekly = [1, 2, 3, 4];
  const t = (weekday: number, time: string) => ({ weekday, time, durationMin: 60 });
  return [
    // 주 1회 · 3개월
    { studentId: "s1", startDate: monthStart(-1), endDate: monthEnd(1), times: [t(2, "19:00")], weeks: weekly, changeDeadlineHours: 24, fee: 200_000, paymentDay: 25 },
    // 주 1회 · 6개월
    { studentId: "s2", startDate: monthStart(-2), endDate: monthEnd(3), times: [t(1, "18:00")], weeks: weekly, changeDeadlineHours: 12, fee: 200_000, paymentDay: 1 },
    // 주 1회 · 이번 달 말 종료 예정
    { studentId: "s3", startDate: monthStart(-2), endDate: monthEnd(0), times: [t(3, "17:00")], weeks: weekly, changeDeadlineHours: 24, fee: 220_000, paymentDay: 5 },
    // 격주(2·4주) 월 2회 · 6개월
    { studentId: "s4", startDate: monthStart(0), endDate: monthEnd(5), times: [t(5, "16:00")], weeks: [2, 4], changeDeadlineHours: 48, fee: 110_000, paymentDay: 10 },
    // 주 2회 월 8회 · 3개월, 변경 마감 없음
    { studentId: "s5", startDate: monthStart(-1), endDate: monthEnd(1), times: [t(2, "17:00"), t(6, "13:00")], weeks: weekly, changeDeadlineHours: 0, fee: 380_000, paymentDay: 15 },
  ];
}

export function createInitialLessonState(now: Date, holiday: HolidayLookup): LessonState {
  const at = makeAt(now);
  const iso = (d: Date) => d.toISOString();
  const nowIso = iso(now);
  let n = 0;
  const ctx: MachineContext = { now: () => nowIso, id: (prefix) => `seed-${prefix}-${++n}` };
  const instructor: Actor = { userId: INSTRUCTOR.id, role: "INSTRUCTOR" };

  // 1) 수강 등록 → 기간 전체의 정규 레슨 자동 생성
  let state: LessonState = { enrollments: [], makeupAdjustments: [], slots: [], requests: [], comments: [] };
  for (const input of seedEnrollments(now)) {
    state = registerEnrollment(state, instructor, input, ctx, holiday).state;
  }

  // 2) 강사가 열어 둔 빈 슬롯 (이번 주 일요일 기준 day 일 뒤). 정규 레슨과 겹치면 건너뛴다
  const slots: LessonSlot[] = [...state.slots];
  const open = (id: string, day: number, hour: number) => {
    const start = at(day, hour);
    const end = addMinutes(start, 60);
    if (slots.some((s) => overlaps(s.start, s.end, iso(start), iso(end)))) return;
    slots.push({ id, start: iso(start), end: iso(end), status: "OPEN", threadId: `t-${id}` });
  };
  open("o-thu-18", 4, 18);
  open("o-thu-19", 4, 19);
  open("o-fri-17", 5, 17);
  open("o-fri-18", 5, 18);
  open("o-sat-10", 6, 10);
  open("o-sat-11", 6, 11);
  open("o-sat-14", 6, 14);
  open("o-mon-19", 8, 19);
  open("o-wed-19-w2", 10, 19);
  open("o-thu-18-w2", 11, 18);
  open("o-thu-19-w2", 11, 19);
  open("o-fri-19-w2", 12, 19);
  open("o-sat-10-w2", 13, 10);
  open("o-sat-11-w2", 13, 11);

  // 3) 진행 중인 요청들 (해당 슬롯이 있고 아직 미래일 때만)
  const requests: ScheduleRequest[] = [];
  const comments: Comment[] = [];
  const ago = (hours: number) => iso(addMinutes(now, -hours * 60));
  const find = (id: string) => slots.find((s) => s.id === id);
  const lessonAt = (studentId: string, day: number, hour: number) =>
    slots.find(
      (s) => s.studentId === studentId && s.status === "CONFIRMED" && s.start === iso(at(day, hour)),
    );
  const future = (s: LessonSlot | undefined): s is LessonSlot => !!s && new Date(s.start) > now;
  let c = 0;
  const comment = (threadId: string, hoursAgo: number, body: string, authorId?: string) =>
    comments.push({
      id: `seed-c-${++c}`,
      threadId,
      kind: authorId ? "USER" : "SYSTEM",
      authorId,
      body,
      createdAt: ago(hoursAgo),
    });

  const booking = (id: string, slotId: string, studentId: string, hoursAgo: number, message: string) => {
    const slot = find(slotId);
    if (!future(slot) || slot.status !== "OPEN") return;
    Object.assign(slot, { status: "PENDING_BOOKING", studentId, lessonType: "MAKEUP", requestId: id });
    requests.push({
      id,
      kind: "BOOKING",
      status: "PENDING",
      studentId,
      requestedBy: "STUDENT",
      toSlotId: slot.id,
      toStart: slot.start,
      message,
      createdAt: ago(hoursAgo),
    });
    comment(slot.threadId, hoursAgo, "보강 신청이 접수되었습니다. 강사 승인을 기다리는 중입니다.");
  };
  booking("req-book-s3", "o-fri-18", "s3", 20, "콩쿠르 전에 한 번 더 봐주실 수 있을까요?");
  booking("req-book-s1", "o-sat-14", "s1", 5, "지난달 빠진 레슨 보강으로 신청드려요.");
  booking("req-book-s5", "o-thu-18-w2", "s5", 1, "학교 시험 끝나고 보강 받고 싶어요.");

  const change = (
    id: string,
    from: LessonSlot | undefined,
    toId: string,
    requestedBy: "STUDENT" | "INSTRUCTOR",
    hoursAgo: number,
    message: string,
  ) => {
    const to = find(toId);
    if (!future(from) || !future(to) || to.status !== "OPEN") return;
    from.status = "PENDING_CHANGE";
    from.requestId = id;
    Object.assign(to, {
      status: "PENDING_CHANGE",
      studentId: from.studentId,
      lessonType: from.lessonType,
      enrollmentId: from.enrollmentId,
      requestId: id,
      threadId: from.threadId,
    });
    requests.push({
      id,
      kind: "CHANGE",
      status: "PENDING",
      studentId: from.studentId!,
      requestedBy,
      fromSlotId: from.id,
      toSlotId: to.id,
      fromStart: from.start,
      toStart: to.start,
      message,
      createdAt: ago(hoursAgo),
    });
    comment(
      from.threadId,
      hoursAgo,
      requestedBy === "STUDENT"
        ? "레슨생이 일정 변경을 요청했습니다. 강사 승인을 기다리는 중입니다."
        : "강사가 일정 변경을 요청했습니다. 레슨생 동의를 기다리는 중입니다.",
    );
  };
  const s2Next = lessonAt("s2", 8, 18);
  const s1Next = lessonAt("s1", 9, 19);
  change("req-change-s2", s2Next, "o-thu-19-w2", "STUDENT", 9, "월요일에 학교 행사가 있어서 목요일로 옮기고 싶어요.");
  change("req-change-t1", s1Next, "o-wed-19-w2", "INSTRUCTOR", 3, "화요일에 오케스트라 리허설이 잡혀서, 수요일 같은 시간 괜찮을까요?");

  // 4) 메시지
  const chat = (slot: LessonSlot | undefined, hoursAgo: number, body: string, authorId: string) => {
    if (slot) comment(slot.threadId, hoursAgo, body, authorId);
  };
  const s1This = lessonAt("s1", 2, 19);
  chat(s1This, 30, "선생님, 이번 주는 비브라토 연습해 갈게요!", "s1");
  chat(s1This, 29, "좋아요. 스케일 3옥타브도 같이 봐요 🎻", "t1");
  chat(find("o-sat-14"), 4, "보강 때 콩쿠르 곡 1악장 봐주실 수 있나요?", "s1");
  chat(s2Next, 8, "목요일 7시면 학원 끝나고 바로 갈 수 있어요.", "s2");
  chat(s1Next, 2, "수요일에 어렵다면 편하게 거절해도 괜찮아요.", "t1");
  const s4This = lessonAt("s4", 5, 16);
  chat(s4This, 26, "선생님 이번 주 송진 새로 사 갈게요.", "s4");
  chat(s4This, 25, "네 좋아요. 활 털도 한번 봐 줄게요.", "t1");

  // 5) 보강 이력: 지난주 박서연 레슨은 날짜를 못 정해 보강으로 미룸, 결석·강사 사정 조정
  const s3Last = lessonAt("s3", -4, 17);
  if (s3Last) {
    Object.assign(s3Last, { status: "SKIPPED", skipReason: "DEFERRED" });
    comment(s3Last.threadId, 24 * 6, "레슨생이 동의해 이 레슨은 보강으로 미뤘습니다. (보강 필요 1회)");
  }
  const makeupAdjustments = [
    { id: "seed-adj-1", studentId: "s1", delta: 1, reason: "지난달 결석", createdAt: ago(24 * 20) },
    { id: "seed-adj-2", studentId: "s2", delta: 1, reason: "강사 사정 취소 (10월)", createdAt: ago(24 * 30) },
  ];

  return { enrollments: state.enrollments, makeupAdjustments, slots, requests, comments };
}

type EventSeed = [day: number, hour: number, minute: number, minutes: number, title: string, location?: string];

const EXTERNAL_SEEDS: Record<string, Record<ExternalProvider, EventSeed[]>> = {
  s1: {
    GOOGLE: [
      [1, 10, 0, 60, "주간 팀 회의", "회의실 A"],
      [3, 14, 0, 90, "디자인 리뷰"],
      [4, 18, 30, 60, "프로젝트 회고", "온라인"],
      [8, 10, 0, 60, "주간 팀 회의", "회의실 A"],
      [10, 14, 0, 180, "전사 워크숍", "본사 대강당"],
      [12, 19, 0, 60, "치과 예약", "서울치과"],
    ],
    KAKAO: [
      [5, 19, 30, 120, "대학 동기 저녁", "합정"],
      [6, 10, 30, 90, "브런치 약속", "연남동"],
      [7, 12, 0, 120, "가족 모임"],
      [11, 19, 0, 120, "동호회 정모", "홍대"],
      [13, 13, 0, 120, "결혼식", "강남 웨딩홀"],
    ],
  },
  s2: {
    GOOGLE: [
      [1, 15, 0, 120, "학교 수업", "OO고등학교"],
      [9, 16, 0, 90, "수학 학원"],
    ],
    KAKAO: [
      [4, 20, 0, 60, "친구 생일 파티"],
      [11, 17, 0, 60, "스터디 모임"],
    ],
  },
  s3: {
    GOOGLE: [
      [3, 18, 0, 60, "콩쿠르 반주 맞추기", "예술회관 연습실"],
      [12, 10, 0, 120, "콩쿠르 본선", "예술회관"],
    ],
    KAKAO: [[6, 12, 0, 120, "가족 외식"]],
  },
  s4: {
    GOOGLE: [
      [5, 15, 30, 60, "팀 프로젝트 회의", "온라인"],
      [8, 9, 0, 120, "중간 발표"],
    ],
    KAKAO: [
      [6, 17, 0, 120, "동아리 공연 연습"],
      [12, 16, 30, 90, "병원 예약"],
    ],
  },
  s5: {
    GOOGLE: [
      [4, 17, 30, 60, "영어 학원"],
      [11, 17, 30, 60, "영어 학원"],
    ],
    KAKAO: [
      [6, 13, 0, 60, "가족 점심"],
      [13, 11, 0, 90, "피아노 레슨"],
    ],
  },
  [INSTRUCTOR.id]: {
    GOOGLE: [
      [3, 10, 0, 60, "음악학원 강사 회의"],
      [6, 15, 0, 180, "오케스트라 리허설", "예술의전당"],
      [9, 19, 0, 120, "오케스트라 리허설", "예술의전당"],
    ],
    KAKAO: [
      [5, 20, 0, 120, "공연 관람", "롯데콘서트홀"],
      [13, 15, 0, 120, "악기 점검 예약", "서초 현악기 공방"],
    ],
  },
};

/** Mock 동기화 서비스가 돌려주는 가상의 개인 일정 */
export function createMockExternalEvents(
  provider: ExternalProvider,
  userId: string,
  now: Date,
): ExternalEvent[] {
  const at = makeAt(now);
  const seeds = EXTERNAL_SEEDS[userId]?.[provider] ?? [];
  return seeds.map(([day, hour, minute, minutes, title, location], i) => {
    const start = at(day, hour, minute);
    return {
      id: `${provider.toLowerCase()}-${userId}-${i}`,
      provider,
      ownerId: userId,
      title,
      start: start.toISOString(),
      end: addMinutes(start, minutes).toISOString(),
      location,
    };
  });
}
