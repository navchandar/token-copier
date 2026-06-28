/**
 * Resolve the configured bearer token from storage, cookies, or interception.
 */

/**
 * Decode a cookie value without throwing on malformed encodings.
 *
 * @param {string} value - Raw cookie value.
 * @returns {string} Decoded value.
 */
function safeDecodeCookieValue(value) {
  return safeDecodeURIComponent(value);
}

/**
 * Find a token stored under a sibling hostname that matches the configured domain.
 *
 * @param {Record<string, string>} tokens - Stored intercepted tokens.
 * @param {string} domain - Configured hostname.
 * @returns {string|null} Token value or null.
 */
function findTokenForSiblingDomain(tokens, domain) {
  if (!tokens || !domain) return null;

  for (const [storedDomain, token] of Object.entries(tokens)) {
    if (hostnameMatches(storedDomain, domain) || hostnameMatches(domain, storedDomain)) {
      return token;
    }
  }
  return null;
}

/**
 * Find a cookie using URL, domain, and cookie-store aware lookups.
 *
 * @param {string} domain - Configured hostname.
 * @param {string} cookieName - Cookie name to find.
 * @param {{ url?: string, cookieStoreId?: string }|null} tab - Tab info for lookup context.
 * @param {typeof browser} browserApi - Extension browser API.
 * @returns {Promise<browser.cookies.Cookie|null>} Matching cookie or null.
 */
async function findCookieForDomain(domain, cookieName, tab, browserApi) {
  if (!domain || !cookieName) return null;

  try {
    const storeQuery = tab?.cookieStoreId ? { storeId: tab.cookieStoreId } : {};
    const candidates = [];
    const lookupUrls = buildCookieLookupUrls(domain, tab?.url || null);

    for (const url of lookupUrls) {
      candidates.push(...(await browserApi.cookies.getAll({ ...storeQuery, url, name: cookieName })));
    }

    candidates.push(...(await browserApi.cookies.getAll({ ...storeQuery, domain, name: cookieName })));

    const byName = await browserApi.cookies.getAll({ ...storeQuery, name: cookieName });
    candidates.push(...byName.filter((cookie) => cookieDomainMatches(cookie.domain, domain)));

    return pickBestCookie(dedupeCookies(candidates), domain);
  } catch (err) {
    console.warn("[token-copier] Cookie lookup failed:", err);
    return null;
  }
}

/**
 * Read an intercepted response token for the configured domain.
 *
 * @param {Record<string, string>|undefined} tokens - Stored intercepted tokens.
 * @param {string} domain - Normalized hostname.
 * @returns {string|null} Token or null when not found.
 */
function getResponseToken(tokens, domain) {
  if (!tokens || !domain) return null;
  return tokens[domain] || findTokenForSiblingDomain(tokens, domain) || null;
}

/**
 * Load settings and resolve the active bearer token for the given tab.
 *
 * @param {typeof browser} browserApi - Extension browser API.
 * @param {{ url?: string, cookieStoreId?: string }|null} tab - Tab used for cookie lookup.
 * @param {object} [overrides] - Optional setting overrides from the popup form.
 * @returns {Promise<string|null>} Token value or null when unavailable.
 */
async function getStoredToken(browserApi, tab, overrides = {}) {
  try {
    const stored = await browserApi.storage.local.get([
      "tokenSource",
      "cookieDomain",
      "responseDomain",
      "cookieName",
      "interceptedTokens",
      "targetDomain",
    ]);

    const source = overrides.tokenSource || stored.tokenSource || "cookie";
    const cookieName = overrides.cookieName || stored.cookieName || "token";

    if (source === "response") {
      const domain = parseHostname(
        overrides.responseDomain || stored.responseDomain || stored.targetDomain || ""
      );
      return normalizeToken(getResponseToken(stored.interceptedTokens, domain));
    }

    const domain = parseHostname(
      overrides.cookieDomain || stored.cookieDomain || stored.targetDomain || ""
    );
    if (!domain) return null;

    const cookie = await findCookieForDomain(domain, cookieName, tab, browserApi);
    if (!cookie?.value) return null;

    return normalizeToken(safeDecodeCookieValue(cookie.value));
  } catch (err) {
    console.warn("[token-copier] Failed to resolve stored token:", err);
    return null;
  }
}
