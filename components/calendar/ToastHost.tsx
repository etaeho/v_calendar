"use client";

import { CheckCircle2, Info, XCircle } from "lucide-react";
import { useEffect } from "react";
import { cn } from "@/lib/utils";
import { useCalendarStore } from "@/store/calendar-store";

export function ToastHost() {
  const toast = useCalendarStore((s) => s.toast);
  const dismiss = useCalendarStore((s) => s.dismissToast);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(dismiss, 3200);
    return () => clearTimeout(timer);
  }, [toast, dismiss]);

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-5 z-50 flex justify-center px-4"
    >
      {toast && (
        <div
          key={toast.id}
          className={cn(
            "pointer-events-auto flex max-w-md animate-toast-in items-center gap-2 rounded-xl px-4 py-2.5 text-sm text-white shadow-lg",
            toast.kind === "error" ? "bg-red-700" : "bg-zinc-800",
          )}
        >
          {toast.kind === "success" && <CheckCircle2 className="size-4 shrink-0 text-mint-300" />}
          {toast.kind === "error" && <XCircle className="size-4 shrink-0" />}
          {toast.kind === "info" && <Info className="size-4 shrink-0 text-blue-300" />}
          {toast.message}
        </div>
      )}
    </div>
  );
}
