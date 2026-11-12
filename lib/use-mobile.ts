"use client";

import { useSyncExternalStore } from "react";

/** 휴대폰 레이아웃 기준 (Tailwind md 미만) */
const QUERY = "(max-width: 767px)";

const subscribe = (onChange: () => void) => {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
};

/** 휴대폰 화면이면 true. 서버 렌더(정적 export) 시에는 false */
export function useIsMobile(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  );
}
