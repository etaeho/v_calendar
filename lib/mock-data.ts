/**
 * Mock 데이터. 접속한 주(일요일 시작)를 기준으로 상대 날짜로 생성해
 * 언제 열어도 이번 주 ~ 다음 주에 데이터가 보이도록 한다.
 */
import { addDays, addMinutes, startOfWeek } from "date-fns";
import type {
  Comment,
  ExternalEvent,
  ExternalProvider,
  LessonSlot,
  LessonState,
  ScheduleRequest,
  User,
} from "@/types/calendar";

export const INSTRUCTOR: User = { id: "t1", name: "정유진 선생님", role: "INSTRUCTOR" };
/** 레슨생 모드에서 '나' */
export const ME_STUDENT: User = { id: "s1", name: "김하은", role: "STUDENT" };

export const USERS: User[] = [
  INSTRUCTOR,
  ME_STUDENT,
  { id: "s2", name: "이도윤", role: "STUDENT" },
  { id: "s3", name: "박서연", role: "STUDENT" },
];

export const userName = (id: string | undefined) =>
  USERS.find((u) => u.id === id)?.name ?? "알 수 없음";

/** 이번 주 일요일 기준 day 일 뒤의 HH:MM */
const makeAt = (now: Date) => {
  const base = startOfWeek(now, { weekStartsOn: 0 });
  return (day: number, hour: number, minute = 0) =>
    addMinutes(addDays(base, day), hour * 60 + minute);
};

export function createInitialLessonState(now: Date): LessonState {
  const at = makeAt(now);
  const iso = (d: Date) => d.toISOString();
  const slots: LessonSlot[] = [];
  const add = (
    id: string,
    day: number,
    hour: number,
    rest: Partial<LessonSlot> = {},
    minutes = 60,
  ) => {
    const start = at(day, hour);
    slots.push({
      id,
      start: iso(start),
      end: iso(addMinutes(start, minutes)),
      status: "OPEN",
      threadId: `t-${id}`,
      ...rest,
    });
  };
  const lesson = (studentId: string, extra: Partial<LessonSlot> = {}): Partial<LessonSlot> => ({
    status: "CONFIRMED",
    studentId,
    lessonType: "REGULAR",
    ...extra,
  });

  // 지난주
  add("l-s1-prev", -5, 19, lesson("s1"));
  add("l-s2-prev", -6, 18, lesson("s2"));

  // 이번 주 (0=일 … 6=토)
  add("l-s2-w1", 1, 18, lesson("s2"));
  add("l-s1-w1", 2, 19, lesson("s1"));
  add("l-s3-w1", 3, 17, lesson("s3"));
  add("o-thu-18", 4, 18);
  add("o-thu-19", 4, 19);
  add("o-fri-17", 5, 17);
  add("p-s3-fri-18", 5, 18, {
    status: "PENDING_BOOKING",
    studentId: "s3",
    lessonType: "MAKEUP",
    requestId: "req-book-s3",
  });
  add("o-sat-10", 6, 10);
  add("o-sat-11", 6, 11);
  add("p-s1-sat-14", 6, 14, {
    status: "PENDING_BOOKING",
    studentId: "s1",
    lessonType: "MAKEUP",
    requestId: "req-book-s1",
  });

  // 다음 주
  add("l-s2-w2", 8, 18, lesson("s2", { status: "PENDING_CHANGE", requestId: "req-change-s2" }));
  add("o-mon-19", 8, 19);
  add("l-s1-w2", 9, 19, lesson("s1", { status: "PENDING_CHANGE", requestId: "req-change-t1" }));
  add("l-s3-w2", 10, 17, lesson("s3"));
  add("c-s1-wed-19", 10, 19, lesson("s1", {
    status: "PENDING_CHANGE",
    requestId: "req-change-t1",
    threadId: "t-l-s1-w2",
  }));
  add("o-thu-18-w2", 11, 18);
  add("c-s2-thu-19", 11, 19, lesson("s2", {
    status: "PENDING_CHANGE",
    requestId: "req-change-s2",
    threadId: "t-l-s2-w2",
  }));
  add("o-fri-19-w2", 12, 19);
  add("o-sat-10-w2", 13, 10);
  add("o-sat-11-w2", 13, 11);

  // 그다음 주 정규 레슨
  add("l-s2-w3", 15, 18, lesson("s2"));
  add("l-s1-w3", 16, 19, lesson("s1"));
  add("l-s3-w3", 17, 17, lesson("s3"));

  const start = (id: string) => slots.find((s) => s.id === id)!.start;
  const ago = (hours: number) => iso(addMinutes(now, -hours * 60));

  const requests: ScheduleRequest[] = [
    {
      id: "req-book-s3",
      kind: "BOOKING",
      status: "PENDING",
      studentId: "s3",
      requestedBy: "STUDENT",
      toSlotId: "p-s3-fri-18",
      toStart: start("p-s3-fri-18"),
      message: "콩쿠르 전에 한 번 더 봐주실 수 있을까요?",
      createdAt: ago(20),
    },
    {
      id: "req-book-s1",
      kind: "BOOKING",
      status: "PENDING",
      studentId: "s1",
      requestedBy: "STUDENT",
      toSlotId: "p-s1-sat-14",
      toStart: start("p-s1-sat-14"),
      message: "지난달 빠진 레슨 보강으로 신청드려요.",
      createdAt: ago(5),
    },
    {
      id: "req-change-s2",
      kind: "CHANGE",
      status: "PENDING",
      studentId: "s2",
      requestedBy: "STUDENT",
      fromSlotId: "l-s2-w2",
      toSlotId: "c-s2-thu-19",
      fromStart: start("l-s2-w2"),
      toStart: start("c-s2-thu-19"),
      message: "월요일에 학교 행사가 있어서 목요일로 옮기고 싶어요.",
      createdAt: ago(9),
    },
    {
      id: "req-change-t1",
      kind: "CHANGE",
      status: "PENDING",
      studentId: "s1",
      requestedBy: "INSTRUCTOR",
      fromSlotId: "l-s1-w2",
      toSlotId: "c-s1-wed-19",
      fromStart: start("l-s1-w2"),
      toStart: start("c-s1-wed-19"),
      message: "화요일에 오케스트라 리허설이 잡혀서, 수요일 같은 시간 괜찮을까요?",
      createdAt: ago(3),
    },
  ];

  let n = 0;
  const comment = (
    threadId: string,
    hoursAgo: number,
    body: string,
    authorId?: string,
  ): Comment => ({
    id: `seed-c-${++n}`,
    threadId,
    kind: authorId ? "USER" : "SYSTEM",
    authorId,
    body,
    createdAt: ago(hoursAgo),
  });

  const comments: Comment[] = [
    comment("t-l-s1-w1", 30, "선생님, 이번 주는 비브라토 연습해 갈게요!", "s1"),
    comment("t-l-s1-w1", 29, "좋아요. 스케일 3옥타브도 같이 봐요 🎻", "t1"),
    comment("t-p-s1-sat-14", 5, "보강 신청이 접수되었습니다. 강사 승인을 기다리는 중입니다."),
    comment("t-p-s1-sat-14", 4, "보강 때 콩쿠르 곡 1악장 봐주실 수 있나요?", "s1"),
    comment("t-p-s3-fri-18", 20, "보강 신청이 접수되었습니다. 강사 승인을 기다리는 중입니다."),
    comment("t-l-s2-w2", 9, "레슨생이 일정 변경을 요청했습니다. 강사 승인을 기다리는 중입니다."),
    comment("t-l-s2-w2", 8, "목요일 7시면 학원 끝나고 바로 갈 수 있어요.", "s2"),
    comment("t-l-s1-w2", 3, "강사가 일정 변경을 요청했습니다. 레슨생 동의를 기다리는 중입니다."),
    comment("t-l-s1-w2", 2, "수요일에 어렵다면 편하게 거절해도 괜찮아요.", "t1"),
  ];

  return { slots, requests, comments };
}

type EventSeed = [day: number, hour: number, minute: number, minutes: number, title: string, location?: string];

const EXTERNAL_SEEDS: Record<string, Record<ExternalProvider, EventSeed[]>> = {
  [ME_STUDENT.id]: {
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
