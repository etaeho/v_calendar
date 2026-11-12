/**
 * 외부 캘린더 연동 계층.
 *
 * UI/스토어는 CalendarSyncService 인터페이스에만 의존한다.
 * `calendarSyncServices` 레지스트리는 제공자마다 호출 시점에 구현을 고른다:
 *   - 환경 변수가 설정되어 있고 브라우저(https/localhost)에서 제공자에 닿을 수 있으면 실제 연동
 *     (lib/integrations/google-calendar.ts, kakao-calendar.ts)
 *   - 그 밖(미설정, 서버 렌더링, claude.ai 미리보기, 스크립트 로드 실패)에는 MockCalendarSyncService
 * 상태는 `integrationStatus()` (lib/integrations) 로 확인할 수 있다.
 */
import { createMockExternalEvents } from "@/lib/mock-data";
import { isRealMode, type IntegrationMode } from "@/lib/integrations/config";
import { reportIntegrationError } from "@/lib/integrations/errors";
import { getRealCalendarService } from "@/lib/integrations";
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

/**
 * 호출할 때마다 실제/Mock 구현을 고르는 래퍼.
 * - 서버 렌더링 중에는 Mock, 브라우저에서 설정이 있으면 실제 구현으로 자연스럽게 넘어간다.
 * - pushLesson/removeLesson 은 스토어가 결과를 기다리지 않으므로 실패를 삼키고
 *   console.warn + subscribeIntegrationErrors 구독자에게 알린다 (레슨 확정 자체는 유지).
 * - fetchEvents/connect 의 실패는 CalendarIntegrationError(한국어 message)로 그대로 전달된다.
 */
export class ProviderSelectingSyncService implements CalendarSyncService {
  readonly provider: ExternalProvider;
  readonly mock: MockCalendarSyncService;

  constructor(provider: ExternalProvider, mock: MockCalendarSyncService = new MockCalendarSyncService(provider)) {
    this.provider = provider;
    this.mock = mock;
  }

  /** 현재 쓰이는 구현 */
  get mode(): IntegrationMode {
    return isRealMode(this.provider) ? "real" : "mock";
  }

  private get target(): CalendarSyncService {
    return this.mode === "real" ? getRealCalendarService(this.provider) : this.mock;
  }

  async isConnected(userId: string) {
    try {
      return await this.target.isConnected(userId);
    } catch {
      return false;
    }
  }

  async connect(userId: string) {
    try {
      await this.target.connect(userId);
    } catch (e) {
      throw reportIntegrationError(this.provider, e, "connect");
    }
  }

  async disconnect(userId: string) {
    try {
      await this.target.disconnect(userId);
    } catch (e) {
      reportIntegrationError(this.provider, e, "disconnect");
    }
  }

  async fetchEvents(userId: string, range?: DateRange) {
    try {
      return await this.target.fetchEvents(userId, range);
    } catch (e) {
      throw reportIntegrationError(this.provider, e, "fetchEvents");
    }
  }

  async pushLesson(userId: string, lesson: LessonSlot) {
    try {
      return await this.target.pushLesson(userId, lesson);
    } catch (e) {
      reportIntegrationError(this.provider, e, "pushLesson");
      return "";
    }
  }

  async removeLesson(userId: string, lessonId: string) {
    try {
      await this.target.removeLesson(userId, lessonId);
    } catch (e) {
      reportIntegrationError(this.provider, e, "removeLesson");
    }
  }
}

export const calendarSyncServices: Record<ExternalProvider, ProviderSelectingSyncService> = {
  GOOGLE: new ProviderSelectingSyncService("GOOGLE"),
  KAKAO: new ProviderSelectingSyncService("KAKAO"),
};
