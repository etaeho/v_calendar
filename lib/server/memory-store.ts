/**
 * 메모리 Store — 테스트용. Postgres Store(supabase/functions/lesson-api/pg-store.ts)와 같은 의미를 가진다.
 * 상태는 JSON 으로 복사해 저장/반환해 실제 DB(JSONB) 왕복과 같게 동작한다.
 */
import type { LessonState } from "../../types/calendar.ts";
import type { AppNotification } from "../notifications.ts";
import type { InsertMemberResult, MemberRecord, NewMember, Store, StudioRecord } from "./lesson-api-core.ts";

export interface StoredNotification extends AppNotification {
  studioId: string;
  alimtalkStatus: "PENDING" | "SENDING" | "SENT" | "FAILED" | "SKIPPED";
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

export class MemoryStore implements Store {
  studios: StudioRecord[] = [];
  members: MemberRecord[] = [];
  states = new Map<string, { state: LessonState; version: number }>();
  events: { id: number; studioId: string; version: number }[] = [];
  notifications: StoredNotification[] = [];
  /** 테스트용 훅: commit 직전에 호출 (동시 수정 흉내) */
  beforeCommit?: (studioId: string) => void;
  private seq = 0;

  private newUuid() {
    this.seq += 1;
    return `00000000-0000-4000-8000-${String(this.seq).padStart(12, "0")}`;
  }

  async getMemberByUserId(userId: string) {
    return this.members.find((m) => m.userId === userId) ?? null;
  }

  async getMemberByEmail(email: string) {
    const e = email.toLowerCase();
    return this.members.find((m) => m.userId === null && m.email.toLowerCase() === e) ?? null;
  }

  async linkUser(memberId: string, userId: string) {
    const m = this.members.find((x) => x.id === memberId);
    if (!m || m.userId !== null || this.members.some((x) => x.userId === userId)) return false;
    m.userId = userId;
    return true;
  }

  async getStudio(studioId: string) {
    return this.studios.find((s) => s.id === studioId) ?? null;
  }

  async createStudio(input: Parameters<Store["createStudio"]>[0]) {
    if (this.members.some((m) => m.appKey === input.instructor.appKey)) return null;
    if (input.instructor.userId && this.members.some((m) => m.userId === input.instructor.userId)) return null;
    const studio: StudioRecord = { id: this.newUuid(), name: input.name };
    this.studios.push(studio);
    const r = await this.insertMember({ ...input.instructor, studioId: studio.id, role: "INSTRUCTOR" });
    if (!r.ok) throw new Error("unreachable");
    this.states.set(studio.id, { state: clone(input.state), version: 0 });
    return { studio, member: r.member };
  }

  async listMembers(studioId: string) {
    return this.members
      .filter((m) => m.studioId === studioId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async insertMember(input: NewMember): Promise<InsertMemberResult> {
    if (this.members.some((m) => m.appKey === input.appKey)) return { ok: false, reason: "APP_KEY_TAKEN" };
    if (this.members.some((m) => m.studioId === input.studioId && m.email.toLowerCase() === input.email.toLowerCase()))
      return { ok: false, reason: "EMAIL_TAKEN" };
    const member: MemberRecord = {
      ...input,
      id: this.newUuid(),
      kakaoOptIn: false,
      createdAt: new Date().toISOString(),
    };
    this.members.push(member);
    return { ok: true, member };
  }

  async updateMember(memberId: string, patch: { phone?: string | null; kakaoOptIn?: boolean }) {
    const m = this.members.find((x) => x.id === memberId);
    if (!m) return;
    if (patch.phone !== undefined) m.phone = patch.phone;
    if (patch.kakaoOptIn !== undefined) m.kakaoOptIn = patch.kakaoOptIn;
  }

  async getState(studioId: string) {
    const s = this.states.get(studioId);
    return s ? { state: clone(s.state), version: s.version } : null;
  }

  async commit(studioId: string, expectedVersion: number, state: LessonState, notifications: AppNotification[]) {
    this.beforeCommit?.(studioId);
    const cur = this.states.get(studioId);
    if (!cur || cur.version !== expectedVersion) return null;
    const version = expectedVersion + 1;
    this.states.set(studioId, { state: clone(state), version });
    this.events.push({ id: this.events.length + 1, studioId, version });
    for (const n of notifications) this.notifications.push({ ...clone(n), studioId, alimtalkStatus: "PENDING" });
    return version;
  }

  async listNotifications(studioId: string, recipient: string, limit: number) {
    return this.notifications
      .filter((n) => n.studioId === studioId && n.recipient === recipient)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((n): AppNotification => {
        const out = clone(n) as Partial<StoredNotification>;
        delete out.studioId;
        delete out.alimtalkStatus;
        return out as AppNotification;
      });
  }

  async markRead(studioId: string, recipient: string, ids: string[], at: string) {
    let count = 0;
    for (const n of this.notifications) {
      if (n.studioId === studioId && n.recipient === recipient && ids.includes(n.id) && !n.readAt) {
        n.readAt = at;
        count += 1;
      }
    }
    return count;
  }
}
