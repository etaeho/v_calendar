-- 바이올린 레슨 스케줄러 — 초기 스키마
--
-- 설계: 스튜디오(강사 1명 + 레슨생)마다 LessonState 전체를 JSONB 문서 하나로 저장하고 version 으로
-- 낙관적 잠금(CAS)을 한다. 규칙은 Edge Function(lesson-api)이 브라우저와 같은 TypeScript 코드로 실행한다.
--
-- 접근 권한:
--   - 클라이언트(anon/authenticated)는 studio_events 를 자기 스튜디오 것만 SELECT(=Realtime 구독)할 수 있다.
--   - 나머지 테이블·함수는 Edge Function 이 service_role 키로만 다룬다 (RLS 켬 + 정책 없음 + 권한 회수).


/* ------------------------------------------------------------------ */
/* 테이블                                                               */
/* ------------------------------------------------------------------ */

create table public.studios (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table public.members (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios (id) on delete cascade,
  -- 초대만 되고 아직 로그인하지 않은 레슨생은 null. 처음 로그인할 때 이메일로 연결된다.
  user_id uuid null references auth.users (id) on delete set null,
  email text not null,
  role text not null check (role in ('INSTRUCTOR', 'STUDENT')),
  name text not null default '',
  -- LessonState 안에서 쓰는 id: 강사 t-xxxxxxxx, 레슨생 s-xxxxxxxx
  app_key text not null unique check (app_key ~ '^[ts]-[0-9a-f]{8}$'),
  phone text null,
  kakao_opt_in boolean not null default false,
  created_at timestamptz not null default now()
);

-- 스튜디오 안에서 이메일은 대소문자 무시 유일
create unique index members_studio_email_key on public.members (studio_id, lower(email));
-- 계정 하나는 멤버 행 하나에만 연결된다 (= 계정 하나당 스튜디오 하나)
create unique index members_user_id_key on public.members (user_id) where user_id is not null;
create index members_email_unlinked_idx on public.members (lower(email)) where user_id is null;

create table public.studio_state (
  studio_id uuid primary key references public.studios (id) on delete cascade,
  state jsonb not null,
  version int not null default 0,
  updated_at timestamptz not null default now()
);

-- 변경 알림용. 저장이 성공할 때마다 한 행 추가 → 클라이언트는 Realtime 으로 받아 view 를 다시 부른다.
create table public.studio_events (
  id bigserial primary key,
  studio_id uuid not null references public.studios (id) on delete cascade,
  version int not null,
  created_at timestamptz not null default now()
);
create index studio_events_studio_idx on public.studio_events (studio_id, id desc);

create table public.notifications (
  id text primary key,
  studio_id uuid not null references public.studios (id) on delete cascade,
  recipient_app_key text not null,
  kind text not null,
  title text not null,
  body text not null,
  slot_id text null,
  request_id text null,
  created_at timestamptz not null default now(),
  read_at timestamptz null,
  -- PENDING → (발송기) SENDING → SENT / FAILED / SKIPPED
  alimtalk_status text not null default 'PENDING'
    check (alimtalk_status in ('PENDING', 'SENDING', 'SENT', 'FAILED', 'SKIPPED')),
  alimtalk_error text null,
  -- 발송기가 가져간 시각 (SENDING 으로 멈춘 행 정리용)
  alimtalk_claimed_at timestamptz null
);
create index notifications_recipient_idx
  on public.notifications (studio_id, recipient_app_key, created_at desc);
create index notifications_pending_idx
  on public.notifications (created_at) where alimtalk_status in ('PENDING', 'SENDING');

/* ------------------------------------------------------------------ */
/* RLS / 권한                                                           */
/* ------------------------------------------------------------------ */

alter table public.studios enable row level security;
alter table public.members enable row level security;
alter table public.studio_state enable row level security;
alter table public.studio_events enable row level security;
alter table public.notifications enable row level security;

revoke all on table public.studios, public.members, public.studio_state, public.notifications
  from anon, authenticated;
revoke all on table public.studio_events from anon, authenticated;
grant select on table public.studio_events to authenticated;

-- 정책 안의 하위 질의도 RLS 를 받으므로, 멤버 여부는 security definer 함수로 확인한다
create or replace function public.is_studio_member(p_studio_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.members m
    where m.studio_id = p_studio_id and m.user_id = auth.uid()
  );
$$;
revoke execute on function public.is_studio_member(uuid) from public, anon;
grant execute on function public.is_studio_member(uuid) to authenticated;

create policy "members can read their studio events"
  on public.studio_events
  for select
  to authenticated
  using (public.is_studio_member(studio_id));

/* ------------------------------------------------------------------ */
/* Realtime                                                            */
/* ------------------------------------------------------------------ */

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  alter publication supabase_realtime add table public.studio_events;
end
$$;

/* ------------------------------------------------------------------ */
/* Edge Function 전용 함수 (service_role 만 실행)                        */
/* ------------------------------------------------------------------ */

-- 스튜디오 + 강사 멤버 + 빈 상태(version 0)를 한 트랜잭션으로 만든다. 새 스튜디오 id 를 돌려준다.
create or replace function public.bootstrap_studio(
  p_user_id uuid,
  p_email text,
  p_studio_name text,
  p_instructor_name text,
  p_app_key text,
  p_state jsonb
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_studio uuid;
begin
  insert into public.studios (name) values (p_studio_name) returning id into v_studio;
  insert into public.members (studio_id, user_id, email, role, name, app_key)
    values (v_studio, p_user_id, lower(p_email), 'INSTRUCTOR', p_instructor_name, p_app_key);
  insert into public.studio_state (studio_id, state, version) values (v_studio, p_state, 0);
  return v_studio;
end;
$$;

-- CAS 저장 + 이벤트 + 알림을 한 트랜잭션으로.
-- version 이 p_expected_version 일 때만 저장하고 새 version 을, 아니면 null 을 돌려준다.
-- p_notifications: lib/notifications.ts 의 AppNotification 배열 (camelCase JSON)
create or replace function public.commit_studio_change(
  p_studio_id uuid,
  p_expected_version int,
  p_state jsonb,
  p_notifications jsonb default '[]'::jsonb
)
returns int
language plpgsql
set search_path = public
as $$
declare
  v_version int;
begin
  update public.studio_state
     set state = p_state, version = version + 1, updated_at = now()
   where studio_id = p_studio_id and version = p_expected_version
  returning version into v_version;
  if not found then
    return null;
  end if;

  insert into public.studio_events (studio_id, version) values (p_studio_id, v_version);

  insert into public.notifications
    (id, studio_id, recipient_app_key, kind, title, body, slot_id, request_id, created_at)
  select n.id, p_studio_id, n.recipient, n.kind, n.title, n.body, n."slotId", n."requestId",
         coalesce(n."createdAt", now())
    from jsonb_to_recordset(coalesce(p_notifications, '[]'::jsonb)) as n(
      id text, recipient text, kind text, title text, body text,
      "slotId" text, "requestId" text, "createdAt" timestamptz
    );

  return v_version;
end;
$$;

-- 알림톡 발송기(notify-dispatch)가 보낼 알림을 가져간다 (동시에 여러 번 실행돼도 중복 발송 없음).
-- 하루 넘게 밀린 알림은 보내지 않고 SKIPPED, 15분 넘게 SENDING 인 것은 FAILED 로 정리한다.
create or replace function public.claim_pending_notifications(p_limit int default 50)
returns setof public.notifications
language plpgsql
set search_path = public
as $$
begin
  update public.notifications
     set alimtalk_status = 'SKIPPED', alimtalk_error = '하루 넘게 밀린 알림이라 보내지 않음'
   where alimtalk_status = 'PENDING' and created_at < now() - interval '1 day';
  update public.notifications
     set alimtalk_status = 'FAILED', alimtalk_error = '발송 중 중단됨 (15분 초과)'
   where alimtalk_status = 'SENDING' and alimtalk_claimed_at < now() - interval '15 minutes';

  return query
  with claimed as (
    update public.notifications n
       set alimtalk_status = 'SENDING', alimtalk_claimed_at = now()
     where n.id in (
       select p.id from public.notifications p
        where p.alimtalk_status = 'PENDING'
        order by p.created_at
        limit p_limit
        for update skip locked
     )
    returning n.*
  )
  select * from claimed;
end;
$$;

revoke execute on function public.bootstrap_studio(uuid, text, text, text, text, jsonb) from public, anon, authenticated;
revoke execute on function public.commit_studio_change(uuid, int, jsonb, jsonb) from public, anon, authenticated;
revoke execute on function public.claim_pending_notifications(int) from public, anon, authenticated;
grant execute on function public.bootstrap_studio(uuid, text, text, text, text, jsonb) to service_role;
grant execute on function public.commit_studio_change(uuid, int, jsonb, jsonb) to service_role;
grant execute on function public.claim_pending_notifications(int) to service_role;
