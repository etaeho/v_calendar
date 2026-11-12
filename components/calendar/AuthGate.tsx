"use client";

import { Loader2, LogIn, Mail, Music } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { RemoteApi, type Me } from "@/lib/remote";
import { accessToken, getSupabase } from "@/lib/supabase-client";
import { useCalendarStore } from "@/store/calendar-store";

type Phase =
  | { type: "loading" }
  | { type: "signedOut" }
  | { type: "noMember"; email: string }
  | { type: "ready"; me: Me }
  | { type: "error"; message: string };

const api = new RemoteApi(accessToken);
let loadedFor = "";

/**
 * 서버 모드에서만 쓰는 입구: 로그인 → (처음이면) 레슨실 만들기 또는 초대 확인 → 앱.
 * 로그인한 뒤에는 실시간으로 다른 사람의 변경을 받아 화면을 새로 고친다.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>({ type: "loading" });
  const startRemote = useCalendarStore((s) => s.startRemote);
  const refreshFromServer = useCalendarStore((s) => s.refreshFromServer);

  const load = async () => {
    const sb = getSupabase();
    if (!sb) return;
    const { data } = await sb.auth.getSession();
    // 시작할 때 INITIAL_SESSION 과 SIGNED_IN 이 함께 오므로 같은 사용자를 두 번 불러오지 않는다
    const key = data.session?.user.id ?? "";
    if (key && key === loadedFor) return;
    loadedFor = key;
    if (!data.session) {
      setPhase({ type: "signedOut" });
      return;
    }
    const res = await api.me();
    if (!res.ok) {
      setPhase({ type: "error", message: res.error.message });
      return;
    }
    if (!res.member) {
      setPhase({ type: "noMember", email: data.session.user.email ?? "" });
      return;
    }
    await startRemote(api, res.member);
    setPhase({ type: "ready", me: res.member });
  };

  const reload = () => {
    loadedFor = "";
    return load();
  };

  useEffect(() => {
    const sb = getSupabase();
    if (!sb) return;
    // INITIAL_SESSION 이벤트로 첫 상태를 받으므로 여기서 직접 불러오지 않는다
    const { data } = sb.auth.onAuthStateChange((event) => {
      if (event === "INITIAL_SESSION" || event === "SIGNED_IN" || event === "SIGNED_OUT") {
        // 콜백 안에서 Supabase 호출을 기다리면 교착될 수 있어 다음 틱에 실행한다
        setTimeout(() => void load(), 0);
      }
    });
    return () => data.subscription.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 처음 한 번만
  }, []);

  // 실시간: 같은 레슨실에서 누가 바꾸면 서버 상태를 다시 불러온다
  useEffect(() => {
    if (phase.type !== "ready") return;
    const sb = getSupabase();
    if (!sb) return;
    const channel = sb
      .channel(`studio-${phase.me.studioId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "studio_events", filter: `studio_id=eq.${phase.me.studioId}` },
        () => void refreshFromServer(),
      )
      .subscribe();
    return () => {
      void sb.removeChannel(channel);
    };
  }, [phase, refreshFromServer]);

  if (phase.type === "ready") return <>{children}</>;
  return (
    <div className="flex min-h-full items-center justify-center bg-zinc-50 px-4 py-10">
      <div className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
        <p className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-mint-800">
          <Music className="size-4" />
          바이올린 레슨 캘린더
        </p>
        {phase.type === "loading" && (
          <p className="flex items-center gap-2 py-6 text-sm text-zinc-600">
            <Loader2 className="size-4 animate-spin" />
            불러오는 중…
          </p>
        )}
        {phase.type === "signedOut" && <LoginForm />}
        {phase.type === "noMember" && <NoMember email={phase.email} onDone={reload} />}
        {phase.type === "error" && (
          <div className="space-y-3 py-2">
            <p className="text-sm text-red-700">{phase.message}</p>
            <Button onClick={() => void reload()}>다시 시도</Button>
          </div>
        )}
      </div>
    </div>
  );
}

/** 이메일로 로그인 링크·코드 받기 (비밀번호 없음) */
function LoginForm() {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sb = getSupabase()!;
  const redirect = typeof window !== "undefined" ? window.location.href.split("#")[0] : undefined;

  if (sent)
    return (
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          const { error } = await sb.auth.verifyOtp({ email, token: code.trim(), type: "email" });
          setBusy(false);
          if (error) setError("코드가 맞지 않거나 만료되었습니다. 메일의 링크를 눌러도 됩니다.");
        }}
      >
        <h1 className="text-lg font-bold">메일을 확인해 주세요</h1>
        <p className="text-sm text-zinc-600">
          <strong>{email}</strong> 로 로그인 링크를 보냈습니다. 링크를 누르거나, 메일의 6자리 코드를 입력하세요.
        </p>
        <label className="block text-xs font-medium text-zinc-600" htmlFor="otp-code">
          로그인 코드
          <input
            id="otp-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="mt-1 h-11 w-full rounded-lg border border-zinc-300 px-3 text-base tracking-widest"
          />
        </label>
        {error && <p className="text-sm text-red-700">{error}</p>}
        <Button type="submit" variant="primary" className="w-full" disabled={busy || code.trim().length < 6}>
          {busy ? <Loader2 className="animate-spin" /> : <LogIn />}
          로그인
        </Button>
        <Button variant="ghost" className="w-full text-xs" onClick={() => setSent(false)}>
          다른 이메일로
        </Button>
      </form>
    );

  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        const { error } = await sb.auth.signInWithOtp({ email: email.trim(), options: { emailRedirectTo: redirect } });
        setBusy(false);
        if (error) setError(`메일을 보내지 못했습니다: ${error.message}`);
        else setSent(true);
      }}
    >
      <h1 className="text-lg font-bold">로그인</h1>
      <p className="text-sm text-zinc-600">
        이메일로 로그인 링크를 보내 드립니다. 레슨생은 선생님이 초대한 이메일로 로그인하세요.
      </p>
      <label className="block text-xs font-medium text-zinc-600" htmlFor="login-email">
        이메일
        <input
          id="login-email"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1 h-11 w-full rounded-lg border border-zinc-300 px-3 text-base"
        />
      </label>
      {error && <p className="text-sm text-red-700">{error}</p>}
      <Button type="submit" variant="primary" className="w-full" disabled={busy}>
        {busy ? <Loader2 className="animate-spin" /> : <Mail />}
        로그인 링크 받기
      </Button>
    </form>
  );
}

/** 로그인했지만 아직 어느 레슨실에도 없을 때: 강사는 레슨실을 만들고, 레슨생은 초대를 기다린다 */
function NoMember({ email, onDone }: { email: string; onDone: () => Promise<void> }) {
  const [studioName, setStudioName] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-4">
      <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-950">
        <strong>{email}</strong> 은 아직 등록된 레슨실이 없습니다. 레슨생이라면 선생님께 이 이메일로 초대를 요청한
        뒤 다시 로그인해 주세요.
      </div>
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          const res = await api.bootstrap(studioName.trim(), name.trim());
          setBusy(false);
          if (!res.ok) setError(res.error.message);
          else await onDone();
        }}
      >
        <h2 className="text-base font-bold">강사라면: 레슨실 만들기</h2>
        <label className="block text-xs font-medium text-zinc-600" htmlFor="studio-name">
          레슨실 이름
          <input
            id="studio-name"
            required
            value={studioName}
            onChange={(e) => setStudioName(e.target.value)}
            placeholder="예: 정유진 바이올린"
            className="mt-1 h-11 w-full rounded-lg border border-zinc-300 px-3 text-base"
          />
        </label>
        <label className="block text-xs font-medium text-zinc-600" htmlFor="instructor-name">
          내 이름 (레슨생에게 보이는 이름)
          <input
            id="instructor-name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 h-11 w-full rounded-lg border border-zinc-300 px-3 text-base"
          />
        </label>
        {error && <p className="text-sm text-red-700">{error}</p>}
        <Button type="submit" variant="primary" className="w-full" disabled={busy}>
          레슨실 만들고 시작하기
        </Button>
      </form>
      <Button variant="ghost" className="w-full text-xs" onClick={() => void getSupabase()?.auth.signOut()}>
        로그아웃
      </Button>
    </div>
  );
}

export async function signOut() {
  await getSupabase()?.auth.signOut();
  window.location.reload();
}
