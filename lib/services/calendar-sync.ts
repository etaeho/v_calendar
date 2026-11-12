/**
 * 외부 캘린더 연동 계층.
 *
 * UI/스토어는 CalendarSyncService 인터페이스에만 의존한다.
 * Phase 3 에서 GoogleCalendarSyncService / KakaoCalendarSyncService (OAuth 토큰 기반) 구현체를
 * 만들어 `calendarSyncServices` 레지스트리만 교체하면 된다.
 */
import { createMockExternalEvents } from "@/lib/mock-data";
import type { ExternalEvent, ExternalProvider, LessonSlot } from "@/types/calendar";

export interface DateRange {
  start: Date;
  end: Date;
}

export interface CalendarSyncService {
  readonly provider: ExternalProvider;
  /** OAuth 연결 여부 */
  isConnected(userId: string): Promise<boolean>;
  /** OAuth 동의 플로우 시작 → 토큰 저장 */
  connect(userId: string): Promise<void>;
  disconnect(userId: string): Promise<void>;
  /** 외부 캘린더의 개인 일정 조회 (Read) */
  fetchEvents(userId: string, range?: DateRange): Promise<ExternalEvent[]>;
  /** 확정된 레슨을 외부 캘린더에 등록 (Write). 외부 이벤트 id 반환 */
  pushLesson(userId: string, lesson: LessonSlot): Promise<string>;
  /** 변경/취소된 레슨을 외부 캘린더에서 제거 */
  removeLesson(userId: string, lessonId: string): Promise<void>;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** MVP 용 Mock 구현 — 네트워크 지연을 흉내 내고 가상의 개인 일정을 돌려준다 */
export class MockCalendarSyncService implements CalendarSyncService {
  private connected = new Set<string>();
  /** userId:lessonId → 외부 이벤트 id (Push 기록) */
  readonly pushed = new Map<string, string>();

  constructor(
    readonly provider: ExternalProvider,
    private latencyMs = 700,
  ) {}

  async isConnected(userId: string) {
    return this.connected.has(userId);
  }

  async connect(userId: string) {
    await delay(this.latencyMs / 2);
    this.connected.add(userId);
  }

  async disconnect(userId: string) {
    this.connected.delete(userId);
  }

  async fetchEvents(userId: string, range?: DateRange) {
    if (!this.connected.has(userId)) await this.connect(userId);
    await delay(this.latencyMs);
    const events = createMockExternalEvents(this.provider, userId, new Date());
    if (!range) return events;
    return events.filter(
      (e) => new Date(e.start) < range.end && new Date(e.end) > range.start,
    );
  }

  async pushLesson(userId: string, lesson: LessonSlot) {
    const externalId = `${this.provider.toLowerCase()}-lesson-${lesson.id}`;
    this.pushed.set(`${userId}:${lesson.id}`, externalId);
    return externalId;
  }

  async removeLesson(userId: string, lessonId: string) {
    this.pushed.delete(`${userId}:${lessonId}`);
  }
}

export const calendarSyncServices: Record<ExternalProvider, CalendarSyncService> = {
  GOOGLE: new MockCalendarSyncService("GOOGLE"),
  KAKAO: new MockCalendarSyncService("KAKAO"),
};
