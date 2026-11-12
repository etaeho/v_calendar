import assert from "node:assert/strict";
import { it } from "node:test";
import { parseIcs } from "../scripts/fetch-holidays.mjs";

it("구글 휴일 iCal 을 날짜별 공휴일/기념일로 변환한다", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "DTSTART;VALUE=DATE:20260302",
    "DTEND;VALUE=DATE:20260303",
    "DESCRIPTION:공휴일",
    "SUMMARY:쉬는 날 삼일절",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "DTSTART;VALUE=DATE:20260216",
    "DTEND;VALUE=DATE:20260218",
    "DESCRIPTION:공휴일",
    "SUMMARY:설날 ",
    " 연휴",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "DTSTART;VALUE=DATE:20260508",
    "DTEND;VALUE=DATE:20260509",
    "DESCRIPTION:기념일\\n기념일을 숨기려면 ...",
    "SUMMARY:어버이날",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  assert.deepEqual(parseIcs(ics), [
    { date: "2026-02-16", name: "설날 연휴", dayOff: true },
    { date: "2026-02-17", name: "설날 연휴", dayOff: true },
    { date: "2026-03-02", name: "삼일절 대체공휴일", dayOff: true },
    { date: "2026-05-08", name: "어버이날", dayOff: false },
  ]);
});
