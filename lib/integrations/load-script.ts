/** 외부 SDK 스크립트를 한 번만 동적으로 불러온다 (src 별로 Promise 캐시) */
const cache = new Map<string, Promise<void>>();

export interface LoadScriptOptions {
  /** Subresource Integrity 해시 (예: "sha384-...") */
  integrity?: string;
  timeoutMs?: number;
}

export function loadScript(src: string, options: LoadScriptOptions = {}): Promise<void> {
  if (typeof document === "undefined") {
    return Promise.reject(new Error("브라우저 환경이 아닙니다."));
  }
  const cached = cache.get(src);
  if (cached) return cached;

  const promise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    if (options.integrity) {
      script.integrity = options.integrity;
      script.crossOrigin = "anonymous";
    }
    const timer = setTimeout(() => {
      script.remove();
      reject(new Error(`스크립트 로드 시간 초과: ${src}`));
    }, options.timeoutMs ?? 15_000);
    script.onload = () => {
      clearTimeout(timer);
      resolve();
    };
    script.onerror = () => {
      clearTimeout(timer);
      script.remove();
      reject(new Error(`스크립트 로드 실패: ${src}`));
    };
    document.head.appendChild(script);
  });
  // 실패한 로드는 캐시하지 않는다 (네트워크 회복 후 재시도 가능)
  promise.catch(() => cache.delete(src));
  cache.set(src, promise);
  return promise;
}
