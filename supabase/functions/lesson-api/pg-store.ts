/**
 * Postgres(Supabase) Store — lesson-api-core 의 Store 인터페이스 구현.
 * service_role 클라이언트로 테이블과 SQL 함수(bootstrap_studio, commit_studio_change)를 쓴다.
 * 의미는 lib/server/memory-store.ts(테스트용)와 같다.
 */
import type { LessonState } from "../_shared/calendar.ts";
import type { InsertMemberResult, MemberRecord, NewMember, Store, StudioRecord } from "../_shared/lesson-api-core.ts";
import type { AppNotification } from "../_shared/notifications.ts";
import type { DbClient } from "../_shared/runtime.ts";

const MEMBER_COLS = "id, studio_id, user_id, email, role, name, app_key, phone, kakao_opt_in, created_at";
const NOTIFICATION_COLS = "id, recipient_app_key, kind, title, body, slot_id, request_id, created_at, read_at";

type Row = Record<string, unknown>;
interface DbError {
  code?: string;
  message: string;
}

const str = (v: unknown) => (v === null || v === undefined ? null : String(v));

const toMember = (r: Row): MemberRecord => ({
  id: String(r.id),
  studioId: String(r.studio_id),
  userId: str(r.user_id),
  email: String(r.email),
  role: r.role === "INSTRUCTOR" ? "INSTRUCTOR" : "STUDENT",
  name: String(r.name ?? ""),
  appKey: String(r.app_key),
  phone: str(r.phone),
  kakaoOptIn: r.kakao_opt_in === true,
  createdAt: String(r.created_at),
});

const toNotification = (r: Row): AppNotification => {
  const n: AppNotification = {
    id: String(r.id),
    recipient: String(r.recipient_app_key),
    kind: r.kind as AppNotification["kind"],
    title: String(r.title),
    body: String(r.body),
    createdAt: new Date(String(r.created_at)).toISOString(),
  };
  if (r.slot_id) n.slotId = String(r.slot_id);
  if (r.request_id) n.requestId = String(r.request_id);
  if (r.read_at) n.readAt = new Date(String(r.read_at)).toISOString();
  return n;
};

const isUniqueViolation = (e: DbError | null) => e?.code === "23505";

function check(error: DbError | null, what: string) {
  if (error) throw new Error(`${what}: ${error.code ?? ""} ${error.message}`);
}

export class PgStore implements Store {
  db: DbClient;
  constructor(db: DbClient) {
    this.db = db;
  }

  async getMemberByUserId(userId: string) {
    const { data, error } = await this.db
      .from("members")
      .select(MEMBER_COLS)
      .eq("user_id", userId)
      .order("created_at")
      .limit(1)
      .maybeSingle();
    check(error, "getMemberByUserId");
    return data ? toMember(data as Row) : null;
  }

  async getMemberByEmail(email: string) {
    // 이메일은 항상 소문자로 저장한다 (lesson-api-core 가 정규화). ilike 는 _ % 를 와일드카드로 보므로 쓰지 않는다
    const { data, error } = await this.db
      .from("members")
      .select(MEMBER_COLS)
      .eq("email", email.toLowerCase())
      .is("user_id", null)
      .order("created_at")
      .limit(1)
      .maybeSingle();
    check(error, "getMemberByEmail");
    return data ? toMember(data as Row) : null;
  }

  async linkUser(memberId: string, userId: string) {
    const { data, error } = await this.db
      .from("members")
      .update({ user_id: userId })
      .eq("id", memberId)
      .is("user_id", null)
      .select("id");
    if (isUniqueViolation(error)) return false;
    check(error, "linkUser");
    return Array.isArray(data) && data.length === 1;
  }

  async getStudio(studioId: string): Promise<StudioRecord | null> {
    const { data, error } = await this.db.from("studios").select("id, name").eq("id", studioId).maybeSingle();
    check(error, "getStudio");
    return data ? { id: String((data as Row).id), name: String((data as Row).name) } : null;
  }

  async createStudio(input: Parameters<Store["createStudio"]>[0]) {
    const { data: studioId, error } = await this.db.rpc("bootstrap_studio", {
      p_user_id: input.instructor.userId,
      p_email: input.instructor.email,
      p_studio_name: input.name,
      p_instructor_name: input.instructor.name,
      p_app_key: input.instructor.appKey,
      p_state: input.state,
    });
    if (isUniqueViolation(error)) return null;
    check(error, "createStudio");
    const id = String(studioId);
    const studio = await this.getStudio(id);
    const member = (await this.listMembers(id)).find((m) => m.appKey === input.instructor.appKey);
    if (!studio || !member) throw new Error("createStudio: 만든 스튜디오를 다시 읽지 못했습니다.");
    return { studio, member };
  }

  async listMembers(studioId: string) {
    const { data, error } = await this.db
      .from("members")
      .select(MEMBER_COLS)
      .eq("studio_id", studioId)
      .order("created_at")
      .order("id");
    check(error, "listMembers");
    return ((data ?? []) as Row[]).map(toMember);
  }

  async insertMember(input: NewMember): Promise<InsertMemberResult> {
    const { data, error } = await this.db
      .from("members")
      .insert({
        studio_id: input.studioId,
        user_id: input.userId,
        email: input.email.toLowerCase(),
        role: input.role,
        name: input.name,
        app_key: input.appKey,
        phone: input.phone,
      })
      .select(MEMBER_COLS)
      .single();
    if (isUniqueViolation(error)) {
      const which = (error as DbError).message.includes("app_key") ? "APP_KEY_TAKEN" : "EMAIL_TAKEN";
      return { ok: false, reason: which };
    }
    check(error, "insertMember");
    return { ok: true, member: toMember(data as Row) };
  }

  async updateMember(memberId: string, patch: { phone?: string | null; kakaoOptIn?: boolean }) {
    const row: Row = {};
    if (patch.phone !== undefined) row.phone = patch.phone;
    if (patch.kakaoOptIn !== undefined) row.kakao_opt_in = patch.kakaoOptIn;
    if (Object.keys(row).length === 0) return;
    const { error } = await this.db.from("members").update(row).eq("id", memberId);
    check(error, "updateMember");
  }

  async getState(studioId: string) {
    const { data, error } = await this.db
      .from("studio_state")
      .select("state, version")
      .eq("studio_id", studioId)
      .maybeSingle();
    check(error, "getState");
    if (!data) return null;
    return { state: (data as Row).state as LessonState, version: Number((data as Row).version) };
  }

  async commit(studioId: string, expectedVersion: number, state: LessonState, notifications: AppNotification[]) {
    const { data, error } = await this.db.rpc("commit_studio_change", {
      p_studio_id: studioId,
      p_expected_version: expectedVersion,
      p_state: state,
      p_notifications: notifications,
    });
    check(error, "commit");
    return data === null || data === undefined ? null : Number(data);
  }

  async listNotifications(studioId: string, recipientAppKey: string, limit: number) {
    const { data, error } = await this.db
      .from("notifications")
      .select(NOTIFICATION_COLS)
      .eq("studio_id", studioId)
      .eq("recipient_app_key", recipientAppKey)
      .order("created_at", { ascending: false })
      .limit(limit);
    check(error, "listNotifications");
    return ((data ?? []) as Row[]).map(toNotification);
  }

  async markRead(studioId: string, recipientAppKey: string, ids: string[], at: string) {
    if (ids.length === 0) return 0;
    const { data, error } = await this.db
      .from("notifications")
      .update({ read_at: at })
      .eq("studio_id", studioId)
      .eq("recipient_app_key", recipientAppKey)
      .in("id", ids)
      .is("read_at", null)
      .select("id");
    check(error, "markRead");
    return Array.isArray(data) ? data.length : 0;
  }
}
