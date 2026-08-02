import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
});
const page = await context.newPage();
await page.goto("https://www.lastminute.com/", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});

const result = await page.evaluate(async () => {
  async function call(method, params) {
    const res = await fetch("https://mcp.lastminute.com/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params: params || {} }),
    });
    return await res.text();
  }
  const start = new Date(Date.now() + 14*24*3600*1000).toISOString().slice(0,10);
  const search = await call("tools/call", {
    name: "search_flights",
    arguments: { departure: "LON", arrival: "PAR", start_date: start, max_results: 2 },
  });
  return { search };
});
console.log(result.search);
