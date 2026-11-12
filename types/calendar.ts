/**
 * 도메인 타입 정의 — 레슨 스케줄러 + 통합 캘린더
 * 날짜/시간은 모두 ISO 8601 문자열(UTC)로 저장한다. (Phase 2 DB 연동 시 그대로 직렬화 가능)
 */

/** 사용자 역할 */
export type UserRole = "INSTRUCTOR" | "STUDENT";

export interface User {
  id: string;
  name: string;
  role: UserRole;
}

/** 캘린더 카테고리 (사이드바 필터 단위) */
export type CalendarCategory = "LESSON" | "GOOGLE" | "KAKAO";

/** 외부 캘린더 제공자 */
export type ExternalProvider = Extract<CalendarCategory, "GOOGLE" | "KAKAO">;

export interface CalendarMeta {
  id: CalendarCategory;
  label: string;
  description: string;
}

/**
 * 레슨 슬롯 상태 머신
 * - OPEN            : 강사가 등록한 레슨 가능 빈 시간
 * - CONFIRMED       : 확정된 정규/보강 레슨
 * - PENDING_BOOKING : 레슨생이 보강을 신청, 강사 승인 대기
 * - PENDING_CHANGE  : 일정 변경 요청 진행 중 (기존 슬롯과 대상 슬롯 모두 이 상태)
 */
export type SlotStatus =
  | "OPEN"
  | "CONFIRMED"
  | "PENDING_BOOKING"
  | "PENDING_CHANGE"
  /** 휴강 (공휴일 등으로 쉬기로 한 레슨). 시간을 점유하지 않고 기록으로만 남는다 */
  | "SKIPPED";

/** 공휴일에 잡힌 레슨을 어떻게 할지: 미결정 / 그대로 진행 / 휴강 */
export type HolidayDecision = "UNDECIDED" | "PROCEED" | "SKIP";

export type LessonType = "REGULAR" | "MAKEUP";

export interface LessonSlot {
  id: string;
  start: string;
  end: string;
  status: SlotStatus;
  /** 슬롯을 점유(또는 점유 요청)한 레슨생. OPEN 이면 undefined */
  studentId?: string;
  lessonType?: LessonType;
  /** 진행 중인 요청(보강 신청/일정 변경) id */
  requestId?: string;
  /** 수강 등록(Enrollment)으로 자동 생성된 정규 레슨이면 그 등록 id */
  enrollmentId?: string;
  /** 레슨일이 공휴일이면 그 이름과 결정 상태 */
  holidayName?: string;
  holidayDecision?: HolidayDecision;
  /** 일정 변경으로 옮겨 온 레슨이면 원래 시작 시각 */
  movedFrom?: string;
  /** 댓글 스레드 id. 슬롯이 OPEN 으로 돌아가면 새 스레드로 교체되어 이전 대화가 노출되지 않는다 */
  threadId: string;
}

export type RequestKind = "BOOKING" | "CHANGE" | "HOLIDAY";
/** EXPIRED: 응답 없이 해당 시간이 지나 자동 종료된 요청 */
export type RequestStatus = "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED" | "EXPIRED";

/** 보강 신청 / 일정 변경 요청 */
export interface ScheduleRequest {
  id: string;
  kind: RequestKind;
  status: RequestStatus;
  studentId: string;
  /** 요청을 보낸 쪽. 승인/거절은 반대쪽 역할만 할 수 있다 */
  requestedBy: UserRole;
  /** CHANGE 일 때의 기존 레슨 슬롯 */
  fromSlotId?: string;
  /** 신청/변경 대상 슬롯 */
  toSlotId: string;
  /** 요청 시점의 시간 스냅샷 (슬롯이 삭제/변경되어도 내역 표시에 사용) */
  fromStart?: string;
  toStart: string;
  /** HOLIDAY 요청의 제안 내용 (그대로 진행 / 휴강) */
  holidayProposal?: Exclude<HolidayDecision, "UNDECIDED">;
  /** 요청과 함께 보낸 메시지 (요청 카드에 표시, 메신저와 분리) */
  message?: string;
  createdAt: string;
  resolvedAt?: string;
  rejectReason?: string;
}

export interface Comment {
  id: string;
  threadId: string;
  /** SYSTEM 댓글은 authorId 가 없다 */
  authorId?: string;
  kind: "USER" | "SYSTEM";
  body: string;
  createdAt: string;
}

/** 외부 캘린더(구글/카카오)에서 가져온 개인 일정 */
export interface ExternalEvent {
  id: string;
  provider: ExternalProvider;
  ownerId: string;
  title: string;
  start: string;
  end: string;
  location?: string;
}

/** 고정 레슨 시간 (요일 + 시각) */
export interface WeeklyTime {
  /** 0=일 … 6=토 */
  weekday: number;
  /** "HH:mm" */
  time: string;
  durationMin: number;
}

/**
 * 수강 등록: 레슨생이 일정 기간(3·6개월 등) 같은 시간대에 받기로 한 정규 레슨.
 * 주당 횟수 = times.length, 월 횟수 = times.length × weeks.length
 */
export interface Enrollment {
  id: string;
  studentId: string;
  /** "yyyy-MM-dd" (현지 날짜) */
  startDate: string;
  endDate: string;
  times: WeeklyTime[];
  /**
   * 진행하는 주차 = 그 달에서 해당 요일의 몇 번째 날인지.
   * [1,2,3,4] 매주(5번째는 쉼) · [1,3] 또는 [2,4] 격주
   */
  weeks: number[];
  /** 레슨생이 일정 변경을 요청할 수 있는 마감: 레슨 시작 n시간 전까지 (0 = 제한 없음). 등록 시 합의 */
  changeDeadlineHours: number;
  /** 월 수강료(원)와 결제 예정일(매월 n일) */
  fee?: number;
  paymentDay?: number;
}

/** 레슨 도메인 전체 상태 (상태 머신의 입력/출력) */
export interface LessonState {
  enrollments: Enrollment[];
  slots: LessonSlot[];
  requests: ScheduleRequest[];
  comments: Comment[];
}

/** 행위자 */
export interface Actor {
  userId: string;
  role: UserRole;
}

/**
 * 역할별 화면 표시용 슬롯.
 * 레슨생에게 다른 레슨생의 슬롯은 masked=true 로 내려가며 개인정보(studentId 등)가 제거된다.
 */
export type SlotDisplay =
  | "OPEN"
  | "CONFIRMED"
  | "PENDING_BOOKING"
  | "PENDING_CHANGE_FROM"
  | "PENDING_CHANGE_TO"
  /** 공휴일 레슨: 진행/휴강/이동 결정이 필요 */
  | "HOLIDAY_DECISION"
  | "SKIPPED"
  | "CLOSED";

export interface SlotView {
  slot: LessonSlot;
  display: SlotDisplay;
  masked: boolean;
  /** 현재 사용자의 레슨/요청인지 (강사는 항상 false) */
  mine: boolean;
  request?: ScheduleRequest;
  /** 정규 레슨의 그 달 회차 (예: 4회 중 3번째) */
  seq?: { n: number; total: number };
}

export type CalendarViewMode = "month" | "week" | "students";
