// Pure adapters for Mistral's read-only web data. No cookie or key leaves the main process.
function finite(value) { return typeof value === "number" && Number.isFinite(value); }
function date(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null; }

function jsonEnd(text, start) {
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === '"') quoted = false; }
    else if (c === '"') quoted = true;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") { if (--depth === 0) return i + 1; }
  }
  return -1;
}

function subscriptionBudgets(html) {
  const chunks = [];
  const marker = /self\.__next_f\.push\(\s*/g;
  let match;
  while ((match = marker.exec(html))) {
    const end = jsonEnd(html, marker.lastIndex);
    if (end < 0) break;
    try {
      const item = JSON.parse(html.slice(marker.lastIndex, end));
      if (item[0] === 1 && typeof item[1] === "string") chunks.push(item[1]);
    } catch { /* An incomplete record must not become a fabricated allowance. */ }
    marker.lastIndex = end;
  }
  const models = [];
  const bytes = Buffer.from(chunks.join(""));
  let offset = 0;
  while (offset < bytes.length) {
    const colon = bytes.indexOf(58, offset), newline = bytes.indexOf(10, offset);
    if (colon < 0) break;
    if (newline >= 0 && newline < colon) { offset = newline + 1; continue; }
    const id = bytes.subarray(offset, colon).toString();
    if (!/^[0-9a-f]+$/i.test(id)) { offset = newline < 0 ? bytes.length : newline + 1; continue; }
    const start = colon + 1;
    if (/[TAOoUSsLlGgMmV]/.test(String.fromCharCode(bytes[start]))) {
      const comma = bytes.indexOf(44, start);
      if (comma < 0) break;
      const count = bytes.subarray(start + 1, comma).toString();
      if (!/^[0-9a-f]+$/i.test(count)) break;
      offset = comma + 1 + parseInt(count, 16);
      continue;
    }
    const end = bytes.indexOf(10, start);
    if (bytes[start] === 91 || bytes[start] === 123) {
      try { models.push(JSON.parse(bytes.subarray(start, end < 0 ? bytes.length : end).toString())); } catch { /* Skip unsupported Flight records. */ }
    }
    offset = end < 0 ? bytes.length : end + 1;
  }
  const found = new Map();
  function walk(value, depth = 0) {
    if (!value || typeof value !== "object" || depth > 50) return;
    const budget = value.budget;
    if (budget && typeof budget === "object") {
      const allowances = [];
      for (const [key, label] of [["vibe_budget", "Vibe Code"], ["api_budget", "Included API"]]) {
        const raw = budget[key];
        if (!raw || !finite(raw.usage_percentage) || raw.usage_percentage < 0 || !finite(raw.initial_budget) || raw.initial_budget <= 0) continue;
        if (typeof raw.currency !== "string" || !/^[a-z]{3}$/i.test(raw.currency)) continue;
        const used = raw.initial_budget * raw.usage_percentage / 100;
        if (!finite(used)) continue;
        allowances.push({ id: key, label, usedPercent: raw.usage_percentage, limit: raw.initial_budget,
          used, remaining: Math.max(0, raw.initial_budget - used), currency: raw.currency.toUpperCase(),
          resetAt: date(raw.reset_at), source: "web", measuredAt: new Date().toISOString() });
      }
      if (allowances.length) found.set(JSON.stringify(allowances.map(({ measuredAt, ...item }) => item)), allowances);
    }
    Object.values(value).forEach(v => walk(v, depth + 1));
  }
  models.forEach(v => walk(v));
  if (found.size > 1) throw new Error("Multiple subscription accounts were returned. Open Mistral to select the correct organization.");
  return found.values().next().value || [];
}

function vibeAllowance(payload) {
  const raw = payload?.[0]?.result?.data?.json;
  if (!raw || !finite(raw.usage_percentage) || raw.usage_percentage < 0 || raw.usage_percentage > 100) return null;
  return { id: "vibe_budget", label: "Vibe Code", usedPercent: raw.usage_percentage,
    limit: null, used: null, remaining: null, currency: null, resetAt: date(raw.reset_at),
    source: "web", measuredAt: new Date().toISOString() };
}

function normalizeBilling(data, source = "web") {
  if (!data || typeof data !== "object" || !["completion", "chat", "vibe_code", "start_date"].some(k => k in data)) throw new Error("Unrecognized billing response");
  const keys = ["event_type", "billing_metric", "billing_group", "api_zone", "service_tier"];
  const priceKey = row => JSON.stringify(keys.map(k => row[k] ?? null));
  const prices = new Map();
  for (const row of data.prices || []) {
    const price = Number(row.price);
    if (row.price != null && Number.isFinite(price)) prices.set(priceKey(row), price);
  }
  let cost = 0, missingPrice = false;
  const totals = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  const rows = new Map();
  const categories = ["completion", "chat", "ocr", "audio", "audio_characters", "connectors"].map(name => [data[name], ["completion", "chat"].includes(name)]);
  categories.push([data.vibe_code?.completion, true], [data.libraries_api?.pages, false], [data.libraries_api?.tokens, false],
    [{ models: data.fine_tuning?.training }, false], [{ models: data.fine_tuning?.storage }, false]);
  for (const [category, countsTokens] of categories) {
    const models = category?.models || {};
    if (Array.isArray(models) || typeof models !== "object") throw new Error("Unrecognized billing model data");
    for (const [model, lanes] of Object.entries(models)) {
      for (const [lane, metric] of [["input", "inputTokens"], ["output", "outputTokens"], ["cached", "cachedTokens"]]) {
        for (const event of lanes?.[lane] || []) {
          const used = event.value ?? event.value_paid ?? 0, paid = event.value_paid ?? event.value ?? 0;
          if (!finite(used) || !finite(paid) || Math.abs(used) > Number.MAX_SAFE_INTEGER || Math.abs(paid) > Number.MAX_SAFE_INTEGER) throw new Error("Invalid billing units");
          const price = prices.get(priceKey(event)) ?? prices.get(priceKey({ ...event, api_zone: null, service_tier: null }));
          if (price === undefined && paid !== 0) missingPrice = true;
          const amount = paid * (price ?? 0);
          cost += amount;
          if (countsTokens) totals[metric] += used;
          const day = String(event.timestamp || "").slice(0, 10), key = JSON.stringify([day, model]);
          const row = rows.get(key) || { day, model, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cost: 0 };
          row.cost += amount;
          if (countsTokens) row[metric] += used;
          rows.set(key, row);
        }
      }
    }
  }
  if (!finite(cost) || Object.values(totals).some(v => !finite(v) || Math.abs(v) > Number.MAX_SAFE_INTEGER)) throw new Error("Invalid billing totals");
  return { status: missingPrice ? "partial" : "ready", source, measuredAt: new Date().toISOString(),
    currency: data.currency || null, cost: missingPrice ? null : cost, ...totals, rows: [...rows.values()],
    startDate: data.start_date || null, endDate: data.end_date || null,
    detail: missingPrice ? "Some billing prices were unavailable." : null };
}
module.exports = { subscriptionBudgets, vibeAllowance, normalizeBilling };
