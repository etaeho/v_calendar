import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Actor, LessonState } from "../types/calendar";
import { runCommand, type Command } from "./commands.ts";
import { LessonError, type MachineContext } from "./lesson-machine.ts";
import { visibleState } from "./visibility.ts";

const teacher: Actor = { userId: "t1", role: "INSTRUCTOR" };
const s1: Actor = { userId: "s1", role: "STUDENT" };
const s2: Actor = { userId: "s2", role: "STUDENT" };
const local = (y: number, m: number, d: number, h = 0) => new Date(y, m - 1, d, h).toISOString();
const NOW = local(2026, 11, 12, 9);
const ctx = (): MachineContext => {
  let n = 0;
  return { now: () => NOW, id: (p) => `${p}-${++n}` };
};
const noHoliday = () => undefined;
const empty = (): LessonState => ({ enrollments: [], makeupAdjustments: [], slots: [], requests: [], comments: [] });
const run = (st: LessonState, a: Actor, cmd: Command, c = ctx()) => runCommand(st, a, cmd, c, noHoliday);
// JSON 왕복: 서버로 보내도 같은 결과가 나와야 한다
const wire = (cmd: Command): Command => JSON.parse(JSON.stringify(cmd));

describe("명령 계층", () => {
  it("JSON 으로 주고받은 명령으로 전체 흐름이 동작한다", () => {
    const c = ctx();
    let st = run(empty(), teacher, wire({
      type: "registerEnrollment",
      input: { studentId: "s1", startDate: "2026-11-13", endDate: "2026-12-31", times: [{ weekday: 2, time: "19:00", durationMin: 60 }], weeks: [1, 2, 3, 4], changeDeadlineHours: 24 },
    }), c).state;
    st = run(st, teacher, wire({ type: "registerEnrollment", input: { studentId: "s2", startDate: "2026-11-13", endDate: "2026-12-31", times: [{ weekday: 1, time: "18:00", durationMin: 60 }], weeks: [1, 2, 3, 4], changeDeadlineHours: 24 } }), c).state;
    const open = run(st, teacher, wire({ type: "createOpenSlot", start: local(2026, 11, 20, 15), end: local(2026, 11, 20, 16) }), c);
    st = open.state;
    st = run(st, s1, wire({ type: "requestBooking", slotId: open.slotId!, message: "보강 부탁드려요" }), c).state;
    st = run(st, teacher, wire({ type: "approve", requestId: st.requests.at(-1)!.id }), c).state;
    assert.equal(st.slots.find((s) => s.id === open.slotId)!.status, "CONFIRMED");
    st = run(st, s1, wire({ type: "addComment", slotId: open.slotId!, body: "감사합니다" }), c).state;
    // 고정 시간 변경 요청 → 레슨생 동의 (approve 명령이 SCHEDULE 로 분기)
    const enrollmentId = st.enrollments[0].id;
    st = run(st, teacher, wire({ type: "requestScheduleChange", enrollmentId, schedule: { times: [{ weekday: 4, time: "19:00", durationMin: 60 }], weeks: [1, 2, 3, 4] }, fromDate: "2026-12-01" }), c).state;
    const r = run(st, s1, wire({ type: "approve", requestId: st.requests.at(-1)!.id }), c);
    assert.equal(r.created, 4);
    assert.throws(() => run(r.state, s2, wire({ type: "adjustMakeup", studentId: "s1", delta: 1, reason: "x" }), c), LessonError);
  });

  it("레슨생에게 보내는 상태에는 다른 레슨생 정보가 없다", () => {
    const c = ctx();
    let st = run(empty(), teacher, { type: "registerEnrollment", input: { studentId: "s1", startDate: "2026-11-13", endDate: "2026-11-30", times: [{ weekday: 2, time: "19:00", durationMin: 60 }], weeks: [1, 2, 3, 4], changeDeadlineHours: 0, fee: 200000 } }, c).state;
    st = run(st, teacher, { type: "registerEnrollment", input: { studentId: "s2", startDate: "2026-11-13", endDate: "2026-11-30", times: [{ weekday: 1, time: "18:00", durationMin: 60 }], weeks: [1, 2, 3, 4], changeDeadlineHours: 0, fee: 300000 } }, c).state;
    const s2Lesson = st.slots.find((s) => s.studentId === "s2")!;
    st = run(st, s2, { type: "addComment", slotId: s2Lesson.id, body: "비밀 메시지" }, c).state;
    st = run(st, teacher, { type: "adjustMakeup", studentId: "s2", delta: 1, reason: "결석" }, c).state;
    const v = visibleState(st, s1);
    const text = JSON.stringify(v);
    assert.ok(!text.includes("s2"));
    assert.ok(!text.includes("비밀 메시지"));
    assert.ok(!text.includes("300000"));
    assert.equal(v.slots.filter((s) => !s.studentId).length, st.slots.filter((s) => s.studentId === "s2").length);
    assert.deepEqual(visibleState(st, teacher), st);
  });
});
