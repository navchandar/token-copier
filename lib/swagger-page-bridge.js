/**
 * Page-context bridge — runs in the page's JavaScript world so it can access window.ui.
 * Communicates with the content script via window.postMessage.
 */
(function initTokenCopierSwaggerBridge() {
  if (globalThis.__tokenCopierSwaggerBridge) return;
  globalThis.__tokenCopierSwaggerBridge = true;

  const MSG_SOURCE_EXT = "token-copier-extension";
  const MSG_SOURCE_PAGE = "token-copier-page";

  const DEFAULT_SCHEMES = [
    "Bearer",
    "bearer",
    "bearerAuth",
    "oauth2",
    "JWT",
    "authorization",
  ];

  /**
   * Return the Swagger UI instance when available.
   *
   * @returns {object|null} Swagger UI instance.
   */
  function getSwaggerUi() {
    return globalThis.ui || globalThis.swaggerUi || null;
  }

  /**
   * Read the OpenAPI document from Swagger UI when exposed.
   *
   * @param {object} ui - Swagger UI instance.
   * @returns {object|null} Parsed OpenAPI spec.
   */
  function readOpenApiSpec(ui) {
    try {
      const raw = ui?.specSelectors?.specJson?.();
      if (!raw) return null;
      return typeof raw.toJS === "function" ? raw.toJS() : raw;
    } catch {
      return null;
    }
  }

  /**
   * Return true when a security scheme accepts bearer-style tokens.
   *
   * @param {object} schema - OpenAPI security scheme.
   * @returns {boolean} Whether the scheme is bearer-like.
   */
  function isBearerLikeScheme(schema) {
    if (!schema || typeof schema !== "object") return false;

    if (schema.type === "http" && String(schema.scheme || "").toLowerCase() === "bearer") {
      return true;
    }

    if (schema.type === "oauth2") return true;

    if (schema.type === "apiKey") {
      const name = String(schema.name || schema.in || "");
      return /authorization|bearer|jwt|token|auth/i.test(name);
    }

    return false;
  }

  /**
   * Build the list of security scheme names to try.
   *
   * @param {object} ui - Swagger UI instance.
   * @param {string[]} configuredSchemes - User-provided scheme names.
   * @returns {string[]} Unique scheme names.
   */
  function collectSchemeNames(ui, configuredSchemes) {
    const names = [...(configuredSchemes?.length ? configuredSchemes : DEFAULT_SCHEMES)];

    const spec = readOpenApiSpec(ui);
    const securitySchemes = spec?.components?.securitySchemes;
    if (securitySchemes && typeof securitySchemes === "object") {
      for (const [name, schema] of Object.entries(securitySchemes)) {
        if (isBearerLikeScheme(schema)) {
          names.push(name);
        }
      }
    }

    return [...new Set(names.filter(Boolean))];
  }

  /**
   * Format a token value for a given OpenAPI security scheme.
   *
   * @param {object} schema - OpenAPI security scheme.
   * @param {string} token - Raw bearer token.
   * @returns {string} Value to pass to Swagger authorize APIs.
   */
  function formatTokenForScheme(schema, token) {
    const bare = String(token || "").replace(/^Bearer\s+/i, "").trim();
    if (!bare) return "";

    if (schema?.type === "apiKey" && /authorization/i.test(String(schema.name || ""))) {
      return /^Bearer\s+/i.test(token) ? token.trim() : `Bearer ${bare}`;
    }

    return bare;
  }

  /**
   * Return true when Swagger UI already has a non-empty authorized credential.
   *
   * @param {object} ui - Swagger UI instance.
   * @param {string[]} schemes - Security scheme names to inspect.
   * @returns {boolean} Whether authorization is already configured in the UI.
   */
  function isSwaggerAlreadyAuthorized(ui, schemes) {
    try {
      const authorized = ui.getState?.()?.get?.("auth")?.get?.("authorized");
      if (!authorized) return false;

      const authMap = typeof authorized.toJS === "function" ? authorized.toJS() : authorized;
      if (!authMap || typeof authMap !== "object") return false;

      const namesToCheck = schemes.length ? schemes : Object.keys(authMap);
      for (const scheme of namesToCheck) {
        const value = String(authMap[scheme]?.value || "").trim();
        if (value) return true;
      }

      return Object.values(authMap).some((entry) => Boolean(String(entry?.value || "").trim()));
    } catch {
      return false;
    }
  }

  /**
   * Apply a bearer token to Swagger UI.
   *
   * @param {string} token - Token value.
   * @param {string[]} configuredSchemes - Optional scheme names from settings.
   * @returns {{ ok: boolean, reason?: string, method?: string, scheme?: string, schemes?: string[] }} Result.
   */
  function applySwaggerToken(token, configuredSchemes) {
    const ui = getSwaggerUi();
    if (!ui) return { ok: false, reason: "no-ui" };

    const schemes = collectSchemeNames(ui, configuredSchemes);
    if (isSwaggerAlreadyAuthorized(ui, schemes)) {
      return { ok: true, reason: "already-authorized", skipped: true };
    }

    const spec = readOpenApiSpec(ui);
    const securitySchemes = spec?.components?.securitySchemes || {};

    if (typeof ui.preauthorizeApiKey === "function") {
      for (const scheme of schemes) {
        const schema = securitySchemes[scheme];
        const value = formatTokenForScheme(schema, token);
        if (!value) continue;

        try {
          ui.preauthorizeApiKey(scheme, value);
          return { ok: true, method: "preauthorizeApiKey", scheme };
        } catch {
          // Try the next scheme name.
        }
      }
    }

    if (ui.authActions?.authorize) {
      const payload = {};

      for (const scheme of schemes) {
        const schema = securitySchemes[scheme] || { type: "http", scheme: "bearer", bearerFormat: "JWT" };
        const value = formatTokenForScheme(schema, token);
        if (!value) continue;

        payload[scheme] = {
          name: scheme,
          schema,
          value,
        };
      }

      if (Object.keys(payload).length === 0) {
        return { ok: false, reason: "no-schemes" };
      }

      try {
        ui.authActions.authorize(payload);
        return { ok: true, method: "authActions", schemes: Object.keys(payload) };
      } catch (err) {
        return { ok: false, reason: "authorize-failed", error: String(err) };
      }
    }

    return { ok: false, reason: "no-auth-api" };
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || event.data.source !== MSG_SOURCE_EXT) return;

    if (event.data.type === "swagger-apply") {
      const result = applySwaggerToken(event.data.token, event.data.schemes || []);
      window.postMessage(
        {
          source: MSG_SOURCE_PAGE,
          type: "swagger-result",
          id: event.data.id,
          result,
        },
        "*"
      );
      return;
    }

    if (event.data.type === "swagger-probe") {
      const ui = getSwaggerUi();
      window.postMessage(
        {
          source: MSG_SOURCE_PAGE,
          type: "swagger-probe-result",
          id: event.data.id,
          ready: Boolean(ui?.preauthorizeApiKey || ui?.authActions?.authorize),
        },
        "*"
      );
    }
  });
})();
