# 구글 · 카카오 캘린더 연결 설정 가이드

이 문서는 V Calendar 를 **실제 구글 캘린더 / 카카오 톡캘린더**와 연결하는 방법을 처음 해 보는 분도 따라 할 수 있게 설명합니다.
설정을 하지 않아도 앱은 그대로 동작합니다. 이때 구글/카카오 일정은 **가상(데모) 일정**으로 보입니다.

> 요약
> - 구글: 클라이언트 ID 하나만 GitHub 에 등록하면 끝 (서버 불필요)
> - 카카오: JavaScript 키 + Redirect URI 를 GitHub 에, REST API 키는 **Supabase 함수 비밀값**에 등록
> - 연결 버튼은 반드시 **사용자가 직접 클릭**해서 눌러야 합니다 (팝업/페이지 이동이 필요하기 때문)

---

## 0. 어디서 실제 연동이 되나요?

| 실행 위치 | 구글 | 카카오 | 이유 |
| --- | --- | --- | --- |
| claude.ai 미리보기 (단일 HTML) | 가상 일정 | 가상 일정 | 미리보기는 보안 정책(CSP)상 외부 스크립트(구글/카카오 로그인)를 불러올 수 없고, 환경 변수도 들어가지 않습니다 |
| GitHub Pages (`https://etaeho.github.io/v_calendar/`) | **실제** | **실제** | 아래 설정을 마친 경우 |
| 내 컴퓨터 `npm run dev` (`http://localhost:3000`) | **실제** | **실제** | `.env.local` 에 값을 넣은 경우 |

앱 안에서는 `integrationStatus()` 가 제공자별로 `real`(실제) / `mock`(가상) 과 그 이유를 알려 줍니다.

---

## 1. 구글 캘린더 (읽기 + 레슨 자동 등록)

### 1-1. 구글 클라우드 프로젝트 만들기
1. <https://console.cloud.google.com/> 에 구글 계정으로 로그인합니다.
2. 상단의 프로젝트 선택 → **새 프로젝트** → 이름 예: `v-calendar` → 만들기.

### 1-2. Google Calendar API 사용 설정
1. 왼쪽 메뉴 **API 및 서비스 → 라이브러리**.
2. `Google Calendar API` 검색 → **사용(Enable)**.
   - 이걸 빼먹으면 앱에서 "Google Calendar API 가 사용 설정되지 않았습니다" 오류가 납니다.

### 1-3. OAuth 동의 화면 (Google Auth Platform)
메뉴 이름은 시기에 따라 **OAuth 동의 화면** 또는 **Google 인증 플랫폼(Branding / Audience / Data Access)** 으로 보입니다.
1. 사용자 유형(Audience): **외부(External)**.
2. 앱 이름, 지원 이메일, 개발자 연락처 이메일 입력.
3. 승인된 도메인: `etaeho.github.io` (선택).
4. **범위(Data Access) 추가**: `https://www.googleapis.com/auth/calendar.events`
   ("캘린더의 일정 보기 및 수정"). 이 앱은 이 범위 하나만 씁니다.
5. 게시 상태는 **테스트(Testing)** 로 두고, **테스트 사용자**에 강사/레슨생의 구글 이메일을 추가합니다. (최대 100명)
   - 테스트 사용자가 아닌 계정은 로그인할 수 없습니다.
   - `calendar.events` 는 '민감한 범위'라서 모든 사람에게 공개(프로덕션)하려면 구글 검수가 필요합니다. 그 전까지는 "확인되지 않은 앱" 경고가 뜰 수 있는데, 테스트 사용자는 **고급 → 계속**으로 진행할 수 있습니다.

### 1-4. OAuth 클라이언트 ID 만들기
1. **API 및 서비스 → 사용자 인증 정보 → 사용자 인증 정보 만들기 → OAuth 클라이언트 ID** (또는 Google 인증 플랫폼 → Clients).
2. 애플리케이션 유형: **웹 애플리케이션**.
3. **승인된 JavaScript 원본**에 아래 두 개 추가 (끝에 `/` 나 경로를 붙이지 않습니다):
   - `https://etaeho.github.io`
   - `http://localhost:3000`
4. 승인된 리디렉션 URI 는 비워 둡니다. (팝업 방식 토큰 모델이라 필요 없음)
5. 만들기 → `xxxx.apps.googleusercontent.com` 형태의 **클라이언트 ID** 를 복사합니다.
   - 함께 표시되는 **클라이언트 보안 비밀(Client secret)은 절대 어디에도 붙여 넣거나 공유하지 마세요.** 이 앱은 쓰지 않습니다.

### 1-5. GitHub 에 등록
클라이언트 ID 는 브라우저에 그대로 노출되는 **공개 값**이라 비밀이 아니지만, 관리 편의상 Secret 으로 넣습니다.
1. GitHub 저장소 → **Settings → Secrets and variables → Actions → New repository secret**
2. 이름 `NEXT_PUBLIC_GOOGLE_CLIENT_ID`, 값: 복사한 클라이언트 ID.
3. 배포 워크플로(`.github/workflows/deploy.yml`)의 `npm run build` 단계 `env:` 에 다음 줄이 있어야 빌드에 들어갑니다:
   ```yaml
   NEXT_PUBLIC_GOOGLE_CLIENT_ID: ${{ secrets.NEXT_PUBLIC_GOOGLE_CLIENT_ID }}
   ```
4. main 에 푸시(또는 Actions 에서 재실행)하면 배포본에 반영됩니다.

로컬 개발 시에는 저장소 루트에 `.env.local` 파일을 만들고 `NEXT_PUBLIC_GOOGLE_CLIENT_ID=...` 를 넣은 뒤 `npm run dev` 를 다시 시작합니다.

### 1-6. 동작 방식 (알아 두면 좋은 점)
- **연결**: 메뉴의 "구글 캘린더 연결"(또는 동기화) 버튼을 누르면 구글 로그인 팝업이 뜹니다. 팝업이 막히면 주소창의 팝업 차단 아이콘에서 허용하세요.
- 로그인 토큰은 **약 1시간** 유효하고 **메모리에만** 저장됩니다. 새로고침하거나 1시간이 지나면 다시 연결 버튼을 눌러야 합니다.
- **불러오기**: 기본 캘린더(primary)의 오늘 기준 14일 전 ~ 90일 후 일정을 가져옵니다.
- **레슨 자동 등록**: 레슨이 확정되면 연결된 구글 캘린더에 "바이올린 레슨"(보강은 "보강 레슨") 일정이 서울 시간대로 만들어집니다.
  같은 레슨을 여러 번 보내도 일정은 하나만 유지됩니다(앱이 일정에 숨은 표식 `vcalLessonId` 를 붙여 찾아서 수정).
  이 표식이 붙은 일정은 앱 화면에서 '구글 일정'으로 중복 표시되지 않습니다.
- 현재는 **이 브라우저에서 연결한 사람의 캘린더에만** 등록됩니다. (상대방 캘린더 등록은 서버 연동 후 가능)

---

## 2. 카카오 톡캘린더 (읽기 + 레슨 등록)

> ⚠️ **미검증 안내**: 이 연동 코드는 카카오 개발자 문서(developers.kakao.com)에 접속할 수 없는 환경에서 작성되어,
> 톡캘린더 API 의 주소·파라미터·응답 형식, JS SDK 버전(2.7.4)을 공식 문서로 직접 확인하지 못했습니다.
> 처음 연결할 때 브라우저 개발자 도구(F12) → 네트워크 탭에서 `kapi.kakao.com` 요청이 성공하는지 확인해 주세요.

### 2-1. 카카오 디벨로퍼스 앱 만들기
1. <https://developers.kakao.com/> 로그인 → **내 애플리케이션 → 애플리케이션 추가하기**.
2. 앱 이름(예: V Calendar), 회사명 입력 → 저장.
3. **앱 키**(앱 설정 → 앱 키)에서 두 키를 확인합니다.
   - **JavaScript 키**: 브라우저에서 쓰는 공개 키 → GitHub 에 등록
   - **REST API 키**: 토큰 교환용 → **Supabase 함수 비밀값에만** 등록 (GitHub/코드에 넣지 마세요)

### 2-2. 플랫폼(Web) 도메인 등록
**앱 설정 → 플랫폼 → Web → 사이트 도메인**(새 콘솔에서는 "JavaScript SDK 도메인")에 추가:
- `https://etaeho.github.io`
- `http://localhost:3000`

### 2-3. 카카오 로그인 켜기 + Redirect URI
1. **제품 설정 → 카카오 로그인 → 활성화 설정: ON**.
2. **Redirect URI** 등록 (앱이 열리는 주소, 끝의 `/` 까지 정확히):
   - `https://etaeho.github.io/v_calendar/`
   - `http://localhost:3000/`
3. (선택) **카카오 로그인 → 보안 → Client Secret** 을 '사용함'으로 켰다면 그 값도 Supabase 비밀값으로 넣어야 합니다.

### 2-4. 동의 항목: 톡캘린더
1. **카카오 로그인 → 동의항목**에서 **톡캘린더(talk_calendar)** 항목을 찾아 '선택 동의'로 설정합니다.
2. 톡캘린더는 일반 항목이 아니라서 보통 다음이 필요합니다:
   - **비즈 앱 전환**(사업자 정보 또는 개인 개발자 비즈 앱 등록)
   - **톡캘린더 API 사용 신청 / 검수** (앱 설정 → 추가 기능 신청 등). 개발자 포럼에 반려 사례도 있으니 사용 목적(레슨 일정 자동 등록)을 구체적으로 적으세요.
3. 승인 전에는 연결해도 "이 앱은 아직 카카오 톡캘린더 API 사용 권한이 없습니다" 오류가 납니다.

### 2-5. Supabase 함수(kakao-oauth) 배포
카카오는 로그인 후 `code` 를 주고, 이 코드를 **REST API 키**로 토큰과 바꿔야 합니다. REST 키는 비밀이므로 Supabase Edge Function 이 대신 교환합니다.
(Supabase 프로젝트와 CLI 준비는 `docs/SETUP-SUPABASE.md` 참고)

```bash
# 비밀값 등록 (값은 본인 것으로)
supabase secrets set KAKAO_REST_API_KEY=여기에_REST_API_키
supabase secrets set ALLOWED_ORIGINS=https://etaeho.github.io,http://localhost:3000
# 선택: 허용할 Redirect URI 제한
supabase secrets set KAKAO_REDIRECT_URIS=https://etaeho.github.io/v_calendar/,http://localhost:3000/
# 선택: Client Secret 을 켰을 때만
supabase secrets set KAKAO_CLIENT_SECRET=여기에_Client_Secret

# 배포 — 브라우저가 로그인 없이 부르므로 JWT 검사를 끕니다
supabase functions deploy kakao-oauth --no-verify-jwt
```
`supabase/config.toml` 에 `[functions.kakao-oauth]` / `verify_jwt = false` 를 적어 두면 플래그 없이 배포해도 같습니다.

### 2-6. GitHub 에 등록
Repository secrets 에 추가하고, `deploy.yml` 의 `npm run build` 단계 `env:` 에도 같은 이름으로 연결합니다.

| 이름 | 값 예시 | 공개 여부 |
| --- | --- | --- |
| `NEXT_PUBLIC_KAKAO_JS_KEY` | JavaScript 키 | 공개 값 |
| `NEXT_PUBLIC_KAKAO_REDIRECT_URI` | `https://etaeho.github.io/v_calendar/` | 공개 값 |
| `NEXT_PUBLIC_SUPABASE_URL` | `https://xxxx.supabase.co` | 공개 값 |
| (선택) `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon/publishable 키 | 공개 값 — 함수의 JWT 검사를 켠 경우에만 필요 |

로컬 `.env.local` 에서는 `NEXT_PUBLIC_KAKAO_REDIRECT_URI=http://localhost:3000/` 로 둡니다.

### 2-7. 동작 방식
- **연결**: 버튼을 누르면 카카오 로그인 페이지로 **이동**했다가 앱으로 돌아옵니다. 돌아오면 앱이 자동으로 토큰을 받아 연결을 마칩니다.
- 토큰은 **현재 탭(sessionStorage)** 에만 저장되어, 탭을 닫으면 다시 연결해야 합니다. (리프레시 토큰은 브라우저에 저장하지 않습니다)
- **불러오기**: 기본 톡캘린더의 오늘 기준 14일 전 ~ 90일 후 일정을 31일 단위로 나눠 가져옵니다.
- **레슨 등록**: 확정된 레슨을 톡캘린더 일정으로 만들고, 바뀌면 수정합니다. 카카오에는 숨은 표식 기능이 없어
  (1) 레슨↔카카오 일정 번호를 이 브라우저(localStorage)에 기억하고 (2) 일정 설명 끝에 `[vcal:레슨ID]` 를 붙입니다.
  다른 브라우저에서 처음 Push 하면 같은 레슨이 한 번 더 만들어질 수 있습니다.
- 톡캘린더 시각은 5분 단위만 허용되어 레슨 시각을 5분 단위로 맞춰 보냅니다.

---

## 3. 문제 해결

| 증상 | 원인 / 해결 |
| --- | --- |
| 계속 가상 일정만 보임 | 빌드에 환경 변수가 없음 → GitHub Secret 과 `deploy.yml` 의 `env:` 확인 후 재배포. 미리보기에서는 정상(항상 가상) |
| 구글 팝업이 안 뜸 / "팝업을 막았습니다" | 브라우저 팝업 허용 후 버튼을 다시 클릭 |
| `origin_mismatch` / `idpiframe_initialization_failed` | 구글 OAuth 클라이언트의 **승인된 JavaScript 원본**에 현재 주소(도메인까지만) 추가 |
| `access_denied` / 403 (구글) | 테스트 사용자 목록에 해당 이메일이 없음, 또는 캘린더 권한 체크를 해제함 |
| "로그인이 만료되었습니다" | 1시간(구글) / 약 6시간(카카오) 토큰 만료 → 다시 연결 |
| 카카오 `KOE006` | Redirect URI 가 콘솔 등록값과 다름 (끝의 `/` 포함 정확히 일치) |
| 카카오 `KOE320` / invalid_grant | 인가 코드를 두 번 쓰거나 만료됨 → 다시 연결 |
| 카카오 함수 호출이 CORS 오류 | `ALLOWED_ORIGINS` 에 현재 출처(`https://etaeho.github.io`) 추가 |
| 카카오 403 "사용 권한 없음" | 톡캘린더 동의항목/API 사용 신청 승인 필요 |
