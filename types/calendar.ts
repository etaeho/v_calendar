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
  | "PENDING_CHANGE";

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
  /** 댓글 스레드 id. 슬롯이 OPEN 으로 돌아가면 새 스레드로 교체되어 이전 대화가 노출되지 않는다 */
  threadId: string;
}

export type RequestKind = "BOOKING" | "CHANGE";
export type RequestStatus = "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";

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

/** 레슨 도메인 전체 상태 (상태 머신의 입력/출력) */
export interface LessonState {
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
  | "CLOSED";

export interface SlotView {
  slot: LessonSlot;
  display: SlotDisplay;
  masked: boolean;
  /** 현재 사용자의 레슨/요청인지 (강사는 항상 false) */
  mine: boolean;
  request?: ScheduleRequest;
}

export type CalendarViewMode = "month" | "week";
