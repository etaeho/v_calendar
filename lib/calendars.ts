import type { CalendarCategory, CalendarMeta } from "@/types/calendar";

export const CALENDARS: (CalendarMeta & { dot: string; check: string })[] = [
  {
    id: "LESSON",
    label: "바이올린 레슨",
    description: "레슨 · 빈 슬롯 · 요청",
    dot: "bg-mint-500",
    check: "accent-mint-600",
  },
  {
    id: "GOOGLE",
    label: "내 구글 캘린더",
    description: "Google Calendar",
    dot: "bg-blue-500",
    check: "accent-blue-600",
  },
  {
    id: "KAKAO",
    label: "내 카카오 캘린더",
    description: "톡캘린더",
    dot: "bg-coral-500",
    check: "accent-coral-600",
  },
];

export const calendarLabel = (id: CalendarCategory) =>
  CALENDARS.find((c) => c.id === id)!.label;
