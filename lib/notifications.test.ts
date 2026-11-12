import assert from "node:assert/strict";
import { it } from "node:test";
import type { Actor, LessonState } from "../types/calendar";
import { runCommand } from "./commands.ts";
import { deriveNotifications } from "./notifications.ts";

const t: Actor = { userId: "t1", role: "INSTRUCTOR" };
const s1: Actor = { userId: "s1", role: "STUDENT" };
const local = (m: number, d: number, h: number) => new Date(2026, m - 1, d, h).toISOString();
const NOW = local(11, 12, 9);
let n = 0;
const ctx = { now: () => NOW, id: (p: string) => `${p}-${++n}` };
const names = (id: string) => ({ s1: "김하은", t1: "정유진" })[id] ?? id;

it("요청·응답·메시지마다 상대방에게 알림이 간다", () => {
  let st: LessonState = { enrollments: [], makeupAdjustments: [], slots: [], requests: [], comments: [] };
  st = runCommand(st, t, { type: "registerEnrollment", input: { studentId: "s1", startDate: "2026-11-13", endDate: "2026-11-30", times: [{ weekday: 2, time: "19:00", durationMin: 60 }], weeks: [1, 2, 3, 4], changeDeadlineHours: 0 } }, ctx, () => undefined).state;
  const open = runCommand(st, t, { type: "createOpenSlot", start: local(11, 20, 15), end: local(11, 20, 16) }, ctx, () => undefined);
  const step = (a: Actor, cmd: Parameters<typeof runCommand>[2]) => {
    const before = open.state === st ? st : st;
    const after = runCommand(before, a, cmd, ctx, () => undefined).state;
    const ns = deriveNotifications(before, after, a, "t1", names, NOW, ctx.id);
    st = after;
    return ns;
  };
  st = open.state;
  let ns = step(s1, { type: "requestBooking", slotId: open.slotId!, message: "부탁드려요" });
  assert.equal(ns.length, 1);
  assert.equal(ns[0].recipient, "t1");
  assert.equal(ns[0].kind, "REQUEST");
  assert.match(ns[0].title, /김하은의 보강 요청/);
  ns = step(t, { type: "approve", requestId: st.requests[0].id });
  assert.deepEqual(ns.map((x) => [x.recipient, x.kind, x.title]), [["s1", "RESOLVED", "보강 승인됨"]]);
  ns = step(t, { type: "addComment", slotId: open.slotId!, body: "그날 봐요" });
  assert.deepEqual(ns.map((x) => [x.recipient, x.kind]), [["s1", "MESSAGE"]]);
  // 강사 제안을 강사가 직접 취소하면 레슨생에게 알림
  const lesson = st.slots.find((s) => s.lessonType === "REGULAR" && s.start > NOW)!;
  ns = step(t, { type: "proposeDefer", slotId: lesson.id });
  assert.equal(ns[0].recipient, "s1");
  ns = step(t, { type: "cancel", requestId: st.requests.at(-1)!.id });
  assert.deepEqual(ns.map((x) => [x.recipient, x.title]), [["s1", "보강으로 미루기 취소됨"]]);
});
