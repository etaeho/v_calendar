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

const byDate = new Map<string, Holiday[]>();
for (const h of data as Holiday[]) {
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
