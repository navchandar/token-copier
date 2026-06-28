/**
 * Hostname parsing, matching, and cookie lookup helpers.
 */

/**
 * Parse user input into a lowercase hostname (no port).
 *
 * @param {string} input - Hostname or URL entered by the user.
 * @returns {string|null} Normalized hostname, or null if invalid.
 */
function parseHostname(input) {
  const trimmed = String(input || "").trim();
  if (!trimmed) return null;

  try {
    const url = trimmed.includes("://") ? new URL(trimmed) : new URL(`https://${trimmed}`);
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Build an https origin URL for cookie API lookups.
 *
 * @param {string} hostname - Normalized hostname.
 * @returns {string|null} Origin URL or null when hostname is empty.
 */
function originFromHostname(hostname) {
  if (!hostname) return null;
  return `https://${hostname}/`;
}

/**
 * Check whether a cookie's domain attribute covers the configured hostname.
 *
 * @param {string} cookieDomain - Domain from a cookie object.
 * @param {string} configuredHostname - User-configured hostname.
 * @returns {boolean} True when the cookie would be sent to the configured host.
 */
function cookieDomainMatches(cookieDomain, configuredHostname) {
  if (!cookieDomain || !configuredHostname) return false;

  const normalizedCookieDomain = cookieDomain.replace(/^\./, "").toLowerCase();
  const host = configuredHostname.toLowerCase();

  return host === normalizedCookieDomain || host.endsWith(`.${normalizedCookieDomain}`);
}

/**
 * Build candidate URLs for cookies.get / cookies.getAll, including scheme and port.
 *
 * @param {string} domain - Configured hostname.
 * @param {string|null} [tabUrl] - Optional active tab URL for port/scheme hints.
 * @returns {string[]} Unique lookup URLs, most specific first.
 */
function buildCookieLookupUrls(domain, tabUrl = null) {
  const urls = [];

  if (tabUrl) {
    try {
      const parsed = new URL(tabUrl);
      if (hostnameMatches(parsed.hostname, domain)) {
        urls.push(`${parsed.origin}/`);
        if (parsed.protocol === "https:") {
          urls.push(`http://${parsed.host}/`);
        }
      }
    } catch {
      // Ignore invalid tab URLs.
    }
  }

  urls.push(`http://${domain}/`, `https://${domain}/`);

  return [...new Set(urls)];
}

/**
 * Deduplicate cookie objects returned from multiple lookup strategies.
 *
 * @param {browser.cookies.Cookie[]} cookies - Candidate cookies.
 * @returns {browser.cookies.Cookie[]} Unique cookies.
 */
function dedupeCookies(cookies) {
  const seen = new Set();

  return cookies.filter((cookie) => {
    const key = `${cookie.name}|${cookie.domain}|${cookie.path}|${cookie.storeId || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Pick the cookie that best matches the configured domain.
 *
 * @param {browser.cookies.Cookie[]} cookies - Candidate cookies.
 * @param {string} domain - Configured hostname.
 * @returns {browser.cookies.Cookie|null} Best matching cookie or null.
 */
function pickBestCookie(cookies, domain) {
  if (!cookies.length) return null;

  const normalizedDomain = domain.toLowerCase();
  const exactMatch = cookies.find(
    (cookie) => cookie.domain.replace(/^\./, "").toLowerCase() === normalizedDomain
  );

  return exactMatch || cookies.find((cookie) => cookieDomainMatches(cookie.domain, domain)) || null;
}

/**
 * Extract a coarse organization domain (e.g. example.com).
 *
 * @param {string} hostname - Full hostname.
 * @returns {string} Organization domain suffix.
 */
function getOrganizationDomain(hostname) {
  const parts = hostname.toLowerCase().split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  return parts.slice(-2).join(".");
}

/**
 * Check whether a request hostname matches the configured domain.
 *
 * @param {string} requestHostname - Hostname from an intercepted URL.
 * @param {string} configuredHostname - User-configured domain.
 * @returns {boolean} True when the hosts are considered a match.
 */
function hostnameMatches(requestHostname, configuredHostname) {
  if (!requestHostname || !configuredHostname) return false;

  const host = requestHostname.toLowerCase();
  const domain = configuredHostname.toLowerCase();

  if (host === domain || host.endsWith(`.${domain}`) || domain.endsWith(`.${host}`)) {
    return true;
  }

  const hostParts = host.split(".").filter(Boolean);
  const domainParts = domain.split(".").filter(Boolean);
  if (hostParts.length > 2 && domainParts.length > 2) {
    return getOrganizationDomain(host) === getOrganizationDomain(domain);
  }

  return false;
}

/**
 * Extract the hostname from a full request URL.
 *
 * @param {string} url - Request URL from webRequest details.
 * @returns {string|null} Lowercase hostname or null when parsing fails.
 */
function hostnameFromUrl(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Return true when a tab URL appears to host Swagger UI or similar API docs.
 *
 * @param {string} url - Full page URL.
 * @returns {boolean} Whether the URL looks like a Swagger/OpenAPI page.
 */
function isSwaggerUrl(url) {
  if (isInternalBrowserUrl(url)) {
    return false;
  }

  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    const href = parsed.href.toLowerCase();

    return (
      path.includes("swagger") ||
      path.includes("openapi") ||
      href.includes("swagger-ui")
    );
  } catch {
    return false;
  }
}
