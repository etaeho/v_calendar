/** 테스트용 fetch 목: 호출을 기록하고 순서대로 응답한다 */
import type { FetchLike } from "./shared.ts";

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export type MockReply = { status?: number; body?: unknown } | ((call: RecordedCall) => { status?: number; body?: unknown });

export function mockFetch(replies: MockReply[]): FetchLike & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fn = (async (input: string, init: RequestInit = {}) => {
    const call: RecordedCall = {
      url: input,
      method: init.method ?? "GET",
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    const next = replies.shift();
    if (!next) throw new Error(`예상하지 못한 요청: ${call.method} ${call.url}`);
    const reply = typeof next === "function" ? next(call) : next;
    const status = reply.status ?? 200;
    const body = reply.body === undefined ? null : JSON.stringify(reply.body);
    return new Response(status === 204 ? null : body, { status });
  }) as FetchLike & { calls: RecordedCall[] };
  fn.calls = calls;
  return fn;
}
