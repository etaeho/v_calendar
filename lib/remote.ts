/**
 * 서버 모드(Supabase) 클라이언트.
 * NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY 가 빌드에 들어 있을 때만 켜진다.
 * 없으면 앱은 지금처럼 데모 모드(브라우저 메모리)로 동작한다.
 */
import type { Command, CommandResult } from "./commands.ts";
import type { AppNotification } from "./notifications.ts";
import type { LessonState, User, UserRole } from "../types/calendar";

export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
export const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
export const remoteConfigured = () => !!SUPABASE_URL && !!SUPABASE_ANON_KEY;

export interface Me {
  appKey: string;
  role: UserRole;
  name: string;
  studioId: string;
  studioName: string;
}

export interface RemoteError {
  code: string;
  message: string;
}

export type ApiResponse<T> = ({ ok: true } & T) | { ok: false; error: RemoteError };

export interface ViewPayload {
  version: number;
  state: LessonState;
  members: { appKey: string; role: UserRole; name: string }[];
}

export const toUsers = (members: ViewPayload["members"]): User[] =>
  members.map((m) => ({ id: m.appKey, name: m.name, role: m.role }));

/** 서버 API 호출기 (Edge Function `lesson-api`) */
export class RemoteApi {
  constructor(
    private getToken: () => Promise<string | null>,
    private fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {}

  private async call<T>(body: Record<string, unknown>): Promise<ApiResponse<T>> {
    const token = await this.getToken();
    if (!token) return { ok: false, error: { code: "UNAUTHENTICATED", message: "로그인이 필요합니다." } };
    try {
      const res = await this.fetchImpl(`${SUPABASE_URL}/functions/v1/lesson-api`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          apikey: SUPABASE_ANON_KEY,
        },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => null)) as ApiResponse<T> | null;
      if (!json) return { ok: false, error: { code: "NETWORK", message: `서버 응답을 읽을 수 없습니다 (${res.status}).` } };
      return json;
    } catch {
      return { ok: false, error: { code: "NETWORK", message: "서버에 연결할 수 없습니다. 인터넷 연결을 확인해 주세요." } };
    }
  }

  me = () => this.call<{ member: Me | null }>({ op: "me" });
  bootstrap = (studioName: string, instructorName: string) =>
    this.call<{ member: Me }>({ op: "bootstrap", studioName, instructorName });
  view = () => this.call<ViewPayload>({ op: "view" });
  command = (command: Command) =>
    this.call<{ version: number; state: LessonState; result: Omit<CommandResult, "state"> }>({
      op: "command",
      command,
    });
  addMember = (name: string, email: string, phone?: string) =>
    this.call<{ members: ViewPayload["members"] }>({ op: "addMember", name, email, phone });
  updateProfile = (patch: { phone?: string | null; kakaoOptIn?: boolean }) =>
    this.call<Record<string, unknown>>({ op: "updateProfile", ...patch });
  notifications = () => this.call<{ notifications: AppNotification[] }>({ op: "notifications" });
  markRead = (ids: string[]) => this.call<Record<string, never>>({ op: "markRead", ids });
}
