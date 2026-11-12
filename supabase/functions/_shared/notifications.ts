// AUTO-GENERATED from lib/notifications.ts by scripts/sync-supabase-shared.mjs — DO NOT EDIT.
// 원본을 고친 뒤 `npm run supabase:shared` 로 다시 만드세요.
/**
 * 알림: 명령 실행 전후 상태를 비교해 누구에게 무엇을 알릴지 계산한다 (순수 함수).
 * - 데모 모드: 브라우저 메모리에 쌓고 종 아이콘·배지로 표시
 * - 서버 모드: 같은 함수로 notifications 테이블에 쌓고, 알림톡 발송기가 꺼내 보낸다
 */
import type { Actor, LessonState, ScheduleRequest } from "./calendar.ts";

export type NotificationKind = "REQUEST" | "RESOLVED" | "MESSAGE";

export interface AppNotification {
  id: string;
  /** 받는 사람 (강사 id 또는 레슨생 id) */
  recipient: string;
  kind: NotificationKind;
  title: string;
  body: string;
  slotId?: string;
  requestId?: string;
  createdAt: string;
  readAt?: string;
}

const KIND_LABEL: Record<ScheduleRequest["kind"], string> = {
  BOOKING: "보강",
  CHANGE: "일정 변경",
  HOLIDAY: "공휴일 레슨 결정",
  DEFER: "보강으로 미루기",
  SCHEDULE: "고정 시간 변경",
};

const fmt = (iso: string) => {
  const d = new Date(iso);
  const days = ["일", "월", "화", "수", "목", "금", "토"];
  return `${d.getMonth() + 1}/${d.getDate()}(${days[d.getDay()]}) ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** 요청을 보낸 쪽 / 받은 쪽 */
const requesterOf = (r: ScheduleRequest, instructorId: string) =>
  r.requestedBy === "INSTRUCTOR" ? instructorId : r.studentId;
const responderOf = (r: ScheduleRequest, instructorId: string) =>
  r.requestedBy === "INSTRUCTOR" ? r.studentId : instructorId;

export function deriveNotifications(
  before: LessonState,
  after: LessonState,
  actor: Actor,
  instructorId: string,
  names: (id: string) => string,
  now: string,
  id: (prefix: string) => string,
): AppNotification[] {
  const out: AppNotification[] = [];
  const prev = new Map(before.requests.map((r) => [r.id, r]));
  const push = (n: Omit<AppNotification, "id" | "createdAt">) => {
    // 자기 자신에게는 알리지 않는다
    if (n.recipient && n.recipient !== actor.userId) out.push({ ...n, id: id("ntf"), createdAt: now });
  };
  const who = actor.role === "INSTRUCTOR" ? "선생님" : names(actor.userId);

  for (const r of after.requests) {
    const old = prev.get(r.id);
    const label = KIND_LABEL[r.kind];
    if (!old && r.status === "PENDING") {
      push({
        recipient: responderOf(r, instructorId),
        kind: "REQUEST",
        title: `${who}의 ${label} ${r.requestedBy === "INSTRUCTOR" ? "제안" : "요청"}`,
        body: `${fmt(r.toStart)} · 응답이 필요합니다${r.message ? ` — "${r.message}"` : ""}`,
        slotId: r.toSlotId,
        requestId: r.id,
      });
    } else if (old?.status === "PENDING" && r.status !== "PENDING") {
      const result =
        r.status === "APPROVED" ? "승인됨" : r.status === "REJECTED" ? "거절됨" : r.status === "CANCELLED" ? "취소됨" : "만료됨";
      // 승인·거절은 요청한 쪽에, 요청자 본인의 취소는 받는 쪽에 알린다
      const recipient =
        r.status === "CANCELLED" && actor.userId === requesterOf(r, instructorId)
          ? responderOf(r, instructorId)
          : requesterOf(r, instructorId);
      push({
        recipient,
        kind: "RESOLVED",
        title: `${label} ${result}`,
        body: `${fmt(r.toStart)}${r.rejectReason ? ` · 사유: ${r.rejectReason}` : ""}`,
        slotId: r.toSlotId,
        requestId: r.id,
      });
    }
  }

  const seen = new Set(before.comments.map((c) => c.id));
  for (const c of after.comments) {
    if (seen.has(c.id) || c.kind !== "USER" || c.authorId !== actor.userId) continue;
    const slot = after.slots.find((s) => s.threadId === c.threadId);
    if (!slot?.studentId) continue;
    push({
      recipient: actor.role === "INSTRUCTOR" ? slot.studentId : instructorId,
      kind: "MESSAGE",
      title: `${who}의 메시지`,
      body: c.body.length > 60 ? `${c.body.slice(0, 60)}…` : c.body,
      slotId: slot.id,
    });
  }
  return out;
}
