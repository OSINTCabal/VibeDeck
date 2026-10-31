const browser = require("./usage-browser");
const { subscriptionBudgets, vibeAllowance, normalizeBilling } = require("./usage-data");
const ADMIN = "https://admin.mistral.ai";
const CONSOLE = "https://console.mistral.ai";
let generation = 0;
const cache = new Map(), inFlight = new Map();
async function connect(parent, destination) {
  generation++; cache.clear(); inFlight.clear();
  const connected = await browser.connect(parent, destination);
  cache.clear();
  if (parent && !parent.isDestroyed()) parent.webContents.send("usage:changed");
  return connected;
}
async function disconnect() {
  generation++; cache.clear(); inFlight.clear();
  await browser.disconnect();
}
async function read(year, month, refresh = false) {
  if (!Number.isInteger(year) || year < 2000 || year > new Date().getUTCFullYear() || !Number.isInteger(month) || month < 1 || month > 12) throw new Error("Invalid billing month");
  const key = `${year}-${month}`, previous = cache.get(key);
  if (previous && Date.now() - previous.fetched < (refresh || ["disconnected", "unavailable", "expired"].includes(previous.result.status) ? 10000 : 60000)) return previous.result;
  if (inFlight.has(key)) return inFlight.get(key);
  const version = generation;
  const task = readRemote(year, month, version).then(result => {
    if (version !== generation) return { status: "disconnected", source: "web", allowances: [], billing: null, detail: "Connect your Mistral usage account." };
    if (previous && !["expired", "disconnected"].includes(result.status)) {
      if (!result.billing && previous.result.billing) {
        result.billing = { ...previous.result.billing, status: "stale" };
        result.status = "stale";
      }
      if (!result.allowances.length && previous.result.allowances.length) {
        result.allowances = previous.result.allowances;
        result.measuredAt = previous.result.measuredAt;
        result.status = "stale";
      }
    }
    if (cache.size > 24) cache.clear();
    cache.set(key, { fetched: Date.now(), result });
    return result;
  }).finally(() => { if (inFlight.get(key) === task) inFlight.delete(key); });
  inFlight.set(key, task);
  return task;
}
async function readRemote(year, month, version) {
  if (!await browser.available()) return { status: "disconnected", source: "web", allowances: [], billing: null,
    detail: "Connect Mistral usage with Google in a Chromium-based browser. VibeDeck keeps the connection in the background." };
  let expired = false, signingIn = false;
  async function get(url, asText = false, required = true) {
    const response = await browser.read(url);
    if (!response) { signingIn = true; throw new Error("Finish signing in in the VibeDeck usage browser, then refresh."); }
    if (response.type === "opaqueredirect" || response.status === 401 || (response.status >= 300 && response.status < 400)) {
      if (required) expired = true;
      throw new Error("Mistral sign-in expired. Reconnect your usage account.");
    }
    if (response.status !== 200) throw new Error(`Mistral usage returned HTTP ${response.status}.`);
    return asText ? response.text : JSON.parse(response.text);
  }
  const [subscription, billing] = await Promise.allSettled([
    get(`${ADMIN}/subscription`, true).then(subscriptionBudgets),
    get(`${ADMIN}/api/billing/v2/usage?month=${month}&year=${year}`).then(data => normalizeBilling(data)),
  ]);
  let allowances = subscription.status === "fulfilled" ? subscription.value : [];
  if (version === generation && !allowances.some(a => a.id === "vibe_budget") && !expired) {
    try {
      const input = encodeURIComponent(JSON.stringify({ "0": { json: null, meta: { values: ["undefined"], v: 1 } } }));
      const allowance = vibeAllowance(await get(`${CONSOLE}/api-ui/trpc/billing.vibeUsage?batch=1&input=${input}`, false, false));
      if (allowance) allowances = [...allowances, allowance];
    } catch { /* Preserve valid billing and sibling allowances. */ }
  }
  const validBilling = billing.status === "fulfilled" ? billing.value : null;
  const errors = [subscription, billing].filter(r => r.status === "rejected").map(r => r.reason?.message || "Mistral usage is unavailable.");
  return { status: expired ? "expired" : signingIn && !validBilling && !allowances.length ? "disconnected" : validBilling && allowances.length ? "ready" : validBilling || allowances.length ? "partial" : "unavailable",
    source: "web", measuredAt: new Date().toISOString(), account: { label: "Mistral web account", source: "web" },
    allowances: expired ? [] : allowances, billing: expired ? null : validBilling, detail: errors.join(" ") || (allowances.length ? null : "This account did not expose subscription counters. Open Mistral to check your organization.") };
}
module.exports = { account: () => browser.account(), confirmSignIn: accepted => browser.confirmSignIn(accepted), connect, disconnect, read, shutdown: () => browser.shutdown() };
