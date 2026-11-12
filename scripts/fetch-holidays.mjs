/**
 * 구글 캘린더의 공개 '대한민국의 휴일' 캘린더(iCal)를 내려받아 data/holidays-kr.json 으로 저장한다.
 * API 키가 필요 없다. 실패하면 기존 파일을 그대로 두고 경고만 출력한다 (빌드는 계속 진행).
 *
 *   node scripts/fetch-holidays.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";

const URL =
  "https://calendar.google.com/calendar/ical/ko.south_korea%23holiday%40group.v.calendar.google.com/public/basic.ics";
const OUT = "data/holidays-kr.json";

const toIso = (yyyymmdd) => `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;

/** DTEND 는 종료일 다음 날(배타적)이므로 그 전날까지 하루씩 펼친다 */
function* days(start, end) {
  const d = new Date(`${toIso(start)}T00:00:00Z`);
  const stop = new Date(`${toIso(end)}T00:00:00Z`);
  do {
    yield d.toISOString().slice(0, 10);
    d.setUTCDate(d.getUTCDate() + 1);
  } while (d < stop);
}

export function parseIcs(text) {
  // RFC 5545 줄 접기(다음 줄이 공백으로 시작) 풀기
  const unfolded = text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
  const out = [];
  for (const block of unfolded.split("BEGIN:VEVENT").slice(1)) {
    const field = (name) => block.match(new RegExp(`^${name}[^:]*:(.*)$`, "m"))?.[1]?.trim();
    const start = field("DTSTART");
    const end = field("DTEND") ?? start;
    const summary = field("SUMMARY");
    if (!start || !summary) continue;
    const dayOff = (field("DESCRIPTION") ?? "").startsWith("공휴일");
    // 구글은 대체공휴일을 '쉬는 날 삼일절' 처럼 표기한다
    const name = summary.replace(/^쉬는 날\s+(.+)$/, "$1 대체공휴일");
    for (const date of days(start.slice(0, 8), end.slice(0, 8))) out.push({ date, name, dayOff });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || Number(b.dayOff) - Number(a.dayOff));
}

async function main() {
  try {
    const res = await fetch(URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const holidays = parseIcs(await res.text());
    if (holidays.length === 0) throw new Error("휴일 데이터가 비어 있습니다");
    const json = `${JSON.stringify(holidays, null, 1)}\n`;
    let prev = "";
    try {
      prev = readFileSync(OUT, "utf8");
    } catch {}
    writeFileSync(OUT, json);
    console.log(`${OUT}: ${holidays.length}일${prev === json ? " (변경 없음)" : " (갱신됨)"}`);
  } catch (e) {
    console.warn(`[holidays] 내려받기 실패, 기존 ${OUT} 사용: ${e.message}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
