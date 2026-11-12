/**
 * 대한민국 공휴일·기념일.
 * 데이터는 구글 캘린더의 공개 '대한민국의 휴일' 캘린더에서 `npm run holidays` 로 받아 저장한 것이다
 * (GitHub Actions 배포 때마다 다시 받아 갱신한다).
 */
import { format } from "date-fns";
import data from "@/data/holidays-kr.json";

export interface Holiday {
  date: string;
  name: string;
  /** true: 쉬는 공휴일(대체공휴일 포함) / false: 기념일(어버이날 등) */
  dayOff: boolean;
}

/**
 * 구글 공개 캘린더에 빠져 있는 공휴일 보완 (설 연휴 첫날이 토요일인 해 등).
 * 데이터 소스에 해당 날짜가 생기면 중복되지 않도록 아래에서 걸러진다.
 */
const SUPPLEMENT: Holiday[] = [{ date: "2027-02-06", name: "설날 연휴", dayOff: true }];

const byDate = new Map<string, Holiday[]>();
const source = data as Holiday[];
const all = [...source, ...SUPPLEMENT.filter((x) => !source.some((h) => h.date === x.date && h.dayOff))];
for (const h of all) {
  const list = byDate.get(h.date);
  if (list) list.push(h);
  else byDate.set(h.date, [h]);
}

export const holidaysOn = (day: Date): Holiday[] => byDate.get(format(day, "yyyy-MM-dd")) ?? [];

/** 달력 칸에 표시할 대표 휴일 (공휴일 우선) */
export const mainHoliday = (day: Date): Holiday | undefined => {
  const list = holidaysOn(day);
  return list.find((h) => h.dayOff) ?? list[0];
};

export const isDayOff = (day: Date) => holidaysOn(day).some((h) => h.dayOff);
