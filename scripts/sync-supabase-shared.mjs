#!/usr/bin/env node
/**
 * 도메인 코드(브라우저와 같은 규칙)를 Supabase Edge Function(Deno)용으로 복사한다.
 *
 *   npm run supabase:shared          # supabase/functions/_shared/ 갱신
 *   npm run supabase:shared -- --check   # 복사본이 최신인지 검사만 (다르면 exit 1, CI 용)
 *
 * import 경로를 Deno 형식(명시적 .ts 확장자의 같은 폴더 상대 경로)으로 바꾼다.
 *   "../types/calendar"  → "./calendar.ts"
 *   "./lesson-machine.ts" → "./lesson-machine.ts"
 *   "../../data/holidays-kr.json" → "./holidays-kr.json"
 * 목록에 없는 파일이나 npm 패키지를 import 하면 실패한다 (Edge Function 에서 깨지지 않도록).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "supabase/functions/_shared");

/** [원본, 복사본 이름] */
const FILES = [
  ["types/calendar.ts", "calendar.ts"],
  ["lib/lesson-machine.ts", "lesson-machine.ts"],
  ["lib/enrollment.ts", "enrollment.ts"],
  ["lib/commands.ts", "commands.ts"],
  ["lib/visibility.ts", "visibility.ts"],
  ["lib/notifications.ts", "notifications.ts"],
  ["lib/server/holidays.ts", "holidays.ts"],
  ["lib/server/lesson-api-core.ts", "lesson-api-core.ts"],
  ["lib/server/solapi.ts", "solapi.ts"],
  ["data/holidays-kr.json", "holidays-kr.json"],
];

/** 확장자 없는 절대 경로 → 복사본 이름 */
const targetOf = new Map(
  FILES.map(([src, out]) => [join(root, src).replace(/\.(ts|tsx)$/, ""), out]),
);

function rewriteSpecifier(spec, srcFile) {
  let abs;
  if (spec.startsWith("@/")) abs = join(root, spec.slice(2));
  else if (spec.startsWith(".")) abs = resolve(dirname(srcFile), spec);
  else throw new Error(`${relative(root, srcFile)}: 패키지 import "${spec}" 는 Edge Function 공유 코드에 쓸 수 없습니다.`);
  const key = abs.replace(/\.(ts|tsx)$/, "");
  const out = targetOf.get(key);
  if (!out) throw new Error(`${relative(root, srcFile)}: "${spec}" 가 복사 목록(FILES)에 없습니다.`);
  return `./${out}`;
}

function transform(src, out) {
  const srcFile = join(root, src);
  const text = readFileSync(srcFile, "utf8");
  if (out.endsWith(".json")) return text;
  // import ... from "x" / export ... from "x" / import "x"
  const body = text.replace(
    /(\b(?:import|export)\b[^'";]*?\bfrom\s*|\bimport\s*)(["'])([^"']+)\2/g,
    (_m, head, quote, spec) => `${head}${quote}${rewriteSpecifier(spec, srcFile)}${quote}`,
  );
  const header =
    `// AUTO-GENERATED from ${src} by scripts/sync-supabase-shared.mjs — DO NOT EDIT.\n` +
    `// 원본을 고친 뒤 \`npm run supabase:shared\` 로 다시 만드세요.\n`;
  return header + body;
}

const check = process.argv.includes("--check");
mkdirSync(outDir, { recursive: true });
let stale = 0;
for (const [src, out] of FILES) {
  const next = transform(src, out);
  const dest = join(outDir, out);
  const cur = existsSync(dest) ? readFileSync(dest, "utf8") : null;
  if (cur === next) continue;
  stale += 1;
  if (check) console.error(`out of date: supabase/functions/_shared/${out} (from ${src})`);
  else {
    writeFileSync(dest, next);
    console.log(`wrote supabase/functions/_shared/${out}`);
  }
}
if (check && stale > 0) {
  console.error("`npm run supabase:shared` 를 실행하세요.");
  process.exit(1);
}
if (!check) console.log(stale === 0 ? "already up to date" : `${stale} file(s) updated`);
