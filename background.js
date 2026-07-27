/**
 * Service worker - intercepts GET/POST requests and responses for bearer tokens
 * on the configured response domain (Authorization header or Set-Cookie).
 */

// Chrome MV3 service worker - load shared utils. Firefox loads them via manifest scripts.
if (typeof importScripts === "function") {
  importScripts("lib/browser.js", "lib/domain.js", "lib/format.js", "lib/token-source.js");
}

const browser = getBrowserApi();

const ALLOWED_METHODS = new Set(["GET", "POST"]);

/** Set to true only for local debugging - never logs full secrets. */
const DEBUG = false;

/** @type {{ headerName: string, cookieName: string, responseDomain: string }} */
const config = {
  headerName: "authorization",
  cookieName: "token",
  responseDomain: "",
};

/** @type {{ swaggerAutoApply: boolean }} */
const swaggerConfig = {
  swaggerAutoApply: false,
};

/** @type {{ value: string|null, expiresAt: number }} */
let swaggerTokenCache = {
  value: null,
  expiresAt: 0,
};

/** @type {Map<string, { count: number, tokenFound: boolean, details: object, timer: ReturnType<typeof setTimeout>|null }>} */
const pendingStatusUpdates = new Map();

const INTERCEPT_STATUS_DEBOUNCE_MS = 750;
const SWAGGER_TOKEN_CACHE_MS = 30000;

/** Whether blocking onBeforeSendHeaders is active (Firefox, or Chromium with support). */
let blockingRequestHeadersSupported = false;

/**
 * Apply stored settings to the in-memory config.
 *
 * @param {object} cfg - Values from browser.storage.local.
 * @returns {void}
 */
function applyConfig(cfg) {
  config.headerName = String(cfg.headerName || "authorization").toLowerCase();
  config.cookieName = String(cfg.cookieName || "token");
  config.responseDomain =
    parseHostname(cfg.responseDomain || cfg.targetDomain || "") || "";

  if ("swaggerAutoApply" in cfg) {
    swaggerConfig.swaggerAutoApply = Boolean(cfg.swaggerAutoApply);
  }

  if (DEBUG) {
    console.info("[token-copier] Config loaded:", {
      responseDomain: config.responseDomain || "(not set)",
      headerName: config.headerName,
      cookieName: config.cookieName,
      swaggerAutoApply: swaggerConfig.swaggerAutoApply,
    });
  }
}

/**
 * Load config from storage.
 *
 * @returns {Promise<void>}
 */
function loadConfig() {
  return browser.storage.local
    .get(["headerName", "cookieName", "responseDomain", "targetDomain", "swaggerAutoApply"])
    .then(applyConfig)
    .catch((err) => {
      console.error("[token-copier] Failed to load config:", err);
    });
}

/**
 * Register webRequest listeners after config is available.
 *
 * @returns {Promise<void>}
 */
async function registerInterceptors() {
  const beforeSpec = await registerWebRequestListener(
    browser.webRequest.onBeforeSendHeaders.addListener.bind(browser.webRequest.onBeforeSendHeaders),
    handleBeforeSendHeaders,
    getBeforeSendHeaderSpecCandidates()
  );
  blockingRequestHeadersSupported = beforeSpec.includes("blocking");

  await registerWebRequestListener(
    browser.webRequest.onHeadersReceived.addListener.bind(browser.webRequest.onHeadersReceived),
    handleResponseHeaders,
    getResponseHeaderSpecCandidates()
  );

  if (DEBUG) {
    console.info("[token-copier] webRequest listeners registered:", {
      browser: getBrowserKind(),
      blockingRequestHeadersSupported,
    });
  }
}

loadConfig()
  .then(registerInterceptors)
  .catch((err) => {
    console.error("[token-copier] Failed to register interceptors:", err);
  });

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "GET_STORED_TOKEN") return undefined;

  getStoredToken(browser, sender.tab || null)
    .then((token) => sendResponse({ token: token || null }))
    .catch((err) => {
      console.warn("[token-copier] Failed to resolve stored token:", err);
      sendResponse({ token: null });
    });

  return true;
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;

  try {
    const patch = {};
    if (changes.headerName) patch.headerName = changes.headerName.newValue;
    if (changes.cookieName) patch.cookieName = changes.cookieName.newValue;
    if (changes.responseDomain) patch.responseDomain = changes.responseDomain.newValue;
    if (changes.targetDomain) patch.targetDomain = changes.targetDomain.newValue;
    if (changes.swaggerAutoApply) patch.swaggerAutoApply = changes.swaggerAutoApply.newValue;

    if (Object.keys(patch).length > 0) {
      applyConfig({
        ...config,
        swaggerAutoApply: swaggerConfig.swaggerAutoApply,
        ...patch,
      });
    }

    if (
      changes.interceptedTokens ||
      changes.tokenSource ||
      changes.cookieDomain ||
      changes.responseDomain ||
      changes.cookieName ||
      changes.headerName ||
      changes.swaggerAutoApply
    ) {
      invalidateSwaggerTokenCache();
    }
  } catch (err) {
    console.error("[token-copier] Failed to apply config change:", err);
  }
});

/**
 * Clear the cached Swagger token so the next request reloads it.
 *
 * @returns {void}
 */
function invalidateSwaggerTokenCache() {
  swaggerTokenCache = { value: null, expiresAt: 0 };
}

/**
 * Resolve the bearer token used for Swagger header injection.
 *
 * @param {browser.tabs.Tab} tab - Tab that initiated the request.
 * @returns {Promise<string|null>} Token value or null.
 */
async function getCachedSwaggerToken(tab) {
  if (swaggerTokenCache.value && Date.now() < swaggerTokenCache.expiresAt) {
    return swaggerTokenCache.value;
  }

  const token = await getStoredToken(browser, tab);
  swaggerTokenCache = {
    value: token,
    expiresAt: Date.now() + SWAGGER_TOKEN_CACHE_MS,
  };
  return token;
}

/**
 * Log Swagger injection diagnostics when DEBUG is enabled.
 *
 * @param {string} stage - Pipeline stage (detect, skip, inject).
 * @param {string} message - Human-readable message.
 * @param {object} [data] - Extra context (URLs and flags only, no secrets).
 * @returns {void}
 */
function logSwaggerDebug(stage, message, data = {}) {
  if (!DEBUG) return;
  console.info(`[token-copier][swagger] ${stage}: ${message}`, data);
}

/**
 * Return true when a URL looks Swagger-related for near-miss diagnostics.
 *
 * @param {string} url - Full URL.
 * @returns {boolean} Whether the URL mentions common API-doc paths.
 */
function isSwaggerLikeUrl(url) {
  return /swagger|openapi|api-docs|redoc/i.test(String(url || ""));
}

/**
 * Return true when the request already includes a non-empty Authorization header.
 *
 * @param {browser.HttpHeader[]|undefined} headers - Outgoing request headers.
 * @returns {boolean} Whether Authorization is already set by Swagger or the page.
 */
function hasAuthorizationHeader(headers) {
  return (headers || []).some((header) => {
    if (header.name?.toLowerCase() !== "authorization") return false;
    return Boolean(String(header.value || "").trim());
  });
}

/**
 * Add Authorization only when the request does not already send one.
 *
 * @param {browser.HttpHeader[]|undefined} headers - Outgoing request headers.
 * @param {string} token - Normalized bearer token without the Bearer prefix.
 * @returns {browser.HttpHeader[]|null} Updated headers, or null when unchanged.
 */
function injectAuthorizationHeaderIfMissing(headers, token) {
  const authValue = `Bearer ${token}`;
  const next = (headers || []).slice();
  const existingIndex = next.findIndex((header) => header.name?.toLowerCase() === "authorization");

  if (existingIndex >= 0) {
    const existingValue = String(next[existingIndex].value || "").trim();
    if (existingValue) return null;

    next[existingIndex] = { name: "Authorization", value: authValue };
    return next;
  }

  next.push({ name: "Authorization", value: authValue });
  return next;
}

/**
 * Return true when Authorization should be injected for this request.
 *
 * @param {string} tabUrl - URL of the tab that initiated the request.
 * @param {string} requestUrl - Outgoing request URL.
 * @returns {boolean} Whether to inject Authorization.
 */
function shouldInjectSwaggerAuth(tabUrl, requestUrl) {
  try {
    const tab = new URL(tabUrl);
    const request = new URL(requestUrl);

    if (/\.(js|css|html?|png|jpe?g|gif|svg|ico|woff2?|ttf|map)$/i.test(request.pathname)) {
      return false;
    }

    if (request.href === tab.href) return false;

    return true;
  } catch {
    return true;
  }
}

/**
 * Inject Authorization on requests initiated from a Swagger tab when blocking webRequest is supported.
 * Chromium relies on the page-context Swagger bridge; Firefox uses this path in addition.
 * Applies to all HTTP methods (GET, POST, PUT, PATCH, DELETE, etc.).
 *
 * @param {browser.webRequest.WebRequestHeadersDetails} details - Request details.
 * @returns {Promise<object|undefined>} Blocking response or undefined.
 */
async function injectSwaggerAuthHeaders(details) {
  try {
    if (!swaggerConfig.swaggerAutoApply) {
      logSwaggerDebug("skip", "auto-apply is disabled");
      return undefined;
    }

    if (details.tabId === undefined || details.tabId < 0) {
      logSwaggerDebug("skip", "request has no tabId (not from a browser tab)", {
        method: details.method,
        url: sanitizeUrl(details.url),
        tabId: details.tabId,
      });
      return undefined;
    }

    let tab;
    try {
      tab = await browser.tabs.get(details.tabId);
    } catch (err) {
      console.warn("[token-copier] Could not read tab for Swagger injection:", err);
      return undefined;
    }

    const tabUrl = tab?.url || "";
    if (!tabUrl || isInternalBrowserUrl(tabUrl)) {
      return undefined;
    }

    const swaggerDetected = isSwaggerUrl(tabUrl);

    if (!swaggerDetected) {
      if (isSwaggerLikeUrl(tabUrl) || isSwaggerLikeUrl(details.url)) {
        logSwaggerDebug("detect", "Swagger-like URL did not match isSwaggerUrl", {
          tabUrl,
          tabIsSwaggerUrl: swaggerDetected,
          requestUrl: sanitizeUrl(details.url),
          method: details.method,
        });
      }
      return undefined;
    }

    logSwaggerDebug("detect", "Swagger tab matched", {
      tabUrl,
      requestUrl: sanitizeUrl(details.url),
      method: details.method,
      tabId: details.tabId,
    });

    if (!shouldInjectSwaggerAuth(tabUrl, details.url)) {
      logSwaggerDebug("skip", "request filtered by shouldInjectSwaggerAuth", {
        tabUrl,
        requestUrl: sanitizeUrl(details.url),
        method: details.method,
      });
      return undefined;
    }

    if (hasAuthorizationHeader(details.requestHeaders)) {
      logSwaggerDebug("skip", "request already has Authorization header", {
        requestUrl: sanitizeUrl(details.url),
        method: details.method,
      });
      return undefined;
    }

    const token = await getCachedSwaggerToken(tab);
    const normalized = normalizeToken(token);
    if (!normalized) {
      logSwaggerDebug("skip", "no stored token available for injection", {
        tabUrl,
        requestUrl: sanitizeUrl(details.url),
        method: details.method,
      });
      return undefined;
    }

    const requestHeaders = injectAuthorizationHeaderIfMissing(details.requestHeaders, normalized);
    if (!requestHeaders) {
      logSwaggerDebug("skip", "Authorization header unchanged", {
        requestUrl: sanitizeUrl(details.url),
        method: details.method,
      });
      return undefined;
    }

    logSwaggerDebug("inject", "Authorization header applied", {
      tabUrl,
      requestUrl: sanitizeUrl(details.url),
      method: details.method,
      tokenPreview: redactSecret(normalized, 12),
    });

    return { requestHeaders };
  } catch (err) {
    console.warn("[token-copier] Swagger header injection failed:", err);
    return undefined;
  }
}

/**
 * Inspect outgoing request headers for a token and optionally inject Swagger auth.
 *
 * @param {browser.webRequest.WebRequestHeadersDetails} details - Request details.
 * @returns {Promise<object|undefined>|object|undefined} Blocking response when supported.
 */
function handleBeforeSendHeaders(details) {
  processIntercept(details, details.requestHeaders, "request");

  if (!blockingRequestHeadersSupported || !swaggerConfig.swaggerAutoApply) {
    return undefined;
  }

  return injectSwaggerAuthHeaders(details).catch((err) => {
    console.warn("[token-copier] Swagger header injection promise rejected:", err);
    return undefined;
  });
}

/**
 * Inspect incoming response headers for a token.
 *
 * @param {browser.webRequest.WebRequestHeadersDetails} details - Response details.
 * @returns {void}
 */
function handleResponseHeaders(details) {
  processIntercept(details, details.responseHeaders, "response");
}

/**
 * Shared handler for request and response header interception.
 *
 * @param {browser.webRequest.WebRequestHeadersDetails} details - webRequest details.
 * @param {browser.HttpHeader[]|undefined} headers - Headers to scan.
 * @param {"request"|"response"} phase - Whether headers are from request or response.
 * @returns {void}
 */
function processIntercept(details, headers, phase) {
  try {
    if (!config.responseDomain || !headers?.length) return;
    if (!isAllowedMethod(details.method)) return;

    const requestHostname = hostnameFromUrl(details.url);
    if (!requestHostname) return;

    if (!hostnameMatches(requestHostname, config.responseDomain)) {
      return;
    }

    if (DEBUG) {
      logMatchedTraffic(details, phase, headers);
    }

    const token = findTokenInHeaders(headers, details, phase);
    if (token) {
      if (DEBUG) {
        console.log("[token-copier] Token captured", {
          phase,
          method: details.method,
          url: sanitizeUrl(details.url),
          domain: config.responseDomain,
          tokenPreview: redactSecret(token, 12),
        });
      }
      saveInterceptedToken(token, config.responseDomain);
      recordInterceptStatus(config.responseDomain, details, true);
      return;
    }

    if (DEBUG) {
      console.log("[token-copier] Matched traffic, no token in headers", {
        phase,
        method: details.method,
        url: sanitizeUrl(details.url),
        lookingFor: config.headerName,
      });
    }

    recordInterceptStatus(config.responseDomain, details, false);
  } catch (err) {
    console.error("[token-copier] Error processing headers:", err, {
      url: details.url,
      requestId: details.requestId,
    });
  }
}

/**
 * Return true for GET and POST requests only.
 *
 * @param {string} method - HTTP method from webRequest details.
 * @returns {boolean} Whether the request should be processed.
 */
function isAllowedMethod(method) {
  return ALLOWED_METHODS.has(String(method || "").toUpperCase());
}

/**
 * Log auth-related headers on matched GET/POST traffic for debugging.
 *
 * @param {browser.webRequest.WebRequestHeadersDetails} details - webRequest details.
 * @param {"request"|"response"} phase - Request or response phase.
 * @param {browser.HttpHeader[]} headers - Headers to inspect.
 * @returns {void}
 */
function logMatchedTraffic(details, phase, headers) {
  const authHeaders = headers.filter((header) => {
    const name = header.name?.toLowerCase() || "";
    return name === config.headerName || name === "authorization" || name === "set-cookie";
  });

  console.log("[token-copier] Matched GET/POST", {
    phase,
    method: details.method,
    url: sanitizeUrl(details.url),
    host: hostnameFromUrl(details.url),
    responseDomain: config.responseDomain,
    authHeaderCount: authHeaders.length,
  });

  for (const header of authHeaders) {
    const name = header.name.toLowerCase();
    if (name === "set-cookie") {
      console.log("[token-copier] Set-Cookie header:", redactSecret(header.value, 12));
      continue;
    }

    console.log(`[token-copier] ${header.name} header:`, redactSecret(header.value));
  }
}

/**
 * Scan headers for a configured auth header or Set-Cookie token.
 *
 * @param {browser.HttpHeader[]} headers - Request or response headers.
 * @param {browser.webRequest.WebRequestHeadersDetails} [details] - webRequest details for logging.
 * @param {"request"|"response"} [phase] - Request or response phase for logging.
 * @returns {string|null} Normalized token or null.
 */
function findTokenInHeaders(headers, details, phase) {
  for (const header of headers) {
    if (!header?.name || !header.value) continue;

    const name = header.name.toLowerCase();

    if (name === config.headerName) {
      if (DEBUG) {
        console.log("[token-copier] Found configured auth header", {
          phase,
          header: header.name,
          value: redactSecret(header.value),
          url: sanitizeUrl(details?.url || ""),
        });
      }
      const token = normalizeToken(header.value);
      if (token) return token;
    }

    if (name === "set-cookie") {
      const pattern = buildCookieRegex(config.cookieName);
      if (!pattern) continue;

      const match = header.value.match(pattern);
      if (match?.[1]) {
        if (DEBUG) {
          console.log("[token-copier] Found Set-Cookie match", {
            phase,
            cookieName: config.cookieName,
            url: details?.url,
          });
        }
        const decoded = safeDecodeURIComponent(match[1]);
        const token = normalizeToken(decoded);
        if (token) return token;
      }
    }
  }

  return null;
}

/**
 * Record GET/POST activity for the configured domain.
 *
 * @param {string} domain - Configured hostname.
 * @param {browser.webRequest.WebRequestHeadersDetails} details - webRequest details.
 * @param {boolean} tokenFound - Whether a token was captured.
 * @returns {void}
 */
function recordInterceptStatus(domain, details, tokenFound) {
  const pending = pendingStatusUpdates.get(domain) || {
    count: 0,
    tokenFound: false,
    details,
    timer: null,
  };

  pending.count += 1;
  pending.tokenFound = tokenFound || pending.tokenFound;
  pending.details = details;

  if (pending.timer) clearTimeout(pending.timer);
  pending.timer = setTimeout(() => flushInterceptStatus(domain), INTERCEPT_STATUS_DEBOUNCE_MS);
  pendingStatusUpdates.set(domain, pending);
}

/**
 * Flush batched intercept status updates to storage.
 *
 * @param {string} domain - Configured hostname.
 * @returns {void}
 */
function flushInterceptStatus(domain) {
  const pending = pendingStatusUpdates.get(domain);
  if (!pending) return;

  pendingStatusUpdates.delete(domain);

  browser.storage.local
    .get(["interceptStatus"])
    .then((data) => {
      const interceptStatus = { ...(data.interceptStatus || {}) };
      const existing = interceptStatus[domain] || { requestCount: 0, tokenFound: false };

      interceptStatus[domain] = {
        requestCount: existing.requestCount + pending.count,
        tokenFound: pending.tokenFound || existing.tokenFound,
        lastMethod: pending.details.method,
        lastUrl: sanitizeUrl(pending.details.url),
        lastSeenAt: Date.now(),
      };

      return browser.storage.local.set({ interceptStatus });
    })
    .catch((err) => {
      console.error("[token-copier] Failed to record intercept status:", err);
    });
}

function saveInterceptedToken(token, domain) {
  if (!token || !domain) return;

  browser.storage.local
    .get(["interceptedTokens", "interceptStatus"])
    .then((data) => {
      if (data.interceptedTokens?.[domain] === token) {
        return undefined;
      }

      const interceptedTokens = { ...(data.interceptedTokens || {}), [domain]: token };
      const interceptStatus = { ...(data.interceptStatus || {}) };
      const existing = interceptStatus[domain] || { requestCount: 0, tokenFound: false };

      interceptStatus[domain] = {
        ...existing,
        tokenFound: true,
        lastSeenAt: Date.now(),
      };

      return browser.storage.local.set({ interceptedTokens, interceptStatus });
    })
    .then((result) => {
      if (result !== undefined) invalidateSwaggerTokenCache();
    })
    .catch((err) => {
      console.error("[token-copier] Failed to save intercepted token:", err);
    });
}

function buildCookieRegex(name) {
  if (!name) return null;

  try {
    return new RegExp(`(?:^|;\\s*)${escapeRegex(name)}=([^;]+)`);
  } catch (err) {
    console.error("[token-copier] Invalid cookie name for regex:", name, err);
    return null;
  }
}

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
