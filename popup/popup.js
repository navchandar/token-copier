const browser = getBrowserApi();

/* ── DOM refs ──────────────────────────────────────────── */
const sourceSelect        = document.getElementById("source-select");
const cookieSection       = document.getElementById("cookie-section");
const responseSection     = document.getElementById("response-section");
const cookieDomainInput   = document.getElementById("cookie-domain");
const responseDomainInput = document.getElementById("response-domain");
const cookieNameInput     = document.getElementById("cookie-name");
const headerNameInput     = document.getElementById("header-name");
const copyBtn             = document.getElementById("copy-btn");
const statusDiv           = document.getElementById("status");
const previewDiv          = document.getElementById("token-preview");
const previewText         = document.getElementById("preview-text");
const swaggerAutoApplyInput = document.getElementById("swagger-auto-apply");
const swaggerSchemeInput  = document.getElementById("swagger-scheme");

const SETTINGS_SAVE_DELAY_MS = 450;
let settingsSaveTimer = null;
let isInitializing = true;

/* ── Initialise from storage ──────────────────────────── */
browser.storage.local
  .get([
    "cookieName",
    "headerName",
    "tokenSource",
    "cookieDomain",
    "responseDomain",
    "targetDomain",
    "swaggerAutoApply",
    "swaggerSchemeName",
  ])
  .then(async (cfg) => {
    cookieNameInput.value = cfg.cookieName || "token";
    headerNameInput.value = cfg.headerName || "authorization";
    if (cfg.tokenSource) {
      sourceSelect.value = cfg.tokenSource;
    }

    const legacyDomain = cfg.targetDomain || null;
    const tabDomain = await getActiveTabDomain();

    cookieDomainInput.value = cfg.cookieDomain || legacyDomain || tabDomain || "";
    responseDomainInput.value = cfg.responseDomain || legacyDomain || tabDomain || "";
    swaggerAutoApplyInput.checked = Boolean(cfg.swaggerAutoApply);
    swaggerSchemeInput.value = cfg.swaggerSchemeName || "";

    toggleSections();
    isInitializing = false;
  })
  .catch((err) => {
    showStatus(`Failed to load settings: ${err.message}`, "error");
  });

/* ── Auto-save settings ───────────────────────────────── */
/**
 * Schedule a debounced persist of popup settings.
 *
 * @returns {void}
 */
function scheduleSettingsSave() {
  if (isInitializing) return;

  if (settingsSaveTimer) clearTimeout(settingsSaveTimer);
  settingsSaveTimer = setTimeout(() => {
    settingsSaveTimer = null;
    persistSettings().catch((err) => {
      console.warn("[token-copier] Failed to save settings:", err);
    });
  }, SETTINGS_SAVE_DELAY_MS);
}

/**
 * Persist all popup settings to extension storage.
 *
 * @returns {Promise<void>}
 */
async function persistSettings() {
  try {
    const payload = {
      tokenSource: sourceSelect.value,
      cookieName: cookieNameInput.value.trim() || "token",
      headerName: headerNameInput.value.trim() || "authorization",
      swaggerAutoApply: swaggerAutoApplyInput.checked,
      swaggerSchemeName: swaggerSchemeInput.value.trim(),
    };

    const cookieDomain = parseHostname(cookieDomainInput.value);
    if (cookieDomain) {
      payload.cookieDomain = cookieDomain;
      cookieDomainInput.value = cookieDomain;
    }

    const responseDomain = parseHostname(responseDomainInput.value);
    if (responseDomain) {
      payload.responseDomain = responseDomain;
      responseDomainInput.value = responseDomain;
    }

    await browser.storage.local.set(payload);
  } catch (err) {
    console.warn("[token-copier] Failed to save settings:", err);
    throw err;
  }
}

/**
 * Persist any pending debounced settings immediately.
 *
 * @returns {Promise<void>}
 */
async function flushSettingsSave() {
  if (settingsSaveTimer) {
    clearTimeout(settingsSaveTimer);
    settingsSaveTimer = null;
  }
  await persistSettings();
}

[
  cookieDomainInput,
  responseDomainInput,
  cookieNameInput,
  headerNameInput,
  swaggerSchemeInput,
].forEach((input) => {
  input.addEventListener("input", scheduleSettingsSave);
});

/* ── Source toggle ─────────────────────────────────────── */
sourceSelect.addEventListener("change", () => {
  toggleSections();
  persistSettings().catch((err) => {
    console.warn("[token-copier] Failed to save token source:", err);
  });
});

swaggerAutoApplyInput.addEventListener("change", () => {
  persistSettings().catch((err) => {
    console.warn("[token-copier] Failed to save Swagger settings:", err);
  });
});

function toggleSections() {
  const isCookie = sourceSelect.value === "cookie";
  cookieSection.classList.toggle("hidden", !isCookie);
  responseSection.classList.toggle("hidden", isCookie);
}

/* ── Copy button ──────────────────────────────────────── */
copyBtn.addEventListener("click", async () => {
  hideStatus();
  hidePreview();

  try {
    await flushSettingsSave();

    const cookieName = cookieNameInput.value.trim() || "token";
    let token;

    if (sourceSelect.value === "cookie") {
      const domain = getConfiguredCookieDomain();
      token = await getTokenFromCookie(domain);
      if (!token) {
        throw new Error(
          `Cookie "${cookieName}" not found for ${domain}. Check the cookie name and domain, then try again.`
        );
      }
    } else {
      const domain = getConfiguredResponseDomain();
      token = await getTokenFromResponse(domain);
    }

    token = token.replace(/^Bearer\s+/i, "");

    await navigator.clipboard.writeText(token);
    showPreview(token);

    const copyStatus = buildCopyStatusMessage(token);
    showStatus(copyStatus.message, copyStatus.type);
  } catch (err) {
    showStatus(`❌ ${err.message}`, "error");
  }
});

/**
 * Return hostname from the active tab when available.
 *
 * @returns {Promise<string|null>} Normalized hostname or null.
 */
async function getActiveTabDomain() {
  try {
    const tab = await getActiveTab();
    return tab?.url ? parseHostname(tab.url) : null;
  } catch (err) {
    console.warn("[token-copier] Could not read active tab domain:", err);
    return null;
  }
}

/**
 * Return the cookie-mode domain from input.
 *
 * @returns {string} Normalized hostname.
 */
function getConfiguredCookieDomain() {
  const domain = parseHostname(cookieDomainInput.value);
  if (!domain) {
    throw new Error("Cookie domain is not configured - enter a hostname");
  }
  return domain;
}

/**
 * Return the response-mode domain from input.
 *
 * @returns {string} Normalized hostname.
 */
function getConfiguredResponseDomain() {
  const domain = parseHostname(responseDomainInput.value);
  if (!domain) {
    throw new Error("Response domain is not configured - enter a hostname");
  }
  return domain;
}

/**
 * Read the auth cookie for the configured domain.
 *
 * @param {string} domain - Normalized hostname.
 * @returns {Promise<string|null>} Cookie value or null when not found.
 */
async function getTokenFromCookie(domain) {
  const tab = await getActiveTab();
  return getStoredToken(browser, tab, {
    tokenSource: "cookie",
    cookieDomain: domain,
    cookieName: cookieNameInput.value.trim() || "token",
  });
}

/**
 * Return the active tab when available.
 *
 * @returns {Promise<{ url?: string, cookieStoreId?: string }|null>} Active tab or null.
 */
async function getActiveTab() {
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    return tabs[0] || null;
  } catch (err) {
    console.warn("[token-copier] Could not read active tab:", err);
    return null;
  }
}

/**
 * Read the most recently intercepted token for the configured domain.
 *
 * @param {string} domain - Normalized hostname.
 * @returns {Promise<string>} Intercepted token.
 */
async function getTokenFromResponse(domain) {
  try {
    const headerName = headerNameInput.value.trim() || "authorization";
    const cookieName = cookieNameInput.value.trim() || "token";

    const data = await browser.storage.local.get(["interceptedTokens", "interceptStatus"]);
    const tokens = data.interceptedTokens || {};
    const status = data.interceptStatus?.[domain];

    if (tokens[domain]) {
      return tokens[domain];
    }

    const siblingToken = findTokenForSiblingDomain(tokens, domain);
    if (siblingToken) {
      return siblingToken;
    }

    const otherDomains = Object.keys(tokens);
    if (otherDomains.length > 0) {
      throw new Error(
        `No intercepted token for ${domain}. Tokens are available for: ${otherDomains.join(", ")}.`
      );
    }

    if (!status || status.requestCount === 0) {
      throw new Error(
        `No GET/POST requests intercepted for ${domain}. Trigger an API request on that domain, then try again.`
      );
    }

    throw new Error(
      `${status.requestCount} GET/POST request(s) seen for ${domain}, but no token in request/response "${headerName}" or Set-Cookie "${cookieName}". OAuth /token responses often return JSON only - use Cookie mode or an API call that sends Authorization. Last: ${status.lastMethod} ${truncateUrl(status.lastUrl)}`
    );
  } catch (err) {
    if (err instanceof Error) throw err;
    throw new Error("Failed to read intercepted token from storage.");
  }
}

/**
 * Shorten a URL for display in status messages (query/hash stripped).
 *
 * @param {string} url - Full request URL.
 * @returns {string} Truncated URL.
 */
function truncateUrl(url) {
  const sanitized = sanitizeUrl(url);
  return sanitized.length > 60 ? `${sanitized.slice(0, 57)}...` : sanitized;
}

/* ── UI helpers ───────────────────────────────────────── */
function showStatus(msg, type) {
  statusDiv.textContent = msg;
  statusDiv.className = `status ${type}`;
  statusDiv.classList.remove("hidden");

  setTimeout(hideStatus, 5000);
}

function hideStatus() {
  statusDiv.classList.add("hidden");
}

function showPreview(token) {
  const preview = token.length > 30 ? token.substring(0, 30) + "…" : token;
  previewText.textContent = preview;
  previewDiv.classList.remove("hidden");
}

function hidePreview() {
  previewDiv.classList.add("hidden");
}
