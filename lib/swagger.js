/**
 * Swagger UI detection and bearer authorization helpers.
 */

const DEFAULT_SWAGGER_SCHEMES = [
  "Bearer",
  "bearer",
  "bearerAuth",
  "oauth2",
  "JWT",
  "authorization",
];

/**
 * Return true when the current page appears to host Swagger UI.
 *
 * @returns {boolean} Whether Swagger UI is present or loading.
 */
function isSwaggerPage() {
  return !!(
    isSwaggerUrl(globalThis.location?.href || "") ||
    document.querySelector(".swagger-ui") ||
    document.querySelector("#swagger-ui")
  );
}

/**
 * Wait for Swagger UI to expose its authorize API.
 *
 * @param {number} [maxAttempts=60] - Number of polling attempts.
 * @param {number} [intervalMs=250] - Delay between attempts.
 * @returns {Promise<object|null>} Swagger UI instance or null.
 */
function waitForSwaggerUi(maxAttempts = 60, intervalMs = 250) {
  return new Promise((resolve) => {
    let attempts = 0;

    const check = () => {
      const ui = globalThis.ui;
      if (ui?.preauthorizeApiKey || ui?.authActions?.authorize) {
        resolve(ui);
        return;
      }

      attempts += 1;
      if (attempts >= maxAttempts) {
        resolve(null);
        return;
      }

      setTimeout(check, intervalMs);
    };

    check();
  });
}

/**
 * Parse user-configured Swagger security scheme names.
 *
 * @param {string} raw - Comma-separated scheme names.
 * @returns {string[]} Scheme names to try.
 */
function parseSwaggerSchemeNames(raw) {
  const names = String(raw || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  return names.length ? names : DEFAULT_SWAGGER_SCHEMES;
}

/**
 * Apply a bearer token to Swagger UI using known authorization APIs.
 *
 * @param {object} ui - Swagger UI instance.
 * @param {string} token - Raw bearer token.
 * @param {string[]} schemeNames - Security scheme names to try.
 * @returns {{ ok: boolean, scheme?: string, method?: string }} Result summary.
 */
function applySwaggerBearerToken(ui, token, schemeNames) {
  const value = String(token || "").replace(/^Bearer\s+/i, "").trim();
  if (!value || !ui) return { ok: false };

  const names = schemeNames.length ? schemeNames : DEFAULT_SWAGGER_SCHEMES;

  if (typeof ui.preauthorizeApiKey === "function") {
    for (const scheme of names) {
      try {
        ui.preauthorizeApiKey(scheme, value);
        return { ok: true, scheme, method: "preauthorizeApiKey" };
      } catch {
        // Try the next scheme name.
      }
    }
  }

  if (ui.authActions?.authorize) {
    const payload = {};
    for (const scheme of names) {
      payload[scheme] = {
        name: scheme,
        schema: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        value,
      };
    }

    try {
      ui.authActions.authorize(payload);
      return { ok: true, method: "authActions" };
    } catch {
      return { ok: false };
    }
  }

  return { ok: false };
}
