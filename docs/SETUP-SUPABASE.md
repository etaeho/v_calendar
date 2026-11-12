# Supabase 서버 설정 가이드 (Phase 2)

지금 앱은 브라우저 안에서만 동작하는 **데모 모드**입니다. 이 문서대로 Supabase 프로젝트를 만들면
강사와 레슨생이 각자 이메일로 로그인해 **같은 일정 데이터를 함께** 쓸 수 있습니다.

전문가가 아니어도 따라 할 수 있도록 순서대로 적었습니다. 30분~1시간 정도 걸립니다.

---

## 0. 구조 한눈에 보기

```
브라우저 (GitHub Pages, Next.js 정적 사이트)
  │  ① 이메일 로그인 (Supabase Auth: 매직 링크 / 6자리 코드)
  │  ② POST /functions/v1/lesson-api  { op: ... }   ← 모든 읽기·쓰기
  │  ③ Realtime 구독: studio_events INSERT          ← "바뀌었어요" 신호만
  ▼
Supabase
  ├─ Edge Function lesson-api       : 브라우저와 똑같은 규칙 코드(lib/*.ts)를 서버에서 실행
  ├─ Edge Function notify-dispatch  : 쌓인 알림을 카카오 알림톡(Solapi)으로 발송 (선택)
  └─ Postgres
       studios / members / studio_state(JSONB 문서 + version) / studio_events / notifications
```

- 스튜디오(강사 1명 + 레슨생들)의 전체 일정 상태(`LessonState`)를 **JSONB 문서 하나**로 저장합니다.
- 브라우저는 데이터베이스에 직접 접근하지 않습니다. 모든 동작은 `lesson-api` 함수를 거치고,
  함수가 권한을 확인한 뒤 **레슨생에게는 자기 정보만** 잘라서 내려 줍니다.
- 브라우저가 직접 읽을 수 있는 것은 `studio_events`(자기 스튜디오의 "버전이 바뀌었음" 신호)뿐입니다.

관련 파일

| 파일 | 내용 |
| --- | --- |
| `supabase/migrations/0001_init.sql` | 테이블, 보안(RLS), Realtime, 서버 전용 SQL 함수 |
| `supabase/functions/lesson-api/` | API 함수 (Deno) |
| `supabase/functions/notify-dispatch/` | 알림톡 발송 함수 (Deno) |
| `supabase/functions/_shared/` | 공유 코드 복사본 — **직접 고치지 말 것** (`npm run supabase:shared` 로 생성) |
| `lib/server/lesson-api-core.ts` | API 동작의 원본 (Node 테스트 대상) |
| `lib/server/solapi.ts` | 알림톡 요청 만들기·서명 원본 |
| `scripts/sync-supabase-shared.mjs` | `lib/…` → `supabase/functions/_shared/` 복사 스크립트 |

---

## 1. Supabase 프로젝트 만들기

1. <https://supabase.com> 에 가입하고 **New project** 를 누릅니다.
2. 이름: 아무거나 (예: `v-calendar`), **Region: Northeast Asia (Seoul)** 을 고릅니다.
3. 데이터베이스 비밀번호를 정하고 안전한 곳에 적어 둡니다.
4. 만들어지면 **Project Settings → API** (또는 *Data API / API Keys*) 에서 다음 두 값을 확인합니다.
   - **Project URL** — 예: `https://abcdefghijkl.supabase.co`
     (`abcdefghijkl` 부분이 *project ref* 입니다)
   - **anon / publishable key** — 브라우저에 넣어도 되는 공개 키
   - ⚠️ `service_role` / secret 키는 **절대** 브라우저나 GitHub 에 넣지 마세요. Edge Function 에는 자동으로 들어갑니다.

## 2. 데이터베이스 만들기 (마이그레이션)

둘 중 편한 방법 하나만 하면 됩니다.

**방법 A — 웹 화면(SQL Editor)**

1. 대시보드 왼쪽 **SQL Editor → New query**
2. `supabase/migrations/0001_init.sql` 파일 내용을 전부 복사해 붙여 넣고 **Run**
3. `Success. No rows returned` 가 나오면 완료

**방법 B — Supabase CLI** (함수 배포에도 CLI 가 필요하므로 이 방법을 추천)

```bash
npx supabase login                       # 브라우저로 로그인
npx supabase link --project-ref <project ref>
npx supabase db push                     # supabase/migrations/ 의 SQL 적용
```

## 3. 로그인(이메일) 설정

1. **Authentication → Sign In / Providers → Email** 이 켜져 있는지 확인합니다.
   (매직 링크와 6자리 코드(OTP) 로그인이 모두 이 설정을 씁니다. 비밀번호는 쓰지 않습니다.)
2. **Authentication → URL Configuration**
   - **Site URL**: `https://etaeho.github.io/v_calendar/`
   - **Redirect URLs** 에 추가:
     - `https://etaeho.github.io/v_calendar/**`
     - `http://localhost:3000/**`
3. (선택) 휴대폰에서 메일 앱과 브라우저가 달라 링크가 불편하면,
   **Authentication → Emails → Magic Link** 템플릿에 `{{ .Token }}` 을 넣어 6자리 코드로 로그인하게 할 수 있습니다
   (앱의 로그인 화면이 코드 입력을 지원해야 합니다).
4. ⚠️ Supabase 기본 메일 발송은 **시간당 몇 통**으로 제한되어 있습니다. 실제 레슨생들이 쓰기 시작하면
   **Authentication → Emails → SMTP Settings** 에서 외부 메일 서비스(Resend, SendGrid 등)를 연결하세요.

## 4. Edge Function 배포

```bash
npm run supabase:shared        # lib/ 의 최신 규칙 코드를 supabase/functions/_shared/ 로 복사

# 시크릿(환경 변수) 설정 — 한 번만
npx supabase secrets set TZ=Asia/Seoul
npx supabase secrets set ALLOWED_ORIGINS=https://etaeho.github.io,http://localhost:3000
npx supabase secrets set DISPATCH_SECRET=$(openssl rand -hex 24)   # 알림톡 발송기 호출용 비밀값

# 배포 (verify_jwt=false 는 supabase/config.toml 에 들어 있음)
npx supabase functions deploy lesson-api
npx supabase functions deploy notify-dispatch
```

- `ALLOWED_ORIGINS` 는 **origin** (주소의 `https://도메인[:포트]` 부분)만 씁니다. `/v_calendar/` 같은 경로는 붙이지 않습니다.
- `TZ=Asia/Seoul` 은 **필수**입니다. 레슨 시각("19:00")과 공휴일 판정이 모두 한국 시간 기준이라서,
  서버 시간대가 다르면 함수가 일부러 `SERVER_TZ` 오류를 냅니다.
- 규칙 코드(`lib/lesson-machine.ts` 등)를 고칠 때마다 `npm run supabase:shared` → `functions deploy lesson-api` 를 다시 하세요.
  `npm run supabase:shared -- --check` 는 복사본이 최신인지 검사만 합니다 (CI 에 넣기 좋음).

**배포 확인**

```bash
curl -s -X POST https://<project ref>.supabase.co/functions/v1/lesson-api \
  -H 'Content-Type: application/json' -d '{"op":"me"}'
```

- `{"ok":false,"error":{"code":"UNAUTHENTICATED",...}}` → 정상 (로그인 토큰이 없으니 당연한 응답)
- `{"ok":false,"error":{"code":"SERVER_TZ",...}}` → `TZ` 시크릿을 확인하고 함수를 다시 배포하세요.

## 5. 프론트엔드(웹사이트)에 연결 정보 넣기

프론트엔드는 다음 두 값만 필요합니다.

| 이름 | 값 |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | 1단계의 Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 1단계의 anon / publishable key |

- **GitHub Pages 배포용**: GitHub 저장소 → **Settings → Secrets and variables → Actions → New repository secret** 에
  위 두 이름으로 등록합니다. (`.github/workflows/deploy.yml` 이 빌드할 때 이 값을 넘기도록 이미 설정되어 있습니다.)
- **내 컴퓨터에서 개발할 때**: 저장소 루트에 `.env.local` 파일을 만들고 두 줄을 적습니다 (`.env*` 는 git 에 올라가지 않음).

  ```
  NEXT_PUBLIC_SUPABASE_URL=https://abcdefghijkl.supabase.co
  NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
  ```

두 값이 없으면 앱은 지금처럼 데모 모드로 동작합니다.

## 6. 강사로 시작하기

1. 사이트에 접속해 **강사 본인 이메일**로 로그인합니다.
2. 처음 로그인하면 아직 스튜디오가 없으므로 앱이 "스튜디오 만들기" 화면을 보여 줍니다
   (서버 API `bootstrap`). 스튜디오 이름과 강사 이름을 넣으면 끝입니다.
3. 그 계정이 이 스튜디오의 강사가 됩니다. (계정 하나는 스튜디오 하나에만 속할 수 있습니다.)

## 7. 레슨생 초대하기

1. 강사 화면에서 레슨생의 **이름과 이메일**(필요하면 휴대폰 번호)을 추가합니다 (서버 API `addMember`).
2. 레슨생에게 "이 이메일로 로그인하세요" 라고 알려 줍니다.
3. 레슨생이 **그 이메일**로 처음 로그인하면 자동으로 스튜디오에 연결됩니다. 별도 초대 링크는 없습니다.
   - 이메일 대소문자는 구분하지 않습니다.
   - 다른 이메일로 로그인하면 "등록되지 않은 계정"(`NOT_MEMBER`)으로 보입니다.

## 8. (선택) 카카오 알림톡 보내기 — Solapi

요청·승인·메시지가 생길 때마다 앱 안 알림(종 아이콘)은 항상 쌓입니다. 여기에 더해 카카오 알림톡으로도 보내려면:

1. **Solapi 가입** (<https://solapi.com>) → 충전 → **API Key / API Secret** 발급
2. **카카오톡 채널** 을 만들고 Solapi 에 연동 → 채널의 **pfId** 확인
3. Solapi 에서 **알림톡 템플릿**을 등록하고 카카오 검수를 받습니다. 본문에 변수 두 개를 그대로 쓰세요.

   ```
   [바이올린 레슨 알림]
   #{제목}
   #{내용}
   ```

   알림 종류별로 다른 템플릿을 써도 되고, 하나로 같이 써도 됩니다.
   - `REQUEST` — 보강·변경 요청/제안이 왔을 때
   - `RESOLVED` — 요청이 승인·거절·취소·만료되었을 때
   - `MESSAGE` — 레슨 메시지가 왔을 때
4. 시크릿 등록

   ```bash
   npx supabase secrets set SOLAPI_API_KEY=... SOLAPI_API_SECRET=... SOLAPI_PFID=...
   npx supabase secrets set SOLAPI_TEMPLATE_DEFAULT=<템플릿 id>          # 공통 템플릿
   # 종류별로 다르게 하려면: SOLAPI_TEMPLATE_REQUEST / SOLAPI_TEMPLATE_RESOLVED / SOLAPI_TEMPLATE_MESSAGE
   # (선택) SOLAPI_SENDER=0212345678  — Solapi 에 등록된 발신번호. 문자 대체발송은 끄고 보냅니다.
   ```

5. 받는 사람 조건: 멤버에 **휴대폰 번호**가 있고 **알림톡 수신 동의(`kakao_opt_in`)** 가 켜져 있어야 합니다.
   - 레슨생 본인이 앱에서 동의하면 API `updateProfile { phone, kakaoOptIn: true }` 로 저장됩니다.
   - 급하면 SQL Editor 에서: `update members set phone='01012345678', kakao_opt_in=true where email='student@example.com';`
6. **발송기 예약 실행** (5분마다) — SQL Editor 에서 한 번 실행합니다. `<…>` 부분을 바꾸세요.

   ```sql
   create extension if not exists pg_cron;
   create extension if not exists pg_net;

   select vault.create_secret('https://<project ref>.supabase.co', 'project_url');
   select vault.create_secret('<DISPATCH_SECRET 값>', 'dispatch_secret');

   select cron.schedule(
     'notify-dispatch',
     '*/5 * * * *',
     $$
     select net.http_post(
       url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
              || '/functions/v1/notify-dispatch',
       headers := jsonb_build_object(
         'Content-Type', 'application/json',
         'x-dispatch-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'dispatch_secret')
       ),
       body := '{}'::jsonb
     );
     $$
   );
   ```

   (대시보드 **Integrations → Cron** 화면에서 같은 작업을 만들 수도 있습니다. Supabase CLI 에는 함수 예약 명령이 따로 없습니다.)

7. 결과 확인: `notifications` 테이블의 `alimtalk_status` 가 `SENT` / `FAILED` / `SKIPPED` 로 바뀌고,
   `alimtalk_error` 에 이유가 적힙니다. 설정이 없거나 동의하지 않은 사람에게 가는 알림은 `SKIPPED` 입니다.
   하루 넘게 밀린 알림은 보내지 않습니다(`SKIPPED`).

⚠️ **확인되지 않은 부분**: 이 작업 환경에서는 Solapi 개발자 문서(developers.solapi.com)에 접속할 수 없었습니다.
요청 형식(HMAC-SHA256 인증 헤더, `type: "ATA"`, `kakaoOptions { pfId, templateId, variables, disableSms }`,
응답의 `failedMessageList`)은 **Solapi 공식 Node SDK(`solapi@6.1.0`) 소스**와 대조해 맞췄습니다.
엔드포인트는 `https://api.solapi.com/messages/v4/send-many/detail` 을 씁니다 (최신 SDK 는 `…/send-many/fast` 사용).
처음 실제로 보낼 때 본인 번호로 한 건 테스트해 보세요.

## 9. 정리 작업 (선택)

`studio_events` 는 "바뀌었음" 신호라 오래된 행은 필요 없습니다. 매일 지우려면:

```sql
select cron.schedule('prune-studio-events', '17 4 * * *',
  $$ delete from public.studio_events where created_at < now() - interval '7 days' $$);
```

## 10. 비용

- 소규모 스튜디오(강사 1명, 레슨생 수십~200명)는 **Supabase 무료 플랜**으로 충분합니다.
  무료 플랜에는 DB 용량, Edge Function 호출 수, Realtime 동시 접속, 월간 활성 사용자 수 한도가 있습니다
  (정확한 숫자는 <https://supabase.com/pricing> 에서 확인 — 자주 바뀝니다).
- ⚠️ 무료 플랜 프로젝트는 **일정 기간(보통 1주일) 아무도 쓰지 않으면 일시 정지**됩니다. 대시보드에서 다시 켤 수 있지만,
  방학 등으로 오래 쉬는 경우 주의하세요. 꾸준히 쓰면 문제없습니다.
- 메일: 기본 메일 발송은 매우 적은 수만 허용되므로 실제 운영 시 외부 SMTP(무료 한도가 있는 서비스 다수)를 연결하세요.
- 알림톡: Solapi 에 건당 요금이 듭니다 (알림톡 1건에 10원대 — 가격표 확인). 알림톡을 안 쓰면 0원.

## 11. 이 설계의 한계 (알아 두면 좋은 것)

- **문서 하나 방식**: 스튜디오 전체 상태를 JSONB 하나로 저장하므로, 작은 변경도 문서 전체를 다시 씁니다.
  - 레슨생 200명이 1년 내내 주 1회 레슨이면 슬롯이 1만 개 정도, 문서가 수 MB 가 될 수 있습니다.
    그러면 `view` 응답과 저장이 느려집니다. 지난 기록을 보관 테이블로 옮기는 정리 기능이 나중에 필요할 수 있습니다.
  - 강사 화면은 매번 전체 상태를 받습니다 (레슨생은 자기 것 + 다른 사람의 '마감' 시간만).
- **동시 수정**: 두 사람이 거의 동시에 저장하면 한쪽이 버전 충돌을 만나 서버가 자동으로 다시 읽어 재실행합니다 (최대 3회).
  그래도 실패하면 `CONFLICT` 오류 → 앱에서 다시 시도하면 됩니다. 소규모에서는 거의 생기지 않습니다.
- **시간 경과 처리**(응답 없는 요청 만료, 결정 없이 지난 공휴일 레슨 휴강 처리)는 누군가 `view` 나 명령을 호출할 때 반영됩니다.
  만료 알림도 그때 만들어집니다.
- **계정 하나 = 스튜디오 하나**: 한 이메일 계정이 두 스튜디오에 속할 수 없습니다.
- **Realtime 은 신호만**: `studio_events` 에는 버전 번호만 있고 내용은 없습니다. 받으면 `view` 를 다시 부르세요.
- **서버 시간대 의존**: 규칙 코드가 "현지 시간"으로 계산하므로 서버가 반드시 Asia/Seoul 이어야 합니다 (`SERVER_TZ` 검사).
  Supabase Edge Runtime 이 `TZ` 시크릿을 실제로 반영하는지는 이 작업 환경에서 확인하지 못했습니다 —
  4단계의 배포 확인에서 `SERVER_TZ` 가 나오면 알려 주세요 (코드 쪽 대안이 필요합니다).

---

## 부록: lesson-api 요약 (프론트엔드 개발용)

`POST https://<ref>.supabase.co/functions/v1/lesson-api`, 헤더 `Authorization: Bearer <로그인 access token>`,
`Content-Type: application/json`. (`supabase.functions.invoke("lesson-api", { body })` 를 써도 됩니다.)

| 요청 | 성공 응답 |
| --- | --- |
| `{ op:"me" }` | `{ ok, member: { appKey, role, name, studioId, studioName } \| null }` |
| `{ op:"bootstrap", studioName, instructorName }` | `me` 와 같음 (이미 멤버면 `CONFLICT`) |
| `{ op:"view" }` | `{ ok, version, state, members:[{ appKey, role, name }] }` |
| `{ op:"command", command }` | `{ ok, version, state, result:{ created?, conflicts?, removed?, slotId? } }` |
| `{ op:"addMember", name, email, phone? }` (강사) | `{ ok, members }` (중복 이메일 `CONFLICT`) |
| `{ op:"notifications" }` | `{ ok, notifications: AppNotification[] }` (최신 50개) |
| `{ op:"markRead", ids }` | `{ ok, updated }` |
| `{ op:"updateProfile", phone?, kakaoOptIn? }` (확장) | `{ ok }` — 본인 연락처·알림톡 동의 |

- `command` 는 `lib/commands.ts` 의 `Command` 그대로입니다. 행위자는 서버가 로그인 계정으로 정합니다.
- 강사에게 내려가는 `members` 에는 추가로 `email`, `phone`, `linked`(로그인 연결 여부)가 있습니다.
- 실패: `{ ok:false, error:{ code, message } }`
  - `UNAUTHENTICATED`(401), `NOT_MEMBER`(403), `FORBIDDEN`(403), `NOT_FOUND`(404),
    `INVALID_STATE`·`OVERLAP`·`CONFLICT`(409), `INVALID_RANGE`·`BAD_REQUEST`(400), `SERVER_TZ`·`INTERNAL`(500)
- 실시간: `supabase.channel(...).on("postgres_changes", { event:"INSERT", schema:"public", table:"studio_events",
  filter:"studio_id=eq.<studioId>" }, () => view 다시 호출)`. 받은 `version` 이 가진 것보다 크면 다시 불러오면 됩니다.

## 부록: 테스트

```bash
npm test                                   # lib/server/*.test.ts 포함 (테스트가 스스로 TZ=Asia/Seoul 로 설정)
TZ=Asia/Seoul node --test "lib/server/*.test.ts"
npx tsc --noEmit
# Deno 가 있으면 Edge Function 타입 검사:
cd supabase/functions && deno check lesson-api/index.ts notify-dispatch/index.ts
```
