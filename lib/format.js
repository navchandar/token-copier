/**
 * Shared string formatting helpers for tokens, URLs, and safe logging.
 */

/**
 * Strip an optional Bearer prefix and trim whitespace.
 *
 * @param {string|null|undefined} value - Raw header or cookie value.
 * @returns {string|null} Normalized token or null when empty.
 */
function normalizeToken(value) {
  if (!value) return null;
  const stripped = String(value).replace(/^Bearer\s+/i, "").trim();
  return stripped || null;
}

/**
 * Decode a URI component without throwing on malformed encodings.
 *
 * @param {string} value - Encoded string.
 * @returns {string} Decoded value, or the original on failure.
 */
function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Redact a secret for console output.
 *
 * @param {string} value - Raw secret value.
 * @param {number} [visible=8] - Number of leading characters to show.
 * @returns {string} Redacted representation.
 */
function redactSecret(value, visible = 8) {
  const text = String(value || "");
  if (!text) return "(empty)";
  if (text.length <= visible) return `${text.slice(0, 2)}…`;
  return `${text.slice(0, visible)}… (${text.length} chars)`;
}

/**
 * Remove query strings and fragments before persisting or logging URLs.
 *
 * @param {string} url - Full request URL.
 * @returns {string} Sanitized URL.
 */
function sanitizeUrl(url) {
  if (!url) return "";

  try {
    const parsed = new URL(url);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}
