import { useEffect, useRef } from "react";

const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface TurnstileApi {
  render: (container: HTMLElement, options: Record<string, unknown>) => string;
  reset: (widgetId: string) => void;
  remove: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptPromise: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = SCRIPT_URL;
      script.async = true;
      script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("Captcha failed to load")));
      script.onerror = () => {
        scriptPromise = null;
        reject(new Error("Captcha failed to load"));
      };
      document.head.appendChild(script);
    });
  }
  return scriptPromise;
}

interface Props {
  siteKey: string;
  /** Called with a fresh token, or null when the token expired or the check failed. */
  onToken: (token: string | null) => void;
  /** Increment to request a new token, for example after a rejected submission. */
  resetKey?: number;
}

/** Cloudflare Turnstile captcha. Tokens are single-use, so reset it after each submission. */
export default function Turnstile({ siteKey, onToken, resetKey = 0 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<string | null>(null);
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;

  useEffect(() => {
    let cancelled = false;
    loadTurnstile()
      .then((turnstile) => {
        if (cancelled || !containerRef.current) return;
        widgetRef.current = turnstile.render(containerRef.current, {
          sitekey: siteKey,
          callback: (token: string) => onTokenRef.current(token),
          "expired-callback": () => onTokenRef.current(null),
          "error-callback": () => onTokenRef.current(null),
        });
      })
      .catch(() => onTokenRef.current(null));
    return () => {
      cancelled = true;
      if (widgetRef.current) window.turnstile?.remove(widgetRef.current);
      widgetRef.current = null;
    };
  }, [siteKey]);

  useEffect(() => {
    if (resetKey > 0 && widgetRef.current) {
      onTokenRef.current(null);
      window.turnstile?.reset(widgetRef.current);
    }
  }, [resetKey]);

  return <div ref={containerRef} data-testid="signup-captcha" />;
}
