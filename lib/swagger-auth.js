/**
 * Content script - auto-applies the stored bearer token to Swagger UI when enabled.
 * Uses a page-context bridge (postMessage) and optional blocking webRequest header injection.
 */

const browser = getBrowserApi();

const MSG_SOURCE_EXT = "token-copier-extension";
const MSG_SOURCE_PAGE = "token-copier-page";

const SWAGGER_UI_WAIT_MS = 20000;
const SWAGGER_UI_POLL_MS = 300;
const SWAGGER_MESSAGE_TIMEOUT_MS = 4000;
const EXPIRY_BANNER_DURATION_MS = 8000;

let applyTimer = null;
let lastSuccessfulToken = "";
let lastExpiryWarnedToken = "";
let expiryBannerTimer = null;
let bridgeInjected = false;
let pageMessageId = 0;
let loggedAutoApplyOff = false;
let loggedPageDetection = false;
let swaggerObserverAttached = false;

/**
 * Log Swagger page detection details once for debugging.
 *
 * @returns {void}
 */
function logSwaggerPageDetection() {
  if (loggedPageDetection) return;
  loggedPageDetection = true;

  const href = location.href;
  console.info("[token-copier][swagger] Page detection", {
    href,
    isSwaggerUrl: isSwaggerUrl(href),
    isSwaggerPage: isSwaggerPage(),
    hasSwaggerUiDom: Boolean(
      document.querySelector(".swagger-ui") || document.querySelector("#swagger-ui")
    ),
    pathname: location.pathname,
  });
}

/**
 * Inject the page-context Swagger bridge script once.
 *
 * @returns {void}
 */
function injectSwaggerBridge() {
  if (bridgeInjected || document.documentElement.dataset.tokenCopierBridgeInjected) {
    bridgeInjected = true;
    return;
  }

  const script = document.createElement("script");
  script.src = browser.runtime.getURL("lib/swagger-page-bridge.js");
  script.addEventListener("load", () => {
    script.remove();
    console.info("[token-copier] Swagger page bridge injected");
  });
  script.addEventListener("error", () => {
    console.warn("[token-copier] Failed to load Swagger page bridge script");
  });

  (document.head || document.documentElement).appendChild(script);
  document.documentElement.dataset.tokenCopierBridgeInjected = "1";
  bridgeInjected = true;
}

/**
 * Send a message to the page-context bridge and wait for a response.
 *
 * @param {string} type - Message type understood by the page bridge.
 * @param {object} payload - Message payload.
 * @param {string} responseType - Expected response message type.
 * @returns {Promise<object>} Response payload from the page bridge.
 */
function sendPageMessage(type, payload, responseType) {
  const id = ++pageMessageId;

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      window.removeEventListener("message", onMessage);
      resolve({ ok: false, reason: "timeout" });
    }, SWAGGER_MESSAGE_TIMEOUT_MS);

    function onMessage(event) {
      if (event.source !== window || !event.data || event.data.source !== MSG_SOURCE_PAGE) return;
      if (event.data.id !== id || event.data.type !== responseType) return;

      clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
      resolve(event.data.result ?? event.data);
    }

    window.addEventListener("message", onMessage);
    window.postMessage(
      {
        source: MSG_SOURCE_EXT,
        type,
        id,
        ...payload,
      },
      "*"
    );
  });
}

/**
 * Wait until the page-context bridge reports Swagger UI is ready.
 *
 * @returns {Promise<boolean>} Whether Swagger UI authorize APIs are available.
 */
async function waitForSwaggerUiReady() {
  const deadline = Date.now() + SWAGGER_UI_WAIT_MS;

  while (Date.now() < deadline) {
    const response = await sendPageMessage("swagger-probe", {}, "swagger-probe-result");
    if (response.ready) return true;
    await sleep(SWAGGER_UI_POLL_MS);
  }

  return false;
}

/**
 * Delay for a given number of milliseconds.
 *
 * @param {number} ms - Delay duration.
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve the stored token via the background script (has full tab/cookie access).
 *
 * @returns {Promise<string|null>} Token value or null.
 */
async function resolveStoredTokenForTab() {
  try {
    return (await sendExtensionMessage({ type: "GET_STORED_TOKEN" }))?.token || null;
  } catch (err) {
    console.warn("[token-copier] Failed to get stored token from background:", err);
    return null;
  }
}

/**
 * Show a temporary expiry warning banner at the top of the Swagger page.
 *
 * @param {string} message - Warning text to display.
 * @returns {void}
 */
function showSwaggerExpiryBanner(message) {
  const existing = document.getElementById("token-copier-expiry-banner");
  if (existing) existing.remove();
  if (expiryBannerTimer) {
    clearTimeout(expiryBannerTimer);
    expiryBannerTimer = null;
  }

  const banner = document.createElement("div");
  banner.id = "token-copier-expiry-banner";
  banner.setAttribute("role", "alert");
  banner.textContent = message;
  banner.style.cssText = [
    "position: fixed",
    "top: 0",
    "left: 0",
    "right: 0",
    "z-index: 2147483647",
    "margin: 0",
    "padding: 12px 16px",
    "background: #ff5630",
    "color: #fff",
    "font: 600 13px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    "text-align: center",
    "box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2)",
    "opacity: 0",
    "transition: opacity 0.25s ease",
  ].join(";");

  document.documentElement.appendChild(banner);
  requestAnimationFrame(() => {
    banner.style.opacity = "1";
  });

  expiryBannerTimer = setTimeout(() => {
    banner.style.opacity = "0";
    setTimeout(() => banner.remove(), 250);
    expiryBannerTimer = null;
  }, EXPIRY_BANNER_DURATION_MS);
}

/**
 * Remove any visible Swagger expiry warning banner.
 *
 * @returns {void}
 */
function dismissSwaggerExpiryBanner() {
  const existing = document.getElementById("token-copier-expiry-banner");
  if (existing) existing.remove();
  if (expiryBannerTimer) {
    clearTimeout(expiryBannerTimer);
    expiryBannerTimer = null;
  }
}

/**
 * Show an expiry warning once per token value on the Swagger page.
 *
 * @param {string} token - Raw token value.
 * @returns {void}
 */
function checkAndShowTokenExpiryWarning(token) {
  const normalized = String(token || "").replace(/^Bearer\s+/i, "").trim();
  if (!normalized || normalized === lastExpiryWarnedToken) return;

  const warning = getTokenExpiryWarning(normalized);
  if (!warning) return;

  lastExpiryWarnedToken = normalized;
  showSwaggerExpiryBanner(warning.message);
}

/**
 * Schedule a debounced Swagger authorize attempt.
 *
 * @returns {void}
 */
function scheduleSwaggerAuthApply() {
  if (applyTimer) clearTimeout(applyTimer);
  applyTimer = setTimeout(() => {
    applyTimer = null;
    tryApplySwaggerAuth();
  }, 250);
}

/**
 * Apply the current stored token to Swagger UI if auto-apply is enabled.
 *
 * @returns {Promise<void>}
 */
async function tryApplySwaggerAuth() {
  if (!isSwaggerPage()) return;

  logSwaggerPageDetection();

  try {
    const cfg = await browser.storage.local.get(["swaggerAutoApply", "swaggerSchemeName"]);
    if (!cfg.swaggerAutoApply) {
      dismissSwaggerExpiryBanner();
      lastExpiryWarnedToken = "";
      if (!loggedAutoApplyOff) {
        console.info("[token-copier] Swagger page detected - enable auto-apply in the Token Copier popup");
        loggedAutoApplyOff = true;
      }
      return;
    }

    loggedAutoApplyOff = false;
    injectSwaggerBridge();

    const token = await resolveStoredTokenForTab();
    if (token) {
      checkAndShowTokenExpiryWarning(token);
    }

    if (!token) {
      console.info("[token-copier] Swagger auto-apply: no stored token yet");
      return;
    }

    const normalizedToken = token.replace(/^Bearer\s+/i, "").trim();
    if (normalizedToken === lastSuccessfulToken) return;

    const schemes = parseSwaggerSchemeNames(cfg.swaggerSchemeName);
    const uiReady = await waitForSwaggerUiReady();
    if (!uiReady) {
      console.warn(
        "[token-copier] Swagger UI authorize API not ready - requests still use the page bridge or webRequest injection when supported"
      );
    }

    if (uiReady) {
      const result = await sendPageMessage(
        "swagger-apply",
        { token, schemes },
        "swagger-result"
      );

      if (result.ok) {
        lastSuccessfulToken = normalizedToken;
        if (result.reason === "already-authorized" || result.skipped) {
          console.info("[token-copier] Swagger already has authorization - not overwriting");
          return;
        }
        console.info("[token-copier] Swagger UI authorize applied", {
          method: result.method,
          scheme: result.scheme || result.schemes,
        });
        return;
      }

      console.warn("[token-copier] Swagger UI authorize failed:", result.reason || result);
    }
  } catch (err) {
    console.warn("[token-copier] Swagger auto-apply failed:", err);
  }
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;

  if (changes.swaggerAutoApply) {
    loggedAutoApplyOff = false;
    if (!changes.swaggerAutoApply.newValue) {
      dismissSwaggerExpiryBanner();
      lastExpiryWarnedToken = "";
    }
  }

  if (
    changes.swaggerAutoApply ||
    changes.swaggerSchemeName ||
    changes.interceptedTokens ||
    changes.tokenSource ||
    changes.cookieDomain ||
    changes.responseDomain ||
    changes.cookieName ||
    changes.headerName
  ) {
    if (
      changes.interceptedTokens ||
      changes.tokenSource ||
      changes.cookieDomain ||
      changes.responseDomain
    ) {
      lastSuccessfulToken = "";
      lastExpiryWarnedToken = "";
    }
    scheduleSwaggerAuthApply();
  }
});

browser.runtime.onMessage.addListener((message) => {
  if (message?.type === "APPLY_SWAGGER_TOKEN") {
    lastSuccessfulToken = "";
    lastExpiryWarnedToken = "";
    scheduleSwaggerAuthApply();
  }
});

if (isSwaggerPage()) {
  logSwaggerPageDetection();
  injectSwaggerBridge();
  attachSwaggerObserver();
  scheduleSwaggerAuthApply();
}

/**
 * Observe Swagger UI DOM changes without watching the entire document tree.
 *
 * @returns {void}
 */
function attachSwaggerObserver() {
  if (swaggerObserverAttached) return;
  swaggerObserverAttached = true;

  const target =
    document.querySelector(".swagger-ui") ||
    document.querySelector("#swagger-ui") ||
    document.body;

  const observer = new MutationObserver(() => {
    if (isSwaggerPage()) scheduleSwaggerAuthApply();
  });

  observer.observe(target, { childList: true, subtree: true });
}
