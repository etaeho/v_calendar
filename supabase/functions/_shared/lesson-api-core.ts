// AUTO-GENERATED from lib/server/lesson-api-core.ts by scripts/sync-supabase-shared.mjs — DO NOT EDIT.
// 원본을 고친 뒤 `npm run supabase:shared` 로 다시 만드세요.
/**
 * lesson-api 의 핵심 처리 (순수 TypeScript — Node 테스트와 Deno Edge Function 양쪽에서 같은 코드).
 *
 * - 스튜디오 하나의 LessonState 전체를 JSONB 문서 하나 + 버전 번호로 저장한다.
 * - 모든 규칙은 기존 도메인 코드(lesson-machine / enrollment / commands)를 그대로 실행한다.
 * - 저장은 낙관적 잠금(CAS): 읽은 버전이 그대로일 때만 저장, 아니면 다시 읽어 재실행 (최대 3회).
 * - 클라이언트가 보낸 행위자 id 는 절대 믿지 않는다. 행위자 = 로그인 사용자의 members 행.
 *
 * Deno 쪽 복사본은 scripts/sync-supabase-shared.mjs 가 supabase/functions/_shared/ 로 만든다.
 */
import type { Actor, LessonState, UserRole, WeeklyTime } from "./calendar.ts";
import { runCommand, type Command, type CommandResult } from "./commands.ts";
import { markHolidays, type HolidayLookup } from "./enrollment.ts";
import { LessonError, settle, type MachineContext } from "./lesson-machine.ts";
import { deriveNotifications, type AppNotification } from "./notifications.ts";
import { visibleState } from "./visibility.ts";
import { holidayLookup } from "./holidays.ts";

/* ------------------------------------------------------------------ */
/* 저장소 인터페이스                                                    */
/* ------------------------------------------------------------------ */

export interface MemberRecord {
  id: string;
  studioId: string;
  /** auth.users.id. 초대만 되고 아직 로그인하지 않았으면 null */
  userId: string | null;
  email: string;
  role: UserRole;
  name: string;
  /** LessonState 안에서 쓰는 id (강사 t-xxxxxxxx, 레슨생 s-xxxxxxxx) */
  appKey: string;
  phone: string | null;
  kakaoOptIn: boolean;
  createdAt: string;
}

export interface StudioRecord {
  id: string;
  name: string;
}

export interface NewMember {
  studioId: string;
  userId: string | null;
  email: string;
  role: UserRole;
  name: string;
  appKey: string;
  phone: string | null;
}

export type InsertMemberResult =
  | { ok: true; member: MemberRecord }
  | { ok: false; reason: "EMAIL_TAKEN" | "APP_KEY_TAKEN" };

export interface Store {
  getMemberByUserId(userId: string): Promise<MemberRecord | null>;
  /** 아직 계정과 연결되지 않은(user_id 가 null 인) 멤버 중 이메일이 같은 행 (대소문자 무시) */
  getMemberByEmail(email: string): Promise<MemberRecord | null>;
  /** user_id 가 아직 null 일 때만 연결한다. 연결했으면 true */
  linkUser(memberId: string, userId: string): Promise<boolean>;
  getStudio(studioId: string): Promise<StudioRecord | null>;
  /** 스튜디오 + 강사 멤버 + 빈 상태(version 0)를 한 트랜잭션으로 만든다. app_key 충돌이면 null */
  createStudio(input: {
    name: string;
    instructor: Omit<NewMember, "studioId" | "role">;
    state: LessonState;
  }): Promise<{ studio: StudioRecord; member: MemberRecord } | null>;
  listMembers(studioId: string): Promise<MemberRecord[]>;
  insertMember(input: NewMember): Promise<InsertMemberResult>;
  updateMember(memberId: string, patch: { phone?: string | null; kakaoOptIn?: boolean }): Promise<void>;
  getState(studioId: string): Promise<{ state: LessonState; version: number } | null>;
  /**
   * 한 트랜잭션으로: version 이 expectedVersion 일 때만 상태 저장(version+1) →
   * studio_events 행 추가 → 알림 추가. 새 버전을 돌려주고, 버전이 달라 저장하지 못했으면 null.
   * (casState + insertEvent + insertNotifications 를 원자적으로 묶은 것)
   */
  commit(
    studioId: string,
    expectedVersion: number,
    state: LessonState,
    notifications: AppNotification[],
  ): Promise<number | null>;
  /** 받는 사람의 알림 최신순 limit 개 */
  listNotifications(studioId: string, recipientAppKey: string, limit: number): Promise<AppNotification[]>;
  /** 받는 사람 본인의 알림만 읽음 처리. 바뀐 개수 */
  markRead(studioId: string, recipientAppKey: string, ids: string[], at: string): Promise<number>;
}

/* ------------------------------------------------------------------ */
/* 요청 / 응답                                                         */
/* ------------------------------------------------------------------ */

export interface AuthUser {
  /** auth.users.id */
  userId: string;
  email: string | null;
}

export interface ApiResponse {
  status: number;
  json: unknown;
}

export interface HandleOptions {
  holiday?: HolidayLookup;
  /** 새 id 생성 (기본: `${prefix}-${crypto.randomUUID()}`) */
  newId?: (prefix: string) => string;
  /** 시간대 검사용 (테스트 주입). 기본: new Date(2026,0,1).getTimezoneOffset() */
  timezoneOffset?: () => number;
}

export type ApiErrorCode =
  | LessonError["code"]
  | "UNAUTHENTICATED"
  | "NOT_MEMBER"
  | "CONFLICT"
  | "BAD_REQUEST"
  | "SERVER_TZ"
  | "INTERNAL";

class ApiError extends Error {
  status: number;
  code: ApiErrorCode;
  constructor(status: number, code: ApiErrorCode, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const fail = (status: number, code: ApiErrorCode, message: string): ApiResponse => ({
  status,
  json: { ok: false, error: { code, message } },
});

const LESSON_ERROR_STATUS: Record<LessonError["code"], number> = {
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  INVALID_STATE: 409,
  OVERLAP: 409,
  INVALID_RANGE: 400,
};

export const SEOUL_OFFSET_MINUTES = -540;
export const MAX_COMMIT_ATTEMPTS = 3;
export const NOTIFICATION_LIMIT = 50;

export const emptyState = (): LessonState => ({
  enrollments: [],
  makeupAdjustments: [],
  slots: [],
  requests: [],
  comments: [],
});

const defaultId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
const appKeyFor = (role: UserRole) =>
  `${role === "INSTRUCTOR" ? "t" : "s"}-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;

/** 시간 경과로 생기는 변화(공휴일 표시, 만료, 결정 없이 지난 공휴일)를 반영 */
const settleAll = (state: LessonState, holiday: HolidayLookup, ctx: MachineContext) =>
  settle(markHolidays(state, holiday, ctx.now()), ctx);

/** 시간 경과로 생긴 변화(만료 등)의 알림을 만들 때 쓰는 가상의 행위자 */
const SYSTEM_ACTOR: Actor = { userId: "system", role: "INSTRUCTOR" };

/* ------------------------------------------------------------------ */
/* 입력 검증                                                           */
/* ------------------------------------------------------------------ */

type FieldKind =
  | "id" // 비어 있지 않은 짧은 문자열
  | "text" // 메시지 등 (선택)
  | "requiredText"
  | "iso" // ISO 시각
  | "date" // yyyy-MM-dd
  | "num"
  | "optNum"
  | "proposal"
  | "times"
  | "weeks";
type FieldSpec = FieldKind | { [key: string]: FieldSpec };

const MAX_TEXT = 2000;
const range = { start: "iso", end: "iso" } as const;

const COMMAND_SPEC: Record<Command["type"], Record<string, FieldSpec>> = {
  createOpenSlot: { ...range },
  deleteOpenSlot: { slotId: "id" },
  moveOpenSlot: { slotId: "id", ...range },
  requestBooking: { slotId: "id", message: "text" },
  requestChange: { fromSlotId: "id", toSlotId: "id", message: "text" },
  requestChangeToNewTime: { fromSlotId: "id", ...range, message: "text" },
  approve: { requestId: "id" },
  reject: { requestId: "id", reason: "text" },
  cancel: { requestId: "id" },
  addComment: { slotId: "id", body: "requiredText" },
  proposeHoliday: { slotId: "id", proposal: "proposal", message: "text" },
  proposeDefer: { slotId: "id", message: "text" },
  proposeMakeup: { slotId: "id", studentId: "id", message: "text" },
  adjustMakeup: { studentId: "id", delta: "num", reason: "requiredText" },
  restoreMissed: { slotId: "id" },
  registerEnrollment: {
    input: {
      studentId: "id",
      startDate: "date",
      endDate: "date",
      times: "times",
      weeks: "weeks",
      changeDeadlineHours: "num",
      fee: "optNum",
      paymentDay: "optNum",
    },
  },
  updateEnrollmentTerms: {
    id: "id",
    terms: { changeDeadlineHours: "num", fee: "optNum", paymentDay: "optNum" },
  },
  extendEnrollment: { id: "id", newEndDate: "date" },
  endEnrollment: { id: "id", endDate: "date" },
  requestScheduleChange: {
    enrollmentId: "id",
    schedule: { times: "times", weeks: "weeks" },
    fromDate: "date",
    message: "text",
  },
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const bad = (message: string) => new ApiError(400, "BAD_REQUEST", message);

function checkField(kind: FieldKind, v: unknown, path: string): unknown {
  const optional = kind === "text" || kind === "optNum";
  if (v === undefined || v === null) {
    if (optional) return undefined;
    throw bad(`${path} 값이 필요합니다.`);
  }
  switch (kind) {
    case "id":
      if (typeof v !== "string" || v.length === 0 || v.length > 200) throw bad(`${path} 형식이 잘못되었습니다.`);
      return v;
    case "text":
    case "requiredText":
      if (typeof v !== "string" || v.length > MAX_TEXT) throw bad(`${path} 형식이 잘못되었습니다.`);
      if (kind === "requiredText" && v.trim().length === 0) throw bad(`${path} 값이 필요합니다.`);
      return v;
    case "iso": {
      const ms = typeof v === "string" ? Date.parse(v) : NaN;
      if (Number.isNaN(ms)) throw bad(`${path} 는 ISO 시각이어야 합니다.`);
      return new Date(ms).toISOString();
    }
    case "date":
      if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw bad(`${path} 는 yyyy-MM-dd 형식이어야 합니다.`);
      return v;
    case "num":
    case "optNum":
      if (typeof v !== "number" || !Number.isFinite(v)) throw bad(`${path} 는 숫자여야 합니다.`);
      return v;
    case "proposal":
      if (v !== "PROCEED" && v !== "SKIP") throw bad(`${path} 는 PROCEED 또는 SKIP 이어야 합니다.`);
      return v;
    case "weeks":
      if (!Array.isArray(v) || v.length === 0 || v.length > 5 || !v.every((w) => Number.isInteger(w) && w >= 1 && w <= 5))
        throw bad(`${path} 형식이 잘못되었습니다.`);
      return [...v];
    case "times":
      if (!Array.isArray(v) || v.length === 0 || v.length > 14) throw bad(`${path} 형식이 잘못되었습니다.`);
      return v.map((t, i): WeeklyTime => {
        if (
          !isObject(t) ||
          !Number.isInteger(t.weekday) ||
          (t.weekday as number) < 0 ||
          (t.weekday as number) > 6 ||
          typeof t.time !== "string" ||
          !/^\d{2}:\d{2}$/.test(t.time) ||
          !Number.isInteger(t.durationMin) ||
          (t.durationMin as number) <= 0 ||
          (t.durationMin as number) > 24 * 60
        )
          throw bad(`${path}[${i}] 형식이 잘못되었습니다.`);
        return { weekday: t.weekday as number, time: t.time, durationMin: t.durationMin as number };
      });
  }
}

/** 명세에 있는 필드만 골라 깨끗한 객체를 만든다 (알 수 없는 필드는 버린다) */
function pick(spec: Record<string, FieldSpec>, src: unknown, path: string): Record<string, unknown> {
  if (!isObject(src)) throw bad(`${path} 는 객체여야 합니다.`);
  const out: Record<string, unknown> = {};
  for (const [key, fieldSpec] of Object.entries(spec)) {
    const value =
      typeof fieldSpec === "string"
        ? checkField(fieldSpec, src[key], `${path}.${key}`)
        : pick(fieldSpec, src[key], `${path}.${key}`);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export function parseCommand(raw: unknown): Command {
  if (!isObject(raw) || typeof raw.type !== "string") throw bad("command.type 이 필요합니다.");
  const type = raw.type;
  if (!Object.prototype.hasOwnProperty.call(COMMAND_SPEC, type)) throw bad(`알 수 없는 명령입니다: ${type}`);
  return { type, ...pick(COMMAND_SPEC[type as Command["type"]], raw, "command") } as Command;
}

/** 명령 안에 들어 있는 레슨생 id 가 이 스튜디오의 레슨생인지 */
function referencedStudentId(cmd: Command): string | undefined {
  switch (cmd.type) {
    case "registerEnrollment":
      return cmd.input.studentId;
    case "proposeMakeup":
    case "adjustMakeup":
      return cmd.studentId;
    default:
      return undefined;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const normalizeEmail = (e: string) => e.trim().toLowerCase();

function requireName(v: unknown, field: string): string {
  if (typeof v !== "string" || v.trim().length === 0 || v.trim().length > 100)
    throw bad(`${field} 은(는) 1~100자여야 합니다.`);
  return v.trim();
}

function parsePhone(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") throw bad("phone 형식이 잘못되었습니다.");
  const digits = v.replace(/[\s-]/g, "");
  if (!/^\+?\d{9,15}$/.test(digits)) throw bad("phone 형식이 잘못되었습니다. 예: 010-1234-5678");
  return digits;
}

/* ------------------------------------------------------------------ */
/* 응답 모양                                                           */
/* ------------------------------------------------------------------ */

const meView = (m: MemberRecord, studio: StudioRecord | null) => ({
  appKey: m.appKey,
  role: m.role,
  name: m.name,
  studioId: m.studioId,
  studioName: studio?.name ?? "",
});

/** 강사는 전원(연락처·연결 여부 포함), 레슨생은 강사와 자기 자신만 (appKey, role, name) */
function membersView(all: MemberRecord[], me: MemberRecord) {
  if (me.role === "INSTRUCTOR")
    return all.map((m) => ({
      appKey: m.appKey,
      role: m.role,
      name: m.name,
      email: m.email,
      phone: m.phone,
      linked: m.userId !== null,
    }));
  return all
    .filter((m) => m.role === "INSTRUCTOR" || m.id === me.id)
    .map((m) => ({ appKey: m.appKey, role: m.role, name: m.name }));
}

/* ------------------------------------------------------------------ */
/* 핸들러                                                              */
/* ------------------------------------------------------------------ */

export const OPS = ["me", "bootstrap", "view", "command", "addMember", "notifications", "markRead", "updateProfile"] as const;
export type Op = (typeof OPS)[number];

export async function handle(
  body: unknown,
  auth: AuthUser | null,
  store: Store,
  now: () => string = () => new Date().toISOString(),
  options: HandleOptions = {},
): Promise<ApiResponse> {
  const offset = (options.timezoneOffset ?? (() => new Date(2026, 0, 1).getTimezoneOffset()))();
  if (offset !== SEOUL_OFFSET_MINUTES)
    return fail(
      500,
      "SERVER_TZ",
      `서버 시간대가 Asia/Seoul 이 아닙니다 (UTC 오프셋 ${-offset}분). ` +
        "`supabase secrets set TZ=Asia/Seoul` 로 설정한 뒤 함수를 다시 배포하세요.",
    );
  try {
    if (!auth) throw new ApiError(401, "UNAUTHENTICATED", "로그인이 필요합니다.");
    if (!isObject(body) || typeof body.op !== "string") throw bad("op 가 필요합니다.");
    const op = body.op as Op;
    if (!OPS.includes(op)) throw bad(`알 수 없는 op 입니다: ${body.op}`);
    const api = new LessonApi(store, auth, now(), options);
    return { status: 200, json: { ok: true, ...(await api.run(op, body)) } };
  } catch (e) {
    if (e instanceof ApiError) return fail(e.status, e.code, e.message);
    if (e instanceof LessonError) return fail(LESSON_ERROR_STATUS[e.code] ?? 400, e.code, e.message);
    console.error("lesson-api internal error", e);
    return fail(500, "INTERNAL", "서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.");
  }
}

class LessonApi {
  store: Store;
  auth: AuthUser;
  nowIso: string;
  holiday: HolidayLookup;
  ctx: MachineContext;

  constructor(store: Store, auth: AuthUser, nowIso: string, options: HandleOptions) {
    this.store = store;
    this.auth = auth;
    this.nowIso = nowIso;
    this.holiday = options.holiday ?? holidayLookup;
    const newId = options.newId ?? defaultId;
    this.ctx = { now: () => nowIso, id: newId };
  }

  /** 로그인 사용자의 멤버 행. 처음 로그인한 초대 레슨생은 이메일로 찾아 연결한다 */
  async resolveMember(): Promise<MemberRecord | null> {
    const linked = await this.store.getMemberByUserId(this.auth.userId);
    if (linked) return linked;
    if (!this.auth.email) return null;
    const invited = await this.store.getMemberByEmail(normalizeEmail(this.auth.email));
    if (!invited || invited.userId !== null) return null;
    if (await this.store.linkUser(invited.id, this.auth.userId)) return { ...invited, userId: this.auth.userId };
    // 동시에 다른 요청이 먼저 연결했을 수 있다
    return this.store.getMemberByUserId(this.auth.userId);
  }

  async requireMember(): Promise<MemberRecord> {
    const m = await this.resolveMember();
    if (!m) throw new ApiError(403, "NOT_MEMBER", "이 계정은 아직 어느 스튜디오에도 등록되어 있지 않습니다.");
    return m;
  }

  actorOf = (m: MemberRecord): Actor => ({ userId: m.appKey, role: m.role });

  async loadState(studioId: string) {
    const loaded = await this.store.getState(studioId);
    if (!loaded) throw new ApiError(500, "INTERNAL", "스튜디오 상태가 없습니다.");
    return loaded;
  }

  notificationHelpers(members: MemberRecord[]) {
    const instructor = members.find((m) => m.role === "INSTRUCTOR");
    const names = new Map(members.map((m) => [m.appKey, m.name]));
    return {
      instructorAppKey: instructor?.appKey ?? "",
      nameOf: (key: string) => names.get(key) ?? "레슨생",
    };
  }

  derive(before: LessonState, after: LessonState, actor: Actor, members: MemberRecord[]): AppNotification[] {
    if (before === after) return [];
    const { instructorAppKey, nameOf } = this.notificationHelpers(members);
    return deriveNotifications(before, after, actor, instructorAppKey, nameOf, this.nowIso, this.ctx.id);
  }

  /* ---------------- ops ---------------- */

  run(op: Op, body: Record<string, unknown>): Promise<object> {
    switch (op) {
      case "me":
        return this.me();
      case "bootstrap":
        return this.bootstrap(body);
      case "view":
        return this.view();
      case "command":
        return this.command(body);
      case "addMember":
        return this.addMember(body);
      case "notifications":
        return this.notifications();
      case "markRead":
        return this.markRead(body);
      case "updateProfile":
        return this.updateProfile(body);
    }
  }

  async me() {
    const m = await this.resolveMember();
    if (!m) return { member: null };
    return { member: meView(m, await this.store.getStudio(m.studioId)) };
  }

  async bootstrap(body: Record<string, unknown>) {
    const studioName = requireName(body.studioName, "studioName");
    const instructorName = requireName(body.instructorName, "instructorName");
    if (await this.resolveMember()) throw new ApiError(409, "CONFLICT", "이미 스튜디오에 등록된 계정입니다.");
    if (!this.auth.email) throw bad("이메일이 확인된 계정만 스튜디오를 만들 수 있습니다.");
    for (let i = 0; i < MAX_COMMIT_ATTEMPTS; i++) {
      const created = await this.store.createStudio({
        name: studioName,
        instructor: {
          userId: this.auth.userId,
          email: normalizeEmail(this.auth.email),
          name: instructorName,
          appKey: appKeyFor("INSTRUCTOR"),
          phone: null,
        },
        state: emptyState(),
      });
      if (created) return { member: meView(created.member, created.studio) };
    }
    throw new ApiError(409, "CONFLICT", "스튜디오를 만들지 못했습니다. 다시 시도해 주세요.");
  }

  async view() {
    const me = await this.requireMember();
    const actor = this.actorOf(me);
    const members = await this.store.listMembers(me.studioId);
    for (let i = 0; i < MAX_COMMIT_ATTEMPTS; i++) {
      const loaded = await this.loadState(me.studioId);
      const settled = settleAll(loaded.state, this.holiday, this.ctx);
      let version = loaded.version;
      if (settled !== loaded.state) {
        const saved = await this.store.commit(
          me.studioId,
          loaded.version,
          settled,
          this.derive(loaded.state, settled, SYSTEM_ACTOR, members),
        );
        if (saved === null) continue; // 다른 요청이 먼저 저장함 → 다시 읽기
        version = saved;
      }
      return { version, state: visibleState(settled, actor), members: membersView(members, me) };
    }
    throw new ApiError(409, "CONFLICT", "다른 변경과 겹쳤습니다. 다시 시도해 주세요.");
  }

  async command(body: Record<string, unknown>) {
    const cmd = parseCommand(body.command);
    const me = await this.requireMember();
    const actor = this.actorOf(me);
    const members = await this.store.listMembers(me.studioId);
    const studentId = referencedStudentId(cmd);
    if (studentId !== undefined && !members.some((m) => m.role === "STUDENT" && m.appKey === studentId))
      throw bad("이 스튜디오의 레슨생이 아닙니다.");

    for (let i = 0; i < MAX_COMMIT_ATTEMPTS; i++) {
      const loaded = await this.loadState(me.studioId);
      const settled = settleAll(loaded.state, this.holiday, this.ctx);
      // 규칙 위반(LessonError)은 저장 없이 그대로 오류 응답이 된다
      const result: CommandResult = runCommand(settled, actor, cmd, this.ctx, this.holiday);
      const after = result.state;
      let version = loaded.version;
      if (after !== loaded.state) {
        const notifications = [
          ...this.derive(loaded.state, settled, SYSTEM_ACTOR, members),
          ...this.derive(settled, after, actor, members),
        ];
        const saved = await this.store.commit(me.studioId, loaded.version, after, notifications);
        if (saved === null) continue;
        version = saved;
      }
      const out: { created?: number; conflicts?: CommandResult["conflicts"]; removed?: number; slotId?: string } = {};
      if (result.created !== undefined) out.created = result.created;
      if (result.conflicts !== undefined) out.conflicts = result.conflicts;
      if (result.removed !== undefined) out.removed = result.removed;
      if (result.slotId !== undefined) out.slotId = result.slotId;
      return { version, state: visibleState(after, actor), result: out };
    }
    throw new ApiError(409, "CONFLICT", "다른 변경과 겹쳤습니다. 다시 시도해 주세요.");
  }

  async addMember(body: Record<string, unknown>) {
    const me = await this.requireMember();
    if (me.role !== "INSTRUCTOR") throw new ApiError(403, "FORBIDDEN", "강사만 레슨생을 추가할 수 있습니다.");
    const name = requireName(body.name, "name");
    if (typeof body.email !== "string" || !EMAIL_RE.test(body.email.trim()) || body.email.length > 254)
      throw bad("email 형식이 잘못되었습니다.");
    const email = normalizeEmail(body.email);
    const phone = parsePhone(body.phone);
    for (let i = 0; i < MAX_COMMIT_ATTEMPTS; i++) {
      const r = await this.store.insertMember({
        studioId: me.studioId,
        userId: null,
        email,
        role: "STUDENT",
        name,
        appKey: appKeyFor("STUDENT"),
        phone,
      });
      if (r.ok) return { members: membersView(await this.store.listMembers(me.studioId), me) };
      if (r.reason === "EMAIL_TAKEN") throw new ApiError(409, "CONFLICT", "이미 등록된 이메일입니다.");
    }
    throw new ApiError(409, "CONFLICT", "레슨생을 추가하지 못했습니다. 다시 시도해 주세요.");
  }

  async notifications() {
    const me = await this.requireMember();
    return { notifications: await this.store.listNotifications(me.studioId, me.appKey, NOTIFICATION_LIMIT) };
  }

  async markRead(body: Record<string, unknown>) {
    const ids = body.ids;
    if (!Array.isArray(ids) || ids.length > 500 || !ids.every((x) => typeof x === "string" && x.length <= 200))
      throw bad("ids 는 문자열 배열이어야 합니다 (최대 500개).");
    const me = await this.requireMember();
    const updated = await this.store.markRead(me.studioId, me.appKey, ids as string[], this.nowIso);
    return { updated };
  }

  /** (계약 외 확장) 본인의 휴대폰 번호·알림톡 수신 동의 변경 */
  async updateProfile(body: Record<string, unknown>) {
    const me = await this.requireMember();
    const patch: { phone?: string | null; kakaoOptIn?: boolean } = {};
    if ("phone" in body) patch.phone = parsePhone(body.phone);
    if ("kakaoOptIn" in body) {
      if (typeof body.kakaoOptIn !== "boolean") throw bad("kakaoOptIn 은 true/false 여야 합니다.");
      patch.kakaoOptIn = body.kakaoOptIn;
    }
    await this.store.updateMember(me.id, patch);
    return {};
  }
}
