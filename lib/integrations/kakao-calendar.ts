/**
 * 카카오 톡캘린더 연동 (읽기 + 레슨 일정 생성/수정/삭제).
 *
 * ⚠️ 미검증: 이 파일을 작성한 환경에서는 developers.kakao.com / kapi.kakao.com 에 접속할 수 없어
 *    아래 엔드포인트·파라미터·응답 형식을 공식 문서로 직접 확인하지 못했다. (검색 결과 요약과 기존 지식 기반)
 *    실제 앱 키로 처음 연결할 때 브라우저 개발자 도구의 네트워크 탭에서 응답을 확인할 것.
 *
 * 인증 (카카오 로그인, JS SDK v2):
 *   1) connect(): SDK 로드 → Kakao.init(JS 키) → Kakao.Auth.authorize({ redirectUri, scope: "talk_calendar", state })
 *      → 페이지가 카카오 로그인으로 **이동**한다 (connect 의 Promise 는 끝나지 않는다).
 *   2) 카카오가 redirectUri?code=...&state=... 로 돌려보내면, 페이지 로드시 completeKakaoLogin() 호출
 *      → Supabase Edge Function(kakao-oauth)이 REST API 키로 POST https://kauth.kakao.com/oauth/token 교환
 *      → 액세스 토큰을 sessionStorage 에 만료 시각과 함께 저장 (탭을 닫으면 사라짐, 리프레시 토큰은 저장하지 않음).
 *
 * 톡캘린더 REST API (미검증):
 *   - 목록  GET    https://kapi.kakao.com/v2/api/calendar/events?from&to  (UTC, 조회 기간 최대 31일로 알려짐 → 31일 단위로 나눠 조회)
 *           응답 { events: [{ id, title, type, calendar_id, time: { start_at, end_at, time_zone, all_day, lunar }, location? }],
 *                 has_next_events?, after_url? }
 *   - 생성  POST   https://kapi.kakao.com/v2/api/calendar/create/event        (form: event=<JSON>)  응답 { event_id }
 *   - 수정  POST   https://kapi.kakao.com/v2/api/calendar/update/event/host   (form: event_id, event=<JSON>)
 *   - 삭제  DELETE https://kapi.kakao.com/v2/api/calendar/delete/event?event_id=
 *   - 시작/종료 시각은 5분 단위여야 한다 (개발자 포럼 답변 기준).
 *   - 일정 생성/수정/삭제 권한은 카카오의 '톡캘린더 API' 사용 신청(비즈 앱 검수)을 통과해야 쓸 수 있다.
 *
 * 카카오 일정에는 구글의 extendedProperties 같은 비공개 속성이 없어서,
 *   (a) 레슨 id → 카카오 event_id 매핑을 localStorage 에 저장하고
 *   (b) 설명(description) 끝에 "[vcal:<레슨 id>]" 표식을 붙여
 * 멱등 Push 와 '앱이 만든 일정 제외'를 처리한다.
 */
import type { ExternalEvent, LessonSlot } from "../../types/calendar";
import type { CalendarSyncService } from "../services/calendar-sync";
import { CalendarIntegrationError, toIntegrationError } from "./errors.ts";
import { integrationConfig, kakaoTokenExchangeUrl, markProviderUnreachable, type IntegrationConfig } from "./config.ts";
import { loadScript } from "./load-script.ts";
import {
  browserStorage,
  defaultFetch,
  defaultSyncRange,
  KeyedQueue,
  LESSON_TIME_ZONE,
  lessonDescription,
  lessonTitle,
  localMidnightIso,
  readJson,
  type FetchLike,
  type StorageLike,
  type SyncRange,
} from "./shared.ts";

/** 카카오 JS SDK v2 (미검증: 최신 버전/무결성 해시를 확인하지 못해 integrity 속성은 넣지 않음) */
export const KAKAO_SDK_SRC = "https://t1.kakaocdn.net/kakao_js_sdk/2.7.4/kakao.min.js";
/** 톡캘린더 동의 항목 ID (미검증) */
export const KAKAO_CALENDAR_SCOPE = "talk_calendar";
export const KAKAO_API = "https://kapi.kakao.com";
export const KAKAO_EVENTS_URL = `${KAKAO_API}/v2/api/calendar/events`;
export const KAKAO_CREATE_URL = `${KAKAO_API}/v2/api/calendar/create/event`;
export const KAKAO_UPDATE_URL = `${KAKAO_API}/v2/api/calendar/update/event/host`;
export const KAKAO_DELETE_URL = `${KAKAO_API}/v2/api/calendar/delete/event`;
export const KAKAO_LOGOUT_URL = `${KAKAO_API}/v1/user/logout`;

/** 목록 조회 1회의 최대 기간 (미검증: 31일로 알려짐) */
const MAX_RANGE_DAYS = 31;
const DAY = 24 * 60 * 60 * 1000;
const FIVE_MIN = 5 * 60 * 1000;
const MAX_PAGES_PER_CHUNK = 10;

export const KAKAO_TOKEN_KEY = (userId: string) => `vcal.kakao.token.${userId}`;
export const KAKAO_OAUTH_STATE_KEY = "vcal.kakao.oauth";
export const KAKAO_PUSHED_KEY = (userId: string) => `vcal.kakao.pushed.${userId}`;
const marker = (lessonId: string) => `[vcal:${lessonId}]`;
const MARKER_RE = /\[vcal:[^\]]+\]/;

/* ── API 타입 (미검증) ─────────────────────────────────────── */

export interface KakaoEventTime {
  start_at?: string;
  end_at?: string;
  time_zone?: string;
  all_day?: boolean;
  lunar?: boolean;
}

export interface KakaoEvent {
  id: string;
  title?: string;
  type?: string;
  calendar_id?: string;
  time?: KakaoEventTime;
  description?: string;
  location?: { name?: string; address?: string };
}

interface KakaoEventList {
  events?: KakaoEvent[];
  has_next_events?: boolean;
  after_url?: string;
}

/* ── 순수 헬퍼 ─────────────────────────────────────────────── */

/** 카카오 시각 형식: UTC, 밀리초 없음, 5분 단위로 내림/올림 (예: 2026-11-12T03:05:00Z) */
export function kakaoTime(date: Date, round: "floor" | "ceil" = "floor"): string {
  const t = date.getTime();
  const rounded = round === "floor" ? Math.floor(t / FIVE_MIN) * FIVE_MIN : Math.ceil(t / FIVE_MIN) * FIVE_MIN;
  return new Date(rounded).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** 조회 범위를 31일 이하 구간으로 나눠 목록 URL 들을 만든다 */
export function buildKakaoListUrls(range: SyncRange): string[] {
  const urls: string[] = [];
  let from = range.start.getTime();
  const end = range.end.getTime();
  while (from < end) {
    const to = Math.min(from + MAX_RANGE_DAYS * DAY, end);
    const params = new URLSearchParams({
      from: kakaoTime(new Date(from), "floor"),
      to: kakaoTime(new Date(to), "ceil"),
    });
    urls.push(`${KAKAO_EVENTS_URL}?${params}`);
    from = to;
  }
  return urls;
}

const utcDate = (iso: string) => iso.slice(0, 10);

/** 카카오 일정 → ExternalEvent. 시간 없음/앱이 만든 일정은 null */
export function mapKakaoEvent(
  e: KakaoEvent,
  userId: string,
  ownEventIds: ReadonlySet<string> = new Set(),
): ExternalEvent | null {
  if (ownEventIds.has(e.id) || (e.description && MARKER_RE.test(e.description))) return null;
  const startAt = e.time?.start_at;
  if (!startAt || Number.isNaN(new Date(startAt).getTime())) return null;
  const endAt = e.time?.end_at && !Number.isNaN(new Date(e.time.end_at).getTime()) ? e.time.end_at : startAt;

  let start: string;
  let end: string;
  if (e.time?.all_day) {
    // 종일 일정은 날짜만 의미가 있다 (미검증: start_at 이 해당 날짜의 00:00:00Z 로 온다고 가정)
    start = localMidnightIso(utcDate(startAt));
    end = localMidnightIso(utcDate(endAt));
    if (end <= start) end = new Date(new Date(start).getTime() + DAY).toISOString();
  } else {
    start = new Date(startAt).toISOString();
    end = new Date(endAt).toISOString();
  }
  const location = e.location?.name || e.location?.address;
  return {
    id: `kakao-${e.id}`,
    provider: "KAKAO",
    ownerId: userId,
    title: e.title?.trim() || "(제목 없음)",
    start,
    end,
    ...(location ? { location } : {}),
  };
}

/** 레슨 → 카카오 일정 JSON (create/update 의 event 파라미터) */
export function buildKakaoLessonEvent(lesson: LessonSlot) {
  const start = new Date(lesson.start);
  let end = new Date(lesson.end);
  if (end.getTime() <= start.getTime()) end = new Date(start.getTime() + FIVE_MIN);
  return {
    title: lessonTitle(lesson),
    time: {
      start_at: kakaoTime(start, "floor"),
      end_at: kakaoTime(end, "ceil"),
      time_zone: LESSON_TIME_ZONE,
      all_day: false,
      lunar: false,
    },
    description: `${lessonDescription()}\n${marker(lesson.id)}`,
  };
}

export function buildKakaoCreateBody(lesson: LessonSlot): URLSearchParams {
  return new URLSearchParams({ event: JSON.stringify(buildKakaoLessonEvent(lesson)) });
}

export function buildKakaoUpdateBody(eventId: string, lesson: LessonSlot): URLSearchParams {
  return new URLSearchParams({ event_id: eventId, event: JSON.stringify(buildKakaoLessonEvent(lesson)) });
}

/** 카카오 API 오류 → 한국어 메시지 (카카오 오류 코드: -401 토큰, -402 동의 부족, -3 권한 없음, -10 한도 초과) */
export function kakaoErrorFromResponse(status: number, body: unknown): CalendarIntegrationError {
  const b = body as { code?: number; msg?: string } | undefined;
  const code = b?.code;
  const detail = { status, detail: body };
  if (status === 401 || code === -401) {
    return new CalendarIntegrationError(
      "KAKAO",
      "TOKEN_EXPIRED",
      "카카오 로그인이 만료되었습니다. 카카오 캘린더를 다시 연결해 주세요.",
      detail,
    );
  }
  if (status === 429 || code === -10) {
    return new CalendarIntegrationError(
      "KAKAO",
      "RATE_LIMITED",
      "카카오 캘린더 요청 한도를 넘었습니다. 잠시 후 다시 시도해 주세요.",
      detail,
    );
  }
  if (status === 403 || code === -402 || code === -3) {
    const message =
      code === -402
        ? "카카오 톡캘린더 접근에 동의하지 않았습니다. 카카오 캘린더를 다시 연결하고 '톡캘린더' 항목에 동의해 주세요."
        : "이 앱은 아직 카카오 톡캘린더 API 사용 권한이 없습니다. (카카오 디벨로퍼스에서 사용 신청/검수 필요)";
    return new CalendarIntegrationError("KAKAO", "FORBIDDEN", message, detail);
  }
  return new CalendarIntegrationError(
    "KAKAO",
    "API",
    `카카오 캘린더 요청이 실패했습니다. (HTTP ${status}${b?.msg ? `: ${b.msg}` : ""})`,
    detail,
  );
}

/* ── REST 호출 ────────────────────────────────────────────── */

export interface KakaoApiContext {
  fetch: FetchLike;
  accessToken: string;
}

export async function kakaoRequest<T>(
  ctx: KakaoApiContext,
  method: "GET" | "POST" | "DELETE",
  url: string,
  form?: URLSearchParams,
): Promise<T | undefined> {
  let res: Response;
  try {
    res = await ctx.fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${ctx.accessToken}`,
        ...(form ? { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" } : {}),
      },
      ...(form ? { body: form.toString() } : {}),
    });
  } catch (e) {
    throw toIntegrationError("KAKAO", e);
  }
  if (!res.ok) throw kakaoErrorFromResponse(res.status, await readJson(res));
  return (await readJson(res)) as T | undefined;
}

/** 다음 페이지 주소 (상대 경로 허용). 토큰이 다른 호스트로 새지 않도록 kapi.kakao.com 만 따른다 */
export function nextPageUrl(afterUrl: string | undefined): string | undefined {
  if (!afterUrl) return undefined;
  try {
    const url = new URL(afterUrl, KAKAO_API);
    return url.origin === KAKAO_API ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export async function listKakaoEvents(
  ctx: KakaoApiContext,
  userId: string,
  range: SyncRange,
  ownEventIds: ReadonlySet<string> = new Set(),
): Promise<ExternalEvent[]> {
  const events: ExternalEvent[] = [];
  const seen = new Set<string>();
  const ids = new Set<string>();
  for (const first of buildKakaoListUrls(range)) {
    let url: string | undefined = first;
    for (let page = 0; url && page < MAX_PAGES_PER_CHUNK; page++) {
      const data: KakaoEventList | undefined = await kakaoRequest<KakaoEventList>(ctx, "GET", url);
      for (const e of data?.events ?? []) {
        const mapped = mapKakaoEvent(e, userId, ownEventIds);
        if (!mapped) continue;
        // 구간 경계에 걸친 일정은 두 번 올 수 있으므로 제거하고,
        // 반복 일정처럼 같은 id 가 다른 시각으로 여러 번 오면 시작 시각을 붙여 id 를 구분한다
        const key = `${mapped.id}@${mapped.start}`;
        if (seen.has(key)) continue;
        seen.add(key);
        events.push(ids.has(mapped.id) ? { ...mapped, id: `${mapped.id}-${mapped.start}` } : mapped);
        ids.add(mapped.id);
      }
      url = data?.has_next_events === false ? undefined : nextPageUrl(data?.after_url);
    }
  }
  return events.sort((a, b) => a.start.localeCompare(b.start));
}

/** 레슨 id → 카카오 event_id 매핑 (localStorage, 사용자별) */
export class KakaoPushedMap {
  private readonly storage: StorageLike;
  private readonly userId: string;

  constructor(storage: StorageLike, userId: string) {
    this.storage = storage;
    this.userId = userId;
  }

  private read(): Record<string, string> {
    try {
      const raw = this.storage.getItem(KAKAO_PUSHED_KEY(this.userId));
      const parsed = raw ? (JSON.parse(raw) as unknown) : {};
      return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
    } catch {
      return {};
    }
  }

  private write(map: Record<string, string>) {
    try {
      this.storage.setItem(KAKAO_PUSHED_KEY(this.userId), JSON.stringify(map));
    } catch {
      /* 저장 실패는 무시 (다음 Push 때 새로 생성될 수 있음) */
    }
  }

  get(lessonId: string): string | undefined {
    return this.read()[lessonId];
  }

  set(lessonId: string, eventId: string) {
    this.write({ ...this.read(), [lessonId]: eventId });
  }

  delete(lessonId: string) {
    const map = this.read();
    delete map[lessonId];
    this.write(map);
  }

  eventIds(): Set<string> {
    return new Set(Object.values(this.read()));
  }
}

const isMissingEvent = (e: unknown) =>
  e instanceof CalendarIntegrationError && (e.status === 400 || e.status === 404);

/** 멱등 Push: 매핑이 있으면 수정, 없거나 원본이 지워졌으면 새로 생성. 카카오 event_id 반환 */
export async function upsertKakaoLessonEvent(
  ctx: KakaoApiContext,
  pushed: KakaoPushedMap,
  lesson: LessonSlot,
): Promise<string> {
  const existing = pushed.get(lesson.id);
  if (existing) {
    try {
      const updated = await kakaoRequest<{ event_id?: string }>(
        ctx,
        "POST",
        KAKAO_UPDATE_URL,
        buildKakaoUpdateBody(existing, lesson),
      );
      const id = updated?.event_id || existing;
      pushed.set(lesson.id, id);
      return id;
    } catch (e) {
      // 사용자가 카카오 앱에서 일정을 지운 경우 등 → 새로 만든다
      if (!isMissingEvent(e)) throw e;
      pushed.delete(lesson.id);
    }
  }
  const created = await kakaoRequest<{ event_id?: string }>(ctx, "POST", KAKAO_CREATE_URL, buildKakaoCreateBody(lesson));
  if (!created?.event_id) {
    throw new CalendarIntegrationError("KAKAO", "API", "카카오 캘린더에 레슨을 등록하지 못했습니다.", {
      detail: created,
    });
  }
  pushed.set(lesson.id, created.event_id);
  return created.event_id;
}

export async function deleteKakaoLessonEvent(
  ctx: KakaoApiContext,
  pushed: KakaoPushedMap,
  lessonId: string,
): Promise<void> {
  const eventId = pushed.get(lessonId);
  if (!eventId) return;
  try {
    await kakaoRequest(ctx, "DELETE", `${KAKAO_DELETE_URL}?${new URLSearchParams({ event_id: eventId })}`);
  } catch (e) {
    if (!isMissingEvent(e)) throw e;
  }
  pushed.delete(lessonId);
}

/* ── 토큰 저장 ────────────────────────────────────────────── */

interface StoredKakaoToken {
  accessToken: string;
  expiresAt: number;
}

export function readKakaoToken(storage: StorageLike, userId: string, now: number): StoredKakaoToken | null {
  try {
    const raw = storage.getItem(KAKAO_TOKEN_KEY(userId));
    if (!raw) return null;
    const t = JSON.parse(raw) as StoredKakaoToken;
    if (!t?.accessToken || typeof t.expiresAt !== "number") return null;
    if (t.expiresAt - 60_000 <= now) {
      storage.removeItem(KAKAO_TOKEN_KEY(userId));
      return null;
    }
    return t;
  } catch {
    return null;
  }
}

/* ── 로그인 완료 처리 (리다이렉트 후 페이지 로드 시) ───────── */

export type KakaoLoginResult =
  /** URL 에 카카오 응답이 없음 (평소 페이지 로드) */
  | { status: "none" }
  /** 연결 완료 → UI 는 syncCalendar("KAKAO") 를 호출하면 된다 */
  | { status: "connected"; userId: string }
  | { status: "error"; error: CalendarIntegrationError };

export interface CompleteKakaoLoginOptions {
  fetchImpl?: FetchLike;
  /** 토큰/state 저장소 (기본 sessionStorage) */
  storage?: StorageLike;
  config?: IntegrationConfig;
  now?: () => number;
  /** 처리 후 주소창에서 code/state 를 지운다 (기본 true, 브라우저에서만) */
  cleanUrl?: boolean;
}

const OAUTH_PARAMS = ["code", "state", "error", "error_description"];

function cleanBrowserUrl(url: URL) {
  if (typeof window === "undefined" || typeof history === "undefined") return;
  try {
    const clean = new URL(url.href);
    for (const p of OAUTH_PARAMS) clean.searchParams.delete(p);
    if (clean.href !== window.location.href) history.replaceState(history.state, "", clean.href);
  } catch {
    /* 무시 */
  }
}

/**
 * 카카오 로그인 리다이렉트로 돌아온 페이지에서 한 번 호출한다. 절대 throw 하지 않는다.
 * `?code=` 가 있으면 kakao-oauth 함수로 토큰을 교환해 sessionStorage 에 저장한다.
 */
export async function completeKakaoLogin(
  href: string = typeof window !== "undefined" ? window.location.href : "",
  options: CompleteKakaoLoginOptions = {},
): Promise<KakaoLoginResult> {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return { status: "none" };
  }
  const code = url.searchParams.get("code");
  const oauthError = url.searchParams.get("error");
  if (!code && !oauthError) return { status: "none" };

  const storage = options.storage ?? browserStorage("session");
  const config = options.config ?? integrationConfig;
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const fail = (code: ConstructorParameters<typeof CalendarIntegrationError>[1], message: string, detail?: unknown) =>
    ({ status: "error", error: new CalendarIntegrationError("KAKAO", code, message, { detail }) }) as const;

  // 우리가 시작한 로그인인지 확인 (CSRF 방지)
  let pending: { nonce?: string; userId?: string; createdAt?: number } = {};
  try {
    pending = JSON.parse(storage.getItem(KAKAO_OAUTH_STATE_KEY) ?? "{}");
  } catch {
    /* 무시 */
  }
  const state = url.searchParams.get("state");
  if (!pending.nonce || !pending.userId || pending.nonce !== state) {
    // 다른 앱/오래된 링크의 code 일 수 있다 → 우리 것이 아니면 건드리지 않음
    return { status: "none" };
  }
  storage.removeItem(KAKAO_OAUTH_STATE_KEY);
  if (options.cleanUrl !== false) cleanBrowserUrl(url);

  if (oauthError) {
    return oauthError === "access_denied"
      ? fail("CANCELLED", "카카오 캘린더 연결을 취소했습니다.", oauthError)
      : fail("API", "카카오 로그인에 실패했습니다.", { oauthError, description: url.searchParams.get("error_description") });
  }

  const exchangeUrl = kakaoTokenExchangeUrl(config);
  if (!exchangeUrl || !config.kakaoRedirectUri) {
    return fail("NOT_CONFIGURED", "카카오 연동 설정(Supabase 주소/Redirect URI)이 없습니다.");
  }
  let res: Response;
  try {
    res = await fetchImpl(exchangeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.supabaseAnonKey
          ? { apikey: config.supabaseAnonKey, Authorization: `Bearer ${config.supabaseAnonKey}` }
          : {}),
      },
      body: JSON.stringify({ code, redirectUri: config.kakaoRedirectUri }),
    });
  } catch (e) {
    return { status: "error", error: toIntegrationError("KAKAO", e) };
  }
  const body = (await readJson(res)) as
    | { access_token?: string; expires_in?: number; error?: string; error_description?: string }
    | undefined;
  if (!res.ok || !body?.access_token) {
    return fail("API", "카카오 로그인 토큰을 받지 못했습니다. 잠시 후 다시 연결해 주세요.", { status: res.status, body });
  }
  const token: StoredKakaoToken = {
    accessToken: body.access_token,
    expiresAt: now() + Number(body.expires_in ?? 21599) * 1000,
  };
  try {
    storage.setItem(KAKAO_TOKEN_KEY(pending.userId), JSON.stringify(token));
  } catch (e) {
    return fail("API", "브라우저 저장소에 로그인 정보를 저장하지 못했습니다.", String(e));
  }
  return { status: "connected", userId: pending.userId };
}

/* ── 서비스 ───────────────────────────────────────────────── */

interface KakaoSdk {
  init(appKey: string): void;
  isInitialized(): boolean;
  Auth: {
    authorize(settings: { redirectUri: string; scope?: string; state?: string; prompt?: string }): void;
  };
}

const kakaoSdk = (): KakaoSdk | undefined => (globalThis as { Kakao?: KakaoSdk }).Kakao;

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface KakaoServiceOptions {
  config?: IntegrationConfig;
  fetchImpl?: FetchLike;
  /** 토큰/state 저장소 (기본 sessionStorage) */
  sessionStorage?: StorageLike;
  /** Push 매핑 저장소 (기본 localStorage) */
  localStorage?: StorageLike;
  now?: () => number;
  /** fetchEvents 시 연결되어 있지 않으면 카카오 로그인으로 이동. 기본 true */
  autoConnect?: boolean;
  /** 테스트용: SDK 대신 쓸 객체 */
  loadSdk?: () => Promise<KakaoSdk>;
}

export class KakaoCalendarSyncService implements CalendarSyncService {
  readonly provider = "KAKAO" as const;
  private readonly options: KakaoServiceOptions;
  private readonly queue = new KeyedQueue();
  private session: StorageLike | null = null;
  private local: StorageLike | null = null;

  constructor(options: KakaoServiceOptions = {}) {
    this.options = options;
  }

  private get config() {
    return this.options.config ?? integrationConfig;
  }
  private get fetch() {
    return this.options.fetchImpl ?? defaultFetch;
  }
  private now() {
    return (this.options.now ?? Date.now)();
  }
  private get sessionStore(): StorageLike {
    return (this.session ??= this.options.sessionStorage ?? browserStorage("session"));
  }
  private get localStore(): StorageLike {
    return (this.local ??= this.options.localStorage ?? browserStorage("local"));
  }
  private pushedMap(userId: string) {
    return new KakaoPushedMap(this.localStore, userId);
  }

  async preload(): Promise<void> {
    await this.loadSdk();
  }

  private async loadSdk(): Promise<KakaoSdk> {
    if (this.options.loadSdk) return this.options.loadSdk();
    if (!kakaoSdk()) {
      try {
        await loadScript(KAKAO_SDK_SRC);
      } catch (e) {
        markProviderUnreachable("KAKAO", "카카오 SDK 를 불러오지 못해 가상 일정으로 동작 (새로고침 후 다시 시도)");
        throw new CalendarIntegrationError(
          "KAKAO",
          "SCRIPT_LOAD_FAILED",
          "카카오 로그인 스크립트를 불러오지 못했습니다. 광고 차단기나 네트워크를 확인해 주세요.",
          { detail: String(e) },
        );
      }
    }
    const sdk = kakaoSdk();
    if (!sdk) throw new CalendarIntegrationError("KAKAO", "SCRIPT_LOAD_FAILED", "카카오 SDK 가 올바르지 않습니다.");
    if (!sdk.isInitialized()) sdk.init(this.config.kakaoJsKey);
    return sdk;
  }

  async isConnected(userId: string): Promise<boolean> {
    return !!readKakaoToken(this.sessionStore, userId, this.now());
  }

  /**
   * 카카오 로그인 페이지로 이동한다 (클릭 핸들러에서 호출 권장).
   * 이동에 성공하면 이 Promise 는 끝나지 않는다. 돌아온 뒤 completeKakaoLogin() 이 연결을 마무리한다.
   */
  async connect(userId: string): Promise<void> {
    const sdk = await this.loadSdk();
    const nonce = randomNonce();
    this.sessionStore.setItem(KAKAO_OAUTH_STATE_KEY, JSON.stringify({ nonce, userId, createdAt: this.now() }));
    sdk.Auth.authorize({ redirectUri: this.config.kakaoRedirectUri, scope: KAKAO_CALENDAR_SCOPE, state: nonce });
    await new Promise<void>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new CalendarIntegrationError("KAKAO", "API", "카카오 로그인 페이지로 이동하지 못했습니다. 다시 시도해 주세요."),
          ),
        15_000,
      ),
    );
  }

  async disconnect(userId: string): Promise<void> {
    const token = readKakaoToken(this.sessionStore, userId, this.now());
    this.sessionStore.removeItem(KAKAO_TOKEN_KEY(userId));
    if (!token) return;
    // 토큰 만료 처리 (연결 끊기(unlink)는 동의 철회까지 되므로 하지 않는다)
    try {
      await kakaoRequest({ fetch: this.fetch, accessToken: token.accessToken }, "POST", KAKAO_LOGOUT_URL);
    } catch (e) {
      console.warn("[calendar-sync] 카카오 로그아웃 실패", e);
    }
  }

  private async withToken<T>(userId: string, interactive: boolean, run: (ctx: KakaoApiContext) => Promise<T>) {
    let token = readKakaoToken(this.sessionStore, userId, this.now());
    if (!token && interactive && this.options.autoConnect !== false) {
      await this.connect(userId);
      token = readKakaoToken(this.sessionStore, userId, this.now());
    }
    if (!token) throw new CalendarIntegrationError("KAKAO", "NOT_CONNECTED", "카카오 캘린더가 연결되어 있지 않습니다.");
    try {
      return await run({ fetch: this.fetch, accessToken: token.accessToken });
    } catch (e) {
      const error = toIntegrationError("KAKAO", e);
      if (error.code === "TOKEN_EXPIRED") this.sessionStore.removeItem(KAKAO_TOKEN_KEY(userId));
      throw error;
    }
  }

  async fetchEvents(userId: string, range?: SyncRange): Promise<ExternalEvent[]> {
    const r = range ?? defaultSyncRange(new Date(this.now()));
    return this.withToken(userId, true, (ctx) =>
      listKakaoEvents(ctx, userId, r, this.pushedMap(userId).eventIds()),
    );
  }

  /** 확정 레슨만 등록/수정. 확정이 아닌 슬롯이 오면 기존 일정을 지우고 "" 반환 */
  async pushLesson(userId: string, lesson: LessonSlot): Promise<string> {
    return this.queue.run(lesson.id, () =>
      this.withToken(userId, false, async (ctx) => {
        const pushed = this.pushedMap(userId);
        if (lesson.status !== "CONFIRMED") {
          await deleteKakaoLessonEvent(ctx, pushed, lesson.id);
          return "";
        }
        return upsertKakaoLessonEvent(ctx, pushed, lesson);
      }),
    );
  }

  async removeLesson(userId: string, lessonId: string): Promise<void> {
    return this.queue.run(lessonId, () =>
      this.withToken(userId, false, (ctx) => deleteKakaoLessonEvent(ctx, this.pushedMap(userId), lessonId)),
    );
  }
}
