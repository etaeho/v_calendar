/**
 * Edge Function(Deno) 런타임 연결부 — 직접 작성한 파일 (sync 스크립트가 만들지 않음).
 *
 * 저장소 루트의 `tsc --noEmit` 도 이 폴더를 검사하므로, Deno 전역(Deno.*)은 globalThis 를 통해 쓰고
 * npm: import 는 @ts-ignore 로 감싼다. `deno check` 에서는 실제 타입으로 검사된다.
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- Deno 의 npm: 지정자 (Node/tsc 는 해석하지 못함)
import { createClient } from "npm:@supabase/supabase-js@2";

interface DenoRuntime {
  env: { get(name: string): string | undefined };
  serve(handler: (req: Request) => Response | Promise<Response>): unknown;
}

const deno = (globalThis as unknown as { Deno: DenoRuntime }).Deno;

export const env = (name: string): string | undefined => deno.env.get(name);

export function requireEnv(name: string): string {
  const v = env(name);
  if (!v) throw new Error(`환경 변수 ${name} 가 없습니다.`);
  return v;
}

export const serve = (handler: (req: Request) => Response | Promise<Response>) => deno.serve(handler);

/** service_role 키 클라이언트 — RLS 를 우회하므로 Edge Function 안에서만 쓴다 */
export function serviceClient() {
  return createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export type DbClient = ReturnType<typeof serviceClient>;

export const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
