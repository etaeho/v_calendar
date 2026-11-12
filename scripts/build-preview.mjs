/**
 * 앱 전체를 단일 HTML 조각(preview/v-calendar.html)으로 묶는다.
 * Claude Code 의 Artifact 미리보기처럼 정적 파일 하나만 올릴 수 있는 곳에서 테스트하기 위한 빌드.
 * CSS 는 `next build` 가 만든 Tailwind 결과물을 그대로 쓰므로 먼저 `next build` 를 실행한다.
 */
import { build } from "esbuild";
import { execSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

execSync("npx next build", { stdio: "inherit" });

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
const css = walk("out/_next")
  .filter((f) => f.endsWith(".css"))
  .map((f) => readFileSync(f, "utf8"))
  .join("\n");

const result = await build({
  entryPoints: ["scripts/preview-entry.tsx"],
  bundle: true,
  minify: true,
  write: false,
  format: "iife",
  target: "es2020",
  jsx: "automatic",
  tsconfig: "tsconfig.json",
  // 미리보기는 항상 데모 모드: 서버·외부 연동 키(NEXT_PUBLIC_*)는 비워 둔다
  define: {
    "process.env.NODE_ENV": '"production"',
    ...Object.fromEntries(
      [
        "NEXT_PUBLIC_SUPABASE_URL",
        "NEXT_PUBLIC_SUPABASE_ANON_KEY",
        "NEXT_PUBLIC_GOOGLE_CLIENT_ID",
        "NEXT_PUBLIC_KAKAO_JS_KEY",
        "NEXT_PUBLIC_KAKAO_REDIRECT_URI",
      ].map((k) => [`process.env.${k}`, '""']),
    ),
  },
  // 위에 없는 process.env 접근이 있어도 미리보기가 멈추지 않게
  banner: { js: "var process = globalThis.process || { env: {} };" },
  logOverride: { "module-level-directive": "silent" },
});
const js = result.outputFiles[0].text.replaceAll("</script", "<\\/script");

const html = `<title>V Calendar</title>
<style>${css}
#app{height:100%}</style>
<div id="app"></div>
<script>${js}</script>
`;
mkdirSync("preview", { recursive: true });
writeFileSync("preview/v-calendar.html", html);
console.log(`preview/v-calendar.html ${(html.length / 1024).toFixed(0)} KB`);
