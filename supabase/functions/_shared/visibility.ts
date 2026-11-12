// AUTO-GENERATED from lib/visibility.ts by scripts/sync-supabase-shared.mjs — DO NOT EDIT.
// 원본을 고친 뒤 `npm run supabase:shared` 로 다시 만드세요.
/**
 * 서버가 레슨생에게 내려 줄 상태를 만든다 (개인정보 보호).
 * 강사는 전체를, 레슨생은 다음만 받는다.
 * - 빈 슬롯(OPEN) 전체, 자기 레슨·기록 전체
 * - 다른 레슨생의 레슨은 시간만 남긴 '마감' 칸 (이름·요청·메시지 없음), 휴강 기록은 아예 제외
 * - 자기 요청·자기 레슨의 메시지·자기 수강 등록·자기 보강 조정만
 */
import type { Actor, LessonState } from "./calendar.ts";

export function visibleState(state: LessonState, actor: Actor): LessonState {
  if (actor.role === "INSTRUCTOR") return state;
  const me = actor.userId;
  const mineThreads = new Set(state.slots.filter((s) => s.studentId === me).map((s) => s.threadId));
  return {
    enrollments: state.enrollments.filter((e) => e.studentId === me),
    makeupAdjustments: state.makeupAdjustments.filter((a) => a.studentId === me),
    requests: state.requests.filter((r) => r.studentId === me),
    comments: state.comments.filter((c) => mineThreads.has(c.threadId)),
    slots: state.slots.flatMap((s) => {
      if (s.status === "OPEN" || s.studentId === me) return [s];
      if (s.status === "SKIPPED") return [];
      // 다른 레슨생 일정: 시간만 (화면에서 '마감'으로 표시)
      return [{ id: s.id, start: s.start, end: s.end, status: "CONFIRMED" as const, threadId: "" }];
    }),
  };
}
