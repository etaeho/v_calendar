"use client";

/**
 * Supabase 브라우저 클라이언트 (서버 모드에서만 생성).
 * 로그인(이메일 링크/코드)과 실시간 변경 알림에만 쓰고, 데이터는 lesson-api 함수로 주고받는다.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { remoteConfigured, SUPABASE_ANON_KEY, SUPABASE_URL } from "@/lib/remote";

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient | null {
  if (!remoteConfigured()) return null;
  client ??= createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  return client;
}

export async function accessToken(): Promise<string | null> {
  const sb = getSupabase();
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  return data.session?.access_token ?? null;
}
