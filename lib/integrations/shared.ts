/** 구글/카카오 연동이 함께 쓰는 순수 헬퍼 */
import type { LessonSlot } from "../../types/calendar";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** 브라우저 fetch 를 늦게 바인딩 (테스트/SSR 에서 모듈을 불러와도 안전) */
export const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

export interface SyncRange {
  start: Date;
  end: Date;
}

const DAY = 24 * 60 * 60 * 1000;

/** fetchEvents 에 범위가 없을 때 쓰는 기본 범위: 오늘 기준 14일 전 ~ 90일 후 (현지 자정 기준) */
export function defaultSyncRange(now: Date = new Date()): SyncRange {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return { start: new Date(midnight.getTime() - 14 * DAY), end: new Date(midnight.getTime() + 90 * DAY) };
}

/** "yyyy-MM-dd" → 그 날짜의 현지 자정 ISO 문자열 (종일 일정용) */
export function localMidnightIso(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1).toISOString();
}

export const LESSON_TIME_ZONE = "Asia/Seoul";

export const lessonTitle = (lesson: Pick<LessonSlot, "lessonType">) =>
  lesson.lessonType === "MAKEUP" ? "보강 레슨" : "바이올린 레슨";

export const lessonDescription = () =>
  "V Calendar 에서 확정된 레슨입니다.\n앱에서 일정이 바뀌면 이 일정도 자동으로 수정·삭제됩니다.";

/**
 * 같은 키(레슨 id)에 대한 비동기 작업을 순서대로 실행한다.
 * 강사/레슨생 두 사람 몫으로 같은 레슨이 동시에 Push 되어도 검색→생성이 겹쳐 중복 일정이 생기지 않게 한다.
 */
export class KeyedQueue {
  private tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(task, task);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}

/** 응답 본문을 JSON 으로 읽되 실패하면 undefined */
export async function readJson(res: Response): Promise<unknown> {
  try {
    const text = await res.text();
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}

/** Web Storage 최소 인터페이스 (sessionStorage/localStorage 또는 테스트용 메모리 저장소) */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class MemoryStorage implements StorageLike {
  private map = new Map<string, string>();
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
}

/** 브라우저 저장소를 안전하게 얻는다 (차단/미지원이면 메모리 저장소) */
export function browserStorage(kind: "session" | "local"): StorageLike {
  try {
    const s = kind === "session" ? globalThis.sessionStorage : globalThis.localStorage;
    if (s) return s;
  } catch {
    /* 사파리 사생활 보호 모드 등 */
  }
  return new MemoryStorage();
}
