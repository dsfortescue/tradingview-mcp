import CDP from 'chrome-remote-interface';

let client = null;
let targetInfo = null;
// When true, getClient() will refuse to use any existing/fallback client
// and will force the caller to explicitly recover via connect() (or a
// successful reattach). Set on a failed reattach so downstream tool calls
// hard-fail rather than silently returning data from the wrong target.
let clientBroken = false;
const CDP_HOST = 'localhost';
const CDP_PORT = 9222;
const MAX_RETRIES = 5;
const BASE_DELAY = 500;

// Known direct API paths discovered via live probing (see PROBE_RESULTS.md)
const KNOWN_PATHS = {
  chartApi: 'window.TradingViewApi._activeChartWidgetWV.value()',
  chartWidgetCollection: 'window.TradingViewApi._chartWidgetCollection',
  bottomWidgetBar: 'window.TradingView.bottomWidgetBar',
  replayApi: 'window.TradingViewApi._replayApi',
  alertService: 'window.TradingViewApi._alertService',
  chartApiInstance: 'window.ChartApiInstance',
  mainSeriesBars: 'window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars()',
  // Phase 1: Strategy data — model().dataSources() → find strategy → .performance().value(), .ordersData(), .reportData()
  strategyStudy: 'chart._chartWidget.model().model().dataSources()',
  // Phase 2: Layouts — getSavedCharts(cb), loadChartFromServer(id)
  layoutManager: 'window.TradingViewApi.getSavedCharts',
  // Phase 5: Symbol search — searchSymbols(query) returns Promise
  symbolSearchApi: 'window.TradingViewApi.searchSymbols',
  // Phase 6: Pine scripts — REST API at pine-facade.tradingview.com/pine-facade/list/?filter=saved
  pineFacadeApi: 'https://pine-facade.tradingview.com/pine-facade',
};

export { KNOWN_PATHS };

/**
 * Sanitize a string for safe interpolation into JavaScript code evaluated via CDP.
 * Uses JSON.stringify to produce a properly escaped JS string literal (with quotes).
 * Prevents injection via quotes, backticks, template literals, or control chars.
 */
export function safeString(str) {
  return JSON.stringify(String(str));
}

/**
 * Validate that a value is a finite number. Throws if NaN, Infinity, or non-numeric.
 * Prevents corrupt values from reaching TradingView APIs that persist to cloud state.
 */
export function requireFinite(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a finite number, got: ${value}`);
  return n;
}

export async function getClient() {
  // Hard-fail contract: after a reattach exhausts retries we mark the
  // CDP client as broken and refuse to hand out any client (including
  // the MRU-fallback one from connect()) until the caller explicitly
  // recovers via a successful reattach(validTargetId) or by restarting
  // the MCP server. This prevents the silent-wrong-tab bug where a
  // failed switch used to null the singletons and the next getClient()
  // silently re-attached to the first MRU target.
  if (clientBroken) {
    throw new Error('CDP client is in broken state after reattach failure — call reattach(validTargetId) with a known-good target, or restart the MCP server');
  }
  if (client) {
    try {
      // Quick liveness check
      await client.Runtime.evaluate({ expression: '1', returnByValue: true });
      return client;
    } catch {
      client = null;
      targetInfo = null;
    }
  }
  return connect();
}

export async function connect() {
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // Loop-local CDP handle — close it on failure so we never orphan a
    // websocket that partially attached (e.g. Runtime.enable threw).
    let c = null;
    try {
      const target = await findChartTarget();
      if (!target) {
        throw new Error('No TradingView chart target found. Is TradingView open with a chart?');
      }
      c = await CDP({ host: CDP_HOST, port: CDP_PORT, target: target.id });

      // Enable required domains
      await c.Runtime.enable();
      await c.Page.enable();
      await c.DOM.enable();

      // Commit: publish to module-scoped singletons only after the
      // attach + domain enables fully succeeded.
      targetInfo = target;
      client = c;
      clientBroken = false;
      return client;
    } catch (err) {
      lastError = err;
      // Close the partial attach if we have one so we don't leak a CDP
      // websocket for this failed attempt. Target the loop-local handle,
      // NOT the module-scoped `client` — we must not close the existing
      // good singleton here.
      try { await c?.close(); } catch {}
      const delay = Math.min(BASE_DELAY * Math.pow(2, attempt), 30000);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error(`CDP connection failed after ${MAX_RETRIES} attempts: ${lastError?.message}`);
}

async function findChartTarget() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  // Prefer targets with tradingview.com/chart in the URL
  return targets.find(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url))
    || targets.find(t => t.type === 'page' && /tradingview/i.test(t.url))
    || null;
}

export async function getTargetInfo() {
  if (!targetInfo) {
    await getClient();
  }
  return targetInfo;
}

export async function evaluate(expression, opts = {}) {
  const c = await getClient();
  const result = await c.Runtime.evaluate({
    expression,
    returnByValue: true,
    awaitPromise: opts.awaitPromise ?? false,
    ...opts,
  });
  if (result.exceptionDetails) {
    const msg = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || 'Unknown evaluation error';
    throw new Error(`JS evaluation error: ${msg}`);
  }
  return result.result?.value;
}

export async function evaluateAsync(expression) {
  return evaluate(expression, { awaitPromise: true });
}

export async function disconnect() {
  // Reset all module state unconditionally. Gating the resets on `if (client)`
  // would miss the post-failed-reattach state (client === null, clientBroken
  // === true) where disconnect() is precisely the call a caller would use to
  // clear the broken flag and return the module to a clean slate.
  if (client) {
    try { await client.close(); } catch {}
  }
  client = null;
  targetInfo = null;
  clientBroken = false;
}

export async function reattach(targetId) {
  // Hard-fail contract: do NOT null client/targetInfo upfront. If every
  // retry fails, we null them and set clientBroken so getClient() refuses
  // to hand out a silently-wrong target. If a retry succeeds, we only
  // close the previous client AFTER the new one has attached + enabled
  // domains, ensuring no window where both are closed or stale.
  const oldClient = client;
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // Loop-local CDP handle — lets us close a partial attach (post-CDP,
    // pre-enable) without touching the existing good singleton.
    let c = null;
    try {
      c = await CDP({ host: CDP_HOST, port: CDP_PORT, target: targetId });
      await c.Runtime.enable();
      await c.Page.enable();
      await c.DOM.enable();
      const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
      const targets = await resp.json();

      // Commit: publish the new client, then close the old one. This
      // ordering guarantees getClient() never sees a window where the
      // previous good client is gone but the new one hasn't landed.
      targetInfo = targets.find(t => t.id === targetId) || { id: targetId };
      client = c;
      clientBroken = false;
      if (oldClient && oldClient !== c) {
        try { await oldClient.close(); } catch {}
      }
      return client;
    } catch (err) {
      lastError = err;
      // Close the partial attach from this failed attempt so we don't
      // orphan a CDP websocket. Target the loop-local `c`, NOT the
      // module-scoped `client` (which we must preserve until commit).
      try { await c?.close(); } catch {}
      const delay = Math.min(BASE_DELAY * Math.pow(2, attempt), 30000);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  // All retries exhausted. Null the singletons and mark the client broken
  // so the next getClient() call throws instead of silently falling back
  // to the first MRU target (the bug this patch exists to prevent).
  if (oldClient) {
    try { await oldClient.close(); } catch {}
  }
  client = null;
  targetInfo = null;
  clientBroken = true;
  throw new Error(`CDP reattach to ${targetId} failed after ${MAX_RETRIES} attempts: ${lastError?.message}`);
}

// --- Direct API path helpers ---
// Each returns the STRING expression path after verifying it exists.
// Callers use the returned string in their own evaluate() calls.

async function verifyAndReturn(path, name) {
  const exists = await evaluate(`typeof (${path}) !== 'undefined' && (${path}) !== null`);
  if (!exists) {
    throw new Error(`${name} not available at ${path}`);
  }
  return path;
}

export async function getChartApi() {
  return verifyAndReturn(KNOWN_PATHS.chartApi, 'Chart API');
}

export async function getChartCollection() {
  return verifyAndReturn(KNOWN_PATHS.chartWidgetCollection, 'Chart Widget Collection');
}

export async function getBottomBar() {
  return verifyAndReturn(KNOWN_PATHS.bottomWidgetBar, 'Bottom Widget Bar');
}

export async function getReplayApi() {
  return verifyAndReturn(KNOWN_PATHS.replayApi, 'Replay API');
}

export async function getMainSeriesBars() {
  return verifyAndReturn(KNOWN_PATHS.mainSeriesBars, 'Main Series Bars');
}
