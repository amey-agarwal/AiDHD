import { hasBrowserbase, hasBrowserUse } from "../../integrations/config";
import { logInfo } from "../debug-log";

/**
 * Resolves a remote Chromium `Browser` for the harness to drive, in priority
 * order: Browserbase (primary — real CDP session, `bb.sessions.create()` →
 * `connectOverCDP(session.connectUrl)`, verified against docs.browserbase.com
 * 2026-08-02) → browser-use Cloud's raw-CDP mode (fallback — `POST
 * https://api.browser-use.com/api/v4/browsers` → `connectOverCDP(cdpUrl)`,
 * verified against docs.browser-use.com/cloud/llms-full.txt same date, but
 * NOT smoke-tested live in this environment — confirm before relying on it)
 * → local Chromium (dev-only fallback, no stealth/proxy).
 *
 * Deliberately never uses browser-use's Agent/task-delegation mode or
 * Yutori's Browsing API here — both fully hand control to a hosted LLM loop,
 * which is incompatible with keeping payment fields out of any AI prompt.
 * See docs/lastminute-prava-integration.md §4.
 */

export type ResolvedBrowserSession = {
  browser: import("playwright").Browser;
  provider: "browserbase" | "browser-use" | "local";
  /** Call when the harness run ends, in addition to browser.close(). */
  cleanup: () => Promise<void>;
};

async function tryBrowserbase(): Promise<ResolvedBrowserSession | null> {
  if (!hasBrowserbase()) return null;
  try {
    const { default: Browserbase } = await import("@browserbasehq/sdk");
    const { chromium } = await import("playwright");
    const bb = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY! });
    const session = await bb.sessions.create({
      projectId: process.env.BROWSERBASE_PROJECT_ID!,
    });
    const browser = await chromium.connectOverCDP(session.connectUrl);
    logInfo("harness", "connected via Browserbase", { session_id: session.id });
    return {
      browser,
      provider: "browserbase",
      cleanup: async () => {
        await fetch(`https://api.browserbase.com/v1/sessions/${session.id}`, {
          method: "POST",
          headers: {
            "x-bb-api-key": process.env.BROWSERBASE_API_KEY!,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ status: "REQUEST_RELEASE" }),
        }).catch(() => {});
      },
    };
  } catch (e) {
    logInfo("harness", "Browserbase session failed, falling back", {
      message: e instanceof Error ? e.message : "unknown",
    });
    return null;
  }
}

async function tryBrowserUseCdp(): Promise<ResolvedBrowserSession | null> {
  if (!hasBrowserUse()) return null;
  try {
    const { chromium } = await import("playwright");
    const res = await fetch("https://api.browser-use.com/api/v4/browsers", {
      method: "POST",
      headers: {
        "X-Browser-Use-API-Key": process.env.BROWSEREUSE_API_KEY!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    if (!res.ok) throw new Error(`browser-use session create failed (HTTP ${res.status})`);
    const data = (await res.json()) as { id?: string; cdpUrl?: string };
    if (!data.cdpUrl) throw new Error("browser-use response missing cdpUrl");
    const browser = await chromium.connectOverCDP(data.cdpUrl);
    logInfo("harness", "connected via browser-use CDP", { session_id: data.id });
    return {
      browser,
      provider: "browser-use",
      cleanup: async () => {
        if (!data.id) return;
        await fetch(`https://api.browser-use.com/api/v4/browsers/${data.id}`, {
          method: "PATCH",
          headers: {
            "X-Browser-Use-API-Key": process.env.BROWSEREUSE_API_KEY!,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ action: "stop" }),
        }).catch(() => {});
      },
    };
  } catch (e) {
    logInfo("harness", "browser-use CDP session failed, falling back", {
      message: e instanceof Error ? e.message : "unknown",
    });
    return null;
  }
}

async function localFallback(): Promise<ResolvedBrowserSession> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  logInfo("harness", "connected via local Chromium (dev-only, no stealth/proxy)", {});
  return { browser, provider: "local", cleanup: async () => {} };
}

export async function resolveBrowserSession(): Promise<ResolvedBrowserSession> {
  return (await tryBrowserbase()) || (await tryBrowserUseCdp()) || (await localFallback());
}
