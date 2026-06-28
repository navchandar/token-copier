/**
 * Token format detection and post-copy validation messages.
 */

/**
 * Decode a Base64URL-encoded string.
 *
 * @param {string} segment - Base64URL-encoded segment.
 * @returns {string|null} Decoded UTF-8 string or null when invalid.
 */
function decodeBase64Url(segment) {
  try {
    const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    return atob(padded);
  } catch {
    return null;
  }
}

/**
 * Parse a JSON object from a Base64URL-encoded segment.
 *
 * @param {string} segment - Base64URL-encoded JSON segment.
 * @returns {Record<string, unknown>|null} Parsed object or null.
 */
function parseBase64UrlJson(segment) {
  const decoded = decodeBase64Url(segment);
  if (!decoded) return null;

  try {
    const value = JSON.parse(decoded);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

/**
 * Pluralize a time unit label.
 *
 * @param {number} count - Unit count.
 * @param {string} singular - Singular label.
 * @param {string} plural - Plural label.
 * @returns {string} Label for the count.
 */
function pluralizeUnit(count, singular, plural) {
  return count === 1 ? singular : plural;
}

/**
 * Format a millisecond duration as a human-readable relative time.
 *
 * @param {number} diffMs - Duration in milliseconds (absolute value used).
 * @param {"future"|"past"} direction - Whether the target is ahead or behind now.
 * @returns {string} Relative phrase such as "in 5 mins" or "2 hours ago".
 */
function formatRelativeDuration(diffMs, direction) {
  const absMs = Math.abs(diffMs);

  const units = [
    { singular: "year", plural: "years", ms: 365 * 24 * 60 * 60 * 1000 },
    { singular: "month", plural: "months", ms: 30 * 24 * 60 * 60 * 1000 },
    { singular: "week", plural: "weeks", ms: 7 * 24 * 60 * 60 * 1000 },
    { singular: "day", plural: "days", ms: 24 * 60 * 60 * 1000 },
    { singular: "hour", plural: "hours", ms: 60 * 60 * 1000 },
    { singular: "min", plural: "mins", ms: 60 * 1000 },
  ];

  for (const unit of units) {
    const count = Math.floor(absMs / unit.ms);
    if (count >= 1) {
      const label = pluralizeUnit(count, unit.singular, unit.plural);
      if (direction === "future") return `in ${count} ${label}`;
      return `${count} ${label} ago`;
    }
  }

  if (direction === "future") return "in a min";
  return "just now";
}

/**
 * Format a Unix timestamp relative to now.
 *
 * @param {number} unixSeconds - Timestamp in seconds.
 * @param {number} [nowMs=Date.now()] - Current time in milliseconds.
 * @returns {{ future: boolean, past: boolean, text: string }} Relative time text.
 */
function formatRelativeTime(unixSeconds, nowMs = Date.now()) {
  const diffMs = unixSeconds * 1000 - nowMs;

  if (diffMs > 0) {
    return { future: true, past: false, text: formatRelativeDuration(diffMs, "future") };
  }

  if (diffMs < 0) {
    return { future: false, past: true, text: formatRelativeDuration(diffMs, "past") };
  }

  return { future: false, past: false, text: "now" };
}

/**
 * Return true when a segment looks like Base64URL data.
 *
 * @param {string} segment - Token segment.
 * @returns {boolean} Whether the segment matches Base64URL shape.
 */
function isBase64UrlSegment(segment) {
  return typeof segment === "string" && segment.length > 0 && /^[A-Za-z0-9_-]+$/.test(segment);
}

/**
 * Parse the payload object from a JWT/JWS string.
 *
 * @param {string} token - Raw JWT token.
 * @returns {Record<string, unknown>|null} Parsed payload or null when not a JWT.
 */
function parseJwtPayload(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || !parts.every(isBase64UrlSegment)) return null;
  return parseBase64UrlJson(parts[1]);
}

/**
 * Parse the payload from a PASETO public token.
 *
 * @param {string} token - Raw PASETO token.
 * @returns {Record<string, unknown>|null} Parsed payload or null.
 */
function parsePasetoPublicPayload(token) {
  const parts = String(token || "").split(".");
  if (parts.length < 4) return null;
  if (parts[0] !== "v3" && parts[0] !== "v4") return null;
  if (parts[1] !== "public") return null;
  if (!isBase64UrlSegment(parts[2])) return null;
  return parseBase64UrlJson(parts[2]);
}

/**
 * Detect the most likely token format.
 *
 * @param {string} token - Raw token value.
 * @returns {"jwt"|"jwe"|"paseto-public"|"paseto-local"|"opaque"} Token type.
 */
function detectTokenType(token) {
  const value = String(token || "").trim();
  const parts = value.split(".");

  if (/^v[34]\.(public|local)\./.test(value)) {
    return parts[1] === "public" ? "paseto-public" : "paseto-local";
  }

  if (parts.length === 5 && parts.every(isBase64UrlSegment)) {
    return "jwe";
  }

  if (parseJwtPayload(value)) {
    return "jwt";
  }

  return "opaque";
}

/**
 * Evaluate exp/nbf time claims from a parsed token payload.
 *
 * @param {Record<string, unknown>} payload - Parsed token payload.
 * @returns {{ state: "valid"|"expired"|"not-yet-valid"|"no-expiry", expiresAt?: string, notBefore?: string }} Result.
 */
function evaluateTimeClaims(payload) {
  const now = Date.now();

  if (typeof payload.nbf === "number" && now < payload.nbf * 1000) {
    return {
      state: "not-yet-valid",
      notBefore: formatRelativeTime(payload.nbf, now).text,
    };
  }

  if (typeof payload.exp === "number") {
    if (now >= payload.exp * 1000) {
      return {
        state: "expired",
        expiresAt: formatRelativeTime(payload.exp, now).text,
      };
    }

    return {
      state: "valid",
      expiresAt: formatRelativeTime(payload.exp, now).text,
    };
  }

  return { state: "no-expiry" };
}

/**
 * Build a Swagger page warning when a token's time claims are invalid.
 *
 * @param {string} token - Raw token value.
 * @returns {{ message: string, severity: "warn" }|null} Warning text or null when not applicable.
 */
function getTokenExpiryWarning(token) {
  const type = detectTokenType(token);

  if (type !== "jwt" && type !== "paseto-public") {
    return null;
  }

  const payload = type === "jwt" ? parseJwtPayload(token) : parsePasetoPublicPayload(token);
  if (!payload) return null;

  const label = type === "jwt" ? "JWT" : "PASETO";
  const time = evaluateTimeClaims(payload);

  if (time.state === "expired") {
    return {
      message: `Token Copier: ${label} token expired ${time.expiresAt}. Refresh your session — Swagger requests may return 401.`,
      severity: "warn",
    };
  }

  if (time.state === "not-yet-valid") {
    return {
      message: `Token Copier: ${label} token is not valid yet — valid ${time.notBefore}.`,
      severity: "warn",
    };
  }

  return null;
}

/**
 * Build the post-copy status message for a token.
 *
 * @param {string} token - Copied token value.
 * @returns {{ message: string, type: "success" | "warn" }} Status text and style.
 */
function buildCopyStatusMessage(token) {
  const type = detectTokenType(token);

  if (type === "jwt" || type === "paseto-public") {
    const payload = type === "jwt" ? parseJwtPayload(token) : parsePasetoPublicPayload(token);
    const label = type === "jwt" ? "JWT" : "PASETO";
    const time = payload ? evaluateTimeClaims(payload) : { state: "no-expiry" };

    if (time.state === "expired") {
      return {
        message: `⚠️ Token copied but ${label} expired ${time.expiresAt}`,
        type: "warn",
      };
    }

    if (time.state === "not-yet-valid") {
      return {
        message: `⚠️ Token copied but ${label} not valid yet — valid ${time.notBefore}`,
        type: "warn",
      };
    }

    if (time.state === "valid") {
      return {
        message: `✅ Token copied! ${label} expires ${time.expiresAt}`,
        type: "success",
      };
    }

    return {
      message: `✅ Token copied! ${label} has no expiry claim.`,
      type: "success",
    };
  }

  if (type === "jwe") {
    return {
      message: "✅ Token copied! Encrypted token (JWE) — expiry cannot be verified locally.",
      type: "success",
    };
  }

  if (type === "paseto-local") {
    return {
      message: "✅ Token copied! Encrypted token (PASETO local) — expiry cannot be verified locally.",
      type: "success",
    };
  }

  return {
    message: "✅ Token copied! Opaque token — no embedded expiry to verify.",
    type: "success",
  };
}
