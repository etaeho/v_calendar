// 서버 모드 e2e: 실제 Next 빌드 + 서버 핸들러(lesson-api-core, 메모리 저장소). 로그인만 세션 주입으로 대체.
// 실행:
//   NEXT_PUBLIC_SUPABASE_URL=https://test.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=anon-test npx next build
//   (cd out && python3 -m http.server 4321) &
//   TZ=Asia/Seoul node e2e/server-mode.mjs        # playwright 가 전역 설치면 PLAYWRIGHT_DIR=$(npm root -g)/ 지정
import { createRequire } from "node:module";
const { chromium, devices } = createRequire(process.env.PLAYWRIGHT_DIR ?? import.meta.url)("playwright");
import { handle } from "../lib/server/lesson-api-core.ts";
import { MemoryStore } from "../lib/server/memory-store.ts";
process.env.TZ = "Asia/Seoul";
const BASE = process.env.BASE_URL ?? "http://localhost:4321";
const store = new MemoryStore();
const USERS = {
  "tok-teacher": { userId: "u-teacher", email: "teacher@example.com" },
  "tok-student": { userId: "u-student", email: "haeun@example.com" },
  "tok-stranger": { userId: "u-x", email: "nobody@example.com" },
};
const NOW = "2026-11-12T01:00:00.000Z"; // 10:00 KST
const ok = (n, c, x = "") => (c || (process.exitCode = 1), console.log((c ? "PASS" : "FAIL") + " " + n + (x ? " — " + x : "")));
const calls = [];
async function page(browser, token, mobile = false) {
  const ctx = await browser.newContext({ ...(mobile ? devices["iPhone 13"] : { viewport: { width: 1440, height: 900 } }), timezoneId: "Asia/Seoul" });
  const p = await ctx.newPage();
  p.errs = [];
  p.on("pageerror", (e) => p.errs.push(e.message));
  await p.clock.install({ time: new Date(NOW) });
  await p.route("https://test.supabase.co/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.pathname === "/functions/v1/lesson-api") {
      if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*" } });
      const tok = (req.headers()["authorization"] ?? "").replace("Bearer ", "");
      const body = JSON.parse(req.postData() ?? "{}");
      calls.push(body.op + (body.command ? ":" + body.command.type : ""));
      const res = await handle(body, USERS[tok] ?? null, store, () => NOW);
      return route.fulfill({ status: res.status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(res.json) });
    }
    return route.fulfill({ status: 404, body: "{}" }); // auth/realtime 등은 사용하지 않음
  });
  // supabase-js 저장 세션 주입 (로그인 완료 상태)
  const u = USERS[token];
  const session = { access_token: token, refresh_token: "r", token_type: "bearer", expires_in: 3600 * 24 * 365, expires_at: Math.floor(Date.parse(NOW) / 1000) + 3600 * 24 * 365, user: { id: u.userId, email: u.email, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: NOW } };
  await p.addInitScript((s) => localStorage.setItem("sb-test-auth-token", JSON.stringify(s)), session);
  await p.goto(BASE + "/");
  return p;
}
const toast = async (p) => { await p.waitForTimeout(400); return (await p.locator("[aria-live] > div").textContent().catch(() => "")) || ""; };
const browser = await chromium.launch();
try {
  // 1) 강사: 레슨실 만들기 → 레슨생 초대 → 수강 등록 → 빈 슬롯
  const t = await page(browser, "tok-teacher");
  await t.getByLabel("레슨실 이름").fill("정유진 바이올린");
  await t.getByLabel(/내 이름/).fill("정유진");
  await t.getByRole("button", { name: "레슨실 만들고 시작하기" }).click();
  await t.waitForSelector("h1");
  ok("instructor enters app", (await t.locator("header").innerText()).includes("정유진 바이올린"));
  await t.getByRole("tab", { name: "레슨생 관리" }).click();
  await t.getByRole("button", { name: "레슨생 초대" }).click();
  await t.getByLabel("이름").fill("김하은");
  await t.getByLabel("로그인 이메일").fill("haeun@example.com");
  await t.getByRole("button", { name: "초대", exact: true }).click();
  console.log("  ", await toast(t));
  const card = t.locator("article").filter({ has: t.locator("h3", { hasText: "김하은" }) });
  ok("invited student card", (await card.count()) === 1);
  await card.getByRole("button", { name: "수강 등록" }).click();
  await card.getByLabel("시작일").fill("2026-11-13");
  await card.getByRole("button", { name: "등록", exact: true }).click();
  console.log("  ", await toast(t));
  await t.waitForTimeout(300);
  const st = store.states.values().next().value;
  ok("server saved regular lessons", st.state.slots.filter((s) => s.lessonType === "REGULAR").length >= 6, `version ${st.version}, slots ${st.state.slots.length}`);
  // 빈 슬롯: 주간 보기에서 11/14(토) 15:00 클릭
  await t.getByRole("tab", { name: "주간" }).click();
  const col = t.locator("main .relative.border-l").nth(6);
  await t.locator("main .overflow-auto").first().evaluate((e) => (e.scrollTop = (9 - 7) * 64 - 8));
  const bb2 = await col.boundingBox();
  await t.mouse.click(bb2.x + bb2.width / 2, bb2.y + (15 - 7) * 64 + 5);
  console.log("  ", await toast(t));
  await t.waitForTimeout(300);
  const openSlots = [...store.states.values()][0].state.slots.filter((s) => s.status === "OPEN");
  ok("server has the open slot with server id", openSlots.length === 1, openSlots.map((s) => s.id + " " + s.start).join());

  // 2) 레슨생: 초대 이메일로 로그인 → 자동 연결 → 보강 신청
  const s = await page(browser, "tok-student", true);
  await s.waitForSelector("h1");
  ok("student linked by email", (await s.locator("header").innerText()).includes("김하은"));
  await s.getByRole("button", { name: /^11월 14일/ }).first().tap();
  await s.locator("main li button", { hasText: "신청 가능" }).first().tap();
  const sheet = await s.locator("aside[aria-label]").innerText();
  ok("student sees extra-lesson notice (0 makeups)", sheet.includes("추가 레슨"), sheet.replace(/\n/g, " | ").slice(0, 160));
  await s.locator("aside[aria-label]").getByRole("button", { name: /추가 레슨으로 신청|보강 신청/ }).tap();
  console.log("  ", await toast(s));
  await s.waitForTimeout(300);
  ok("student view has no instructor-only data", !JSON.stringify(await s.evaluate(() => document.body.innerText)).includes("teacher@example.com"));

  // 3) 강사: 새로 고침(실시간 대신) → 알림 → 승인
  await t.reload(); await t.waitForSelector("h1");
  const bell = await t.getByRole("button", { name: /알림/ }).first().getAttribute("aria-label");
  ok("instructor notified from server", bell.includes("1개"), bell);
  await t.getByRole("button", { name: /알림/ }).first().click();
  await t.locator("aside[aria-label] li button").first().click();
  await t.getByRole("button", { name: "승인", exact: true }).click();
  console.log("  ", await toast(t));
  await t.waitForTimeout(300);
  const after = [...store.states.values()][0].state;
  ok("server: booking approved", after.requests.at(-1)?.status === "APPROVED");

  // 4) 초대받지 않은 사용자
  const x = await page(browser, "tok-stranger");
  await x.waitForTimeout(800);
  ok("stranger sees not-invited notice", (await x.locator("body").innerText()).includes("아직 등록된 레슨실이 없습니다"));
  // 5) 규칙 위반은 서버가 거부 (레슨생이 강사 기능 호출)
  const res = await handle({ op: "command", command: { type: "adjustMakeup", studentId: [...store.states.values()][0].state.enrollments[0].studentId, delta: 1, reason: "r" } }, USERS["tok-student"], store, () => NOW);
  ok("server rejects forbidden command", res.status === 403, JSON.stringify(res.json).slice(0, 100));
  ok("no page errors", [t, s, x].every((p) => p.errs.length === 0), [t, s, x].flatMap((p) => p.errs).join(";"));
  console.log("  api calls:", calls.join(", "));
} catch (e) {
  console.error("CRASH", e.message.slice(0, 600));
  process.exitCode = 1;
} finally {
  await browser.close();
}
