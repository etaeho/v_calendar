"use client";

import { ArrowRightLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fmtDateTime } from "@/lib/calendar-items";
import { useCalendarStore } from "@/store/calendar-store";

/** 일정 변경 대상 선택 모드일 때 달력 위에 표시되는 안내 */
export function RescheduleBanner() {
  const drawer = useCalendarStore((s) => s.drawer);
  const slots = useCalendarStore((s) => s.lesson.slots);
  const openDrawer = useCalendarStore((s) => s.openDrawer);
  if (drawer.type !== "reschedule") return null;
  const from = slots.find((s) => s.id === drawer.fromSlotId);
  if (!from) return null;

  return (
    <div className="flex items-center gap-2 border-b border-violet-200 bg-violet-50 px-4 py-2 text-sm text-violet-900">
      <ArrowRightLeft className="size-4 shrink-0" />
      <p className="min-w-0 flex-1">
        <strong className="font-semibold">{fmtDateTime(from.start)}</strong> 레슨을 옮길{" "}
        <strong className="font-semibold">빈 슬롯(점선)</strong>을 달력에서 선택하세요.
      </p>
      <Button size="sm" onClick={() => openDrawer({ type: "slot", slotId: from.id })}>
        취소
      </Button>
    </div>
  );
}
