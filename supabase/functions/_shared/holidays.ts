// AUTO-GENERATED from lib/server/holidays.ts by scripts/sync-supabase-shared.mjs — DO NOT EDIT.
// 원본을 고친 뒤 `npm run supabase:shared` 로 다시 만드세요.
/**
 * 서버(Edge Function)용 공휴일 조회 — date-fns 없이 현지 날짜(getFullYear/getMonth/getDate)로 찾는다.
 * 서버 프로세스가 Asia/Seoul 로 동작해야 날짜가 맞는다 (lesson-api-core 의 시간대 검사 참고).
 * lib/holidays.ts(브라우저용)와 같은 규칙: 쉬는 날(dayOff=true) 항목이 있으면 그 이름.
 */
import type { HolidayLookup } from "./enrollment.ts";
import data from "./holidays-kr.json" with { type: "json" };

export interface HolidayEntry {
  date: string;
  name: string;
  dayOff: boolean;
}

/** lib/holidays.ts 의 SUPPLEMENT 와 같은 보완 데이터 (구글 공개 캘린더 누락분) */
const SUPPLEMENT: HolidayEntry[] = [{ date: "2027-02-06", name: "설날 연휴", dayOff: true }];

const pad = (n: number) => String(n).padStart(2, "0");
const localKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function makeHolidayLookup(entries: HolidayEntry[]): HolidayLookup {
  const byDate = new Map<string, string>();
  for (const h of [...entries, ...SUPPLEMENT]) {
    if (h.dayOff && !byDate.has(h.date)) byDate.set(h.date, h.name);
  }
  return (day: Date) => byDate.get(localKey(day));
}

export const holidayLookup: HolidayLookup = makeHolidayLookup(data as HolidayEntry[]);
