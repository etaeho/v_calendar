/**
 * 구글 캘린더 연동 (읽기 + 쓰기).
 *
 * 인증: Google Identity Services(GIS) 토큰 모델.
 *   - https://accounts.google.com/gsi/client 를 동적으로 불러와
 *     google.accounts.oauth2.initTokenClient({ client_id, scope, callback }) 로 토큰을 받는다.
 *   - 토큰 요청은 팝업을 띄우므로 **반드시 버튼 클릭 같은 사용자 동작 안에서** connect() 를 호출해야 한다.
 *     (클릭과 무관한 타이머/useEffect 에서 부르면 브라우저가 팝업을 막는다 → POPUP_BLOCKED)
 *   - 액세스 토큰(약 1시간 유효)은 메모리에만 보관한다. 새로고침하면 다시 연결해야 한다.
 *
 * API: Google Calendar API v3 (discovery revision 20261109 기준으로 경로/파라미터 확인함)
 *   - 목록  GET    /calendars/primary/events?timeMin&timeMax&singleEvents&orderBy&maxResults
 *   - 검색  GET    /calendars/primary/events?privateExtendedProperty=vcalLessonId=<id>
 *   - 생성  POST   /calendars/primary/events
 *   - 수정  PATCH  /calendars/primary/events/{eventId}
 *   - 삭제  DELETE /calendars/primary/events/{eventId}
 */
import type { ExternalEvent, LessonSlot } from "../../types/calendar";
import type { CalendarSyncService } from "../services/calendar-sync";
import { CalendarIntegrationError, toIntegrationError } from "./errors.ts";
import { markProviderUnreachable } from "./config.ts";
import { loadScript } from "./load-script.ts";
import {
  defaultFetch,
  defaultSyncRange,
  KeyedQueue,
  LESSON_TIME_ZONE,
  lessonDescription,
  lessonTitle,
  localMidnightIso,
  readJson,
  type FetchLike,
  type SyncRange,
} from "./shared.ts";

export const GOOGLE_GIS_SRC = "https://accounts.google.com/gsi/client";
export const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";
export const GOOGLE_EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
/** 앱이 만든 일정에 붙이는 비공개 확장 속성 키 */
export const LESSON_PROPERTY = "vcalLessonId";

const MAX_PAGES = 5;

/* ── API 응답 타입 (필요한 필드만) ───────────────────────────── */

export interface GoogleEventDateTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

export interface GoogleEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: GoogleEventDateTime;
  end?: GoogleEventDateTime;
  extendedProperties?: { private?: Record<string, string>; shared?: Record<string, string> };
}

interface GoogleEventList {
  items?: GoogleEvent[];
  nextPageToken?: string;
}

/* ── 순수 헬퍼 ─────────────────────────────────────────────── */

export function buildGoogleListUrl(range: SyncRange, pageToken?: string): string {
  const params = new URLSearchParams({
    timeMin: range.start.toISOString(),
    timeMax: range.end.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "250",
  });
  if (pageToken) params.set("pageToken", pageToken);
  return `${GOOGLE_EVENTS_URL}?${params}`;
}

/** 이 앱이 만든 레슨 일정을 찾는 URL (삭제된 일정은 제외됨) */
export function buildGoogleLessonLookupUrl(lessonId: string): string {
  const params = new URLSearchParams({
    privateExtendedProperty: `${LESSON_PROPERTY}=${lessonId}`,
    maxResults: "10",
  });
  return `${GOOGLE_EVENTS_URL}?${params}`;
}

export const googleEventUrl = (eventId: string) => `${GOOGLE_EVENTS_URL}/${encodeURIComponent(eventId)}`;

function toIso(dt: GoogleEventDateTime | undefined): string | undefined {
  if (!dt) return undefined;
  if (dt.dateTime) {
    const d = new Date(dt.dateTime);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  if (dt.date) return localMidnightIso(dt.date);
  return undefined;
}

/** 이 앱이 Push 한 레슨 일정인지 (통합 캘린더에 레슨이 두 번 보이지 않도록 제외) */
export const isAppLessonEvent = (e: GoogleEvent) => !!e.extendedProperties?.private?.[LESSON_PROPERTY];

/** 구글 일정 → ExternalEvent. 취소됨/시간 없음/앱이 만든 일정은 null */
export function mapGoogleEvent(e: GoogleEvent, userId: string): ExternalEvent | null {
  if (e.status === "cancelled" || isAppLessonEvent(e)) return null;
  const start = toIso(e.start);
  const end = toIso(e.end) ?? start;
  if (!start || !end) return null;
  return {
    id: `google-${e.id}`,
    provider: "GOOGLE",
    ownerId: userId,
    title: e.summary?.trim() || "(제목 없음)",
    start,
    end,
    ...(e.location ? { location: e.location } : {}),
  };
}

/** 레슨 → 구글 일정 본문 (insert/patch 공용) */
export function buildGoogleLessonEvent(lesson: LessonSlot) {
  return {
    summary: lessonTitle(lesson),
    description: lessonDescription(),
    start: { dateTime: new Date(lesson.start).toISOString(), timeZone: LESSON_TIME_ZONE },
    end: { dateTime: new Date(lesson.end).toISOString(), timeZone: LESSON_TIME_ZONE },
    extendedProperties: { private: { [LESSON_PROPERTY]: lesson.id } },
  };
}

/** 구글 API 오류 응답 → 한국어 메시지의 CalendarIntegrationError */
export function googleErrorFromResponse(status: number, body: unknown): CalendarIntegrationError {
  const err = (body as { error?: { message?: string; errors?: { reason?: string }[]; status?: string } })?.error;
  const reason = err?.errors?.[0]?.reason ?? err?.status ?? "";
  const detail = { status, detail: body };
  if (status === 401) {
    return new CalendarIntegrationError(
      "GOOGLE",
      "TOKEN_EXPIRED",
      "구글 로그인이 만료되었습니다. 구글 캘린더를 다시 연결해 주세요.",
      detail,
    );
  }
  if (status === 429 || /rateLimitExceeded|quotaExceeded|RESOURCE_EXHAUSTED/.test(reason)) {
    return new CalendarIntegrationError(
      "GOOGLE",
      "RATE_LIMITED",
      "구글 캘린더 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
      detail,
    );
  }
  if (status === 403) {
    const message = /accessNotConfigured|SERVICE_DISABLED/.test(reason)
      ? "구글 클라우드 프로젝트에서 Google Calendar API 가 사용 설정되지 않았습니다. (관리자 설정 필요)"
      : "구글 캘린더 접근 권한이 없습니다. 연결할 때 '캘린더 일정 보기 및 수정' 권한에 동의해 주세요.";
    return new CalendarIntegrationError("GOOGLE", "FORBIDDEN", message, detail);
  }
  return new CalendarIntegrationError(
    "GOOGLE",
    "API",
    `구글 캘린더 요청이 실패했습니다. (HTTP ${status}${err?.message ? `: ${err.message}` : ""})`,
    detail,
  );
}

/* ── REST 호출 (fetch 주입 → 단위 테스트 가능) ─────────────── */

export interface GoogleApiContext {
  fetch: FetchLike;
  accessToken: string;
}

export async function googleRequest<T>(
  ctx: GoogleApiContext,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  body?: unknown,
): Promise<T | undefined> {
  let res: Response;
  try {
    res = await ctx.fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${ctx.accessToken}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (e) {
    throw toIntegrationError("GOOGLE", e);
  }
  if (!res.ok) throw googleErrorFromResponse(res.status, await readJson(res));
  return (await readJson(res)) as T | undefined;
}

export async function listGoogleEvents(
  ctx: GoogleApiContext,
  userId: string,
  range: SyncRange,
): Promise<ExternalEvent[]> {
  const events: ExternalEvent[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await googleRequest<GoogleEventList>(ctx, "GET", buildGoogleListUrl(range, pageToken));
    for (const item of data?.items ?? []) {
      const mapped = mapGoogleEvent(item, userId);
      if (mapped) events.push(mapped);
    }
    pageToken = data?.nextPageToken;
    if (!pageToken) break;
  }
  return events;
}

export async function findGoogleLessonEventIds(ctx: GoogleApiContext, lessonId: string): Promise<string[]> {
  const data = await googleRequest<GoogleEventList>(ctx, "GET", buildGoogleLessonLookupUrl(lessonId));
  return (data?.items ?? [])
    .filter((e) => e.status !== "cancelled" && e.extendedProperties?.private?.[LESSON_PROPERTY] === lessonId)
    .map((e) => e.id);
}

async function deleteGoogleEvent(ctx: GoogleApiContext, eventId: string) {
  try {
    await googleRequest(ctx, "DELETE", googleEventUrl(eventId));
  } catch (e) {
    // 이미 지워진 일정(404/410)은 성공으로 본다
    if (e instanceof CalendarIntegrationError && (e.status === 404 || e.status === 410)) return;
    throw e;
  }
}

/**
 * 멱등 Push: vcalLessonId 로 기존 일정을 찾아 있으면 수정, 없으면 생성.
 * 같은 레슨으로 일정이 여러 개 생겨 있었다면 첫 번째만 남기고 정리한다. 구글 일정 id 반환.
 */
export async function upsertGoogleLessonEvent(ctx: GoogleApiContext, lesson: LessonSlot): Promise<string> {
  const body = buildGoogleLessonEvent(lesson);
  const [existing, ...duplicates] = await findGoogleLessonEventIds(ctx, lesson.id);
  for (const id of duplicates) await deleteGoogleEvent(ctx, id);
  if (existing) {
    const patched = await googleRequest<GoogleEvent>(ctx, "PATCH", googleEventUrl(existing), body);
    return patched?.id ?? existing;
  }
  const created = await googleRequest<GoogleEvent>(ctx, "POST", GOOGLE_EVENTS_URL, body);
  if (!created?.id) {
    throw new CalendarIntegrationError("GOOGLE", "API", "구글 캘린더에 레슨을 등록하지 못했습니다.", {
      detail: created,
    });
  }
  return created.id;
}

export async function deleteGoogleLessonEvents(ctx: GoogleApiContext, lessonId: string): Promise<void> {
  for (const id of await findGoogleLessonEventIds(ctx, lessonId)) await deleteGoogleEvent(ctx, id);
}

/* ── GIS 토큰 클라이언트 (브라우저 전용) ───────────────────── */

interface GisTokenResponse {
  access_token?: string;
  expires_in?: number | string;
  scope?: string;
  error?: string;
  error_description?: string;
}

interface GisTokenClient {
  requestAccessToken(overrides?: { prompt?: string }): void;
}

interface GisOAuth2 {
  initTokenClient(config: {
    client_id: string;
    scope: string;
    callback: (response: GisTokenResponse) => void;
    error_callback?: (error: { type?: string; message?: string }) => void;
  }): GisTokenClient;
  hasGrantedAllScopes(response: GisTokenResponse, ...scopes: string[]): boolean;
  revoke(token: string, done?: () => void): void;
}

const gisOAuth2 = (): GisOAuth2 | undefined =>
  (globalThis as { google?: { accounts?: { oauth2?: GisOAuth2 } } }).google?.accounts?.oauth2;

interface GoogleToken {
  accessToken: string;
  expiresAt: number;
}

export interface GoogleServiceOptions {
  clientId: string;
  fetchImpl?: FetchLike;
  now?: () => number;
  /** fetchEvents 시 연결되어 있지 않으면 connect() 를 시도 (Mock 과 같은 동작). 기본 true */
  autoConnect?: boolean;
  /** 테스트용: GIS 대신 쓸 객체 */
  loadOAuth2?: () => Promise<GisOAuth2>;
}

/** 만료 1분 전부터는 만료된 것으로 본다 */
const EXPIRY_MARGIN_MS = 60_000;

export class GoogleCalendarSyncService implements CalendarSyncService {
  readonly provider = "GOOGLE" as const;
  private readonly options: GoogleServiceOptions;
  private readonly tokens = new Map<string, GoogleToken>();
  private readonly queue = new KeyedQueue();
  private readonly pendingConnect = new Map<string, Promise<void>>();

  constructor(options: GoogleServiceOptions) {
    this.options = options;
  }

  private now() {
    return (this.options.now ?? Date.now)();
  }

  private get fetch() {
    return this.options.fetchImpl ?? defaultFetch;
  }

  /** GIS 스크립트를 미리 불러 둔다 (클릭 → 팝업 사이의 지연을 줄여 팝업 차단을 피함) */
  async preload(): Promise<void> {
    await this.loadOAuth2();
  }

  private async loadOAuth2(): Promise<GisOAuth2> {
    if (this.options.loadOAuth2) return this.options.loadOAuth2();
    const ready = gisOAuth2();
    if (ready) return ready;
    try {
      await loadScript(GOOGLE_GIS_SRC);
    } catch (e) {
      markProviderUnreachable("GOOGLE", "구글 로그인 스크립트를 불러오지 못해 가상 일정으로 동작 (새로고침 후 다시 시도)");
      throw new CalendarIntegrationError(
        "GOOGLE",
        "SCRIPT_LOAD_FAILED",
        "구글 로그인 스크립트를 불러오지 못했습니다. 광고 차단기나 네트워크를 확인해 주세요.",
        { detail: String(e) },
      );
    }
    const oauth2 = gisOAuth2();
    if (!oauth2) {
      throw new CalendarIntegrationError("GOOGLE", "SCRIPT_LOAD_FAILED", "구글 로그인 스크립트가 올바르지 않습니다.");
    }
    return oauth2;
  }

  async isConnected(userId: string): Promise<boolean> {
    const token = this.tokens.get(userId);
    if (!token) return false;
    if (token.expiresAt - EXPIRY_MARGIN_MS <= this.now()) {
      this.tokens.delete(userId);
      return false;
    }
    return true;
  }

  /** ⚠️ 팝업을 띄우므로 클릭 핸들러 안에서 호출해야 한다 */
  async connect(userId: string): Promise<void> {
    const pending = this.pendingConnect.get(userId);
    if (pending) return pending;
    const next = this.requestToken(userId).finally(() => this.pendingConnect.delete(userId));
    this.pendingConnect.set(userId, next);
    return next;
  }

  private async requestToken(userId: string): Promise<void> {
    const oauth2 = await this.loadOAuth2();
    const token = await new Promise<GoogleToken>((resolve, reject) => {
      const client = oauth2.initTokenClient({
        client_id: this.options.clientId,
        scope: GOOGLE_CALENDAR_SCOPE,
        callback: (response) => {
          if (response.error || !response.access_token) {
            reject(
              new CalendarIntegrationError(
                "GOOGLE",
                response.error === "access_denied" ? "CANCELLED" : "API",
                response.error === "access_denied"
                  ? "구글 캘린더 연결을 취소했습니다."
                  : "구글 로그인에 실패했습니다. 다시 시도해 주세요.",
                { detail: response },
              ),
            );
            return;
          }
          if (!oauth2.hasGrantedAllScopes(response, GOOGLE_CALENDAR_SCOPE)) {
            reject(
              new CalendarIntegrationError(
                "GOOGLE",
                "FORBIDDEN",
                "구글 캘린더 권한에 동의해야 일정을 불러오고 레슨을 등록할 수 있습니다.",
              ),
            );
            return;
          }
          resolve({
            accessToken: response.access_token,
            expiresAt: this.now() + Number(response.expires_in ?? 3599) * 1000,
          });
        },
        error_callback: (error) => {
          const blocked = error.type === "popup_failed_to_open";
          const closed = error.type === "popup_closed";
          reject(
            new CalendarIntegrationError(
              "GOOGLE",
              blocked ? "POPUP_BLOCKED" : closed ? "CANCELLED" : "API",
              blocked
                ? "브라우저가 구글 로그인 팝업을 막았습니다. 팝업을 허용하고 '연결' 버튼을 다시 눌러 주세요."
                : closed
                  ? "구글 로그인 창이 닫혀 연결이 취소되었습니다."
                  : "구글 로그인 중 오류가 발생했습니다.",
              { detail: error },
            ),
          );
        },
      });
      client.requestAccessToken();
    });
    this.tokens.set(userId, token);
  }

  async disconnect(userId: string): Promise<void> {
    const token = this.tokens.get(userId);
    this.tokens.delete(userId);
    if (!token) return;
    try {
      gisOAuth2()?.revoke(token.accessToken);
    } catch (e) {
      console.warn("[calendar-sync] 구글 토큰 해지 실패", e);
    }
  }

  /** 유효한 토큰으로 API 호출. 401 이면 토큰을 버려 isConnected 가 false 가 되게 한다 */
  private async withToken<T>(userId: string, interactive: boolean, run: (ctx: GoogleApiContext) => Promise<T>) {
    if (!(await this.isConnected(userId))) {
      if (interactive && this.options.autoConnect !== false) await this.connect(userId);
      else {
        throw new CalendarIntegrationError("GOOGLE", "NOT_CONNECTED", "구글 캘린더가 연결되어 있지 않습니다.");
      }
    }
    const token = this.tokens.get(userId);
    if (!token) throw new CalendarIntegrationError("GOOGLE", "NOT_CONNECTED", "구글 캘린더가 연결되어 있지 않습니다.");
    try {
      return await run({ fetch: this.fetch, accessToken: token.accessToken });
    } catch (e) {
      const error = toIntegrationError("GOOGLE", e);
      if (error.code === "TOKEN_EXPIRED") this.tokens.delete(userId);
      throw error;
    }
  }

  async fetchEvents(userId: string, range?: SyncRange): Promise<ExternalEvent[]> {
    const r = range ?? defaultSyncRange(new Date(this.now()));
    return this.withToken(userId, true, (ctx) => listGoogleEvents(ctx, userId, r));
  }

  /** 확정 레슨만 등록/수정. 확정이 아닌 슬롯이 오면 기존 일정을 지우고 "" 반환 */
  async pushLesson(userId: string, lesson: LessonSlot): Promise<string> {
    return this.queue.run(lesson.id, () =>
      this.withToken(userId, false, async (ctx) => {
        if (lesson.status !== "CONFIRMED") {
          await deleteGoogleLessonEvents(ctx, lesson.id);
          return "";
        }
        return upsertGoogleLessonEvent(ctx, lesson);
      }),
    );
  }

  async removeLesson(userId: string, lessonId: string): Promise<void> {
    return this.queue.run(lessonId, () =>
      this.withToken(userId, false, (ctx) => deleteGoogleLessonEvents(ctx, lessonId)),
    );
  }
}
