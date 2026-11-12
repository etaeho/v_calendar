"use client";

import { ArrowRightLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fmtDateTime, useFocusStudent } from "@/lib/calendar-items";
import { userName } from "@/lib/directory";
import { studentColor } from "@/lib/student-colors";
import { cn } from "@/lib/utils";
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
        <strong className="font-semibold">빈 슬롯(가능)</strong>을 달력에서 선택하세요.
      </p>
      <Button size="sm" onClick={() => openDrawer({ type: "slot", slotId: from.id })}>
        취소
      </Button>
    </div>
  );
}

/** 강사 화면: 특정 레슨생 일정만 강조 중일 때 */
export function FocusBanner() {
  const focus = useFocusStudent();
  const pinned = useCalendarStore((s) => s.focusStudentId);
  const setFocusStudent = useCalendarStore((s) => s.setFocusStudent);
  const drawerType = useCalendarStore((s) => s.drawer.type);
  if (!focus || drawerType === "reschedule") return null;
  const fromDrawer = focus !== pinned;
  return (
    <div className="flex items-center gap-2 border-b border-zinc-200 bg-zinc-50 px-4 py-1.5 text-sm text-zinc-800">
      <span className={cn("size-3 shrink-0 rounded-full", studentColor(focus)?.dot)} />
      <p className="min-w-0 flex-1">
        <strong>{userName(focus)}</strong> 일정만 강조해서 보는 중
        {fromDrawer && <span className="text-zinc-500"> · 상세 창을 닫으면 {pinned ? `${userName(pinned)} 강조로` : "모두 보기로"} 돌아갑니다</span>}
      </p>
      {pinned && (
        <Button size="sm" onClick={() => setFocusStudent(null)}>
          강조 해제
        </Button>
      )}
    </div>
  );
}
