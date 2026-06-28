/**
 * Cross-browser helpers for Chromium and Firefox WebExtensions APIs.
 */

/** @type {typeof browser} */
const browserApi = globalThis.browser ?? globalThis.chrome;

/**
 * Return the unified extension API object.
 *
 * @returns {typeof browser} Browser or Chrome extension API.
 */
function getBrowserApi() {
  return browserApi;
}

/** @type {"firefox"|"chromium"|"unknown"|null} */
let browserKind = null;

/**
 * Detect the browser family from WebExtensions API surface (sync, cached).
 *
 * Firefox exposes runtime.getBrowserInfo. Chromium-based browsers expose
 * chrome.runtime but not getBrowserInfo. This avoids inferring Chromium
 * from "not Firefox" alone (which would mis-label Safari or future engines).
 *
 * @returns {"firefox"|"chromium"|"unknown"} Detected browser family.
 */
function getBrowserKind() {
  if (browserKind) return browserKind;

  if (typeof browserApi.runtime.getBrowserInfo === "function") {
    browserKind = "firefox";
    return browserKind;
  }

  if (typeof globalThis.chrome?.runtime?.getManifest === "function") {
    browserKind = "chromium";
    return browserKind;
  }

  browserKind = "unknown";
  return browserKind;
}

/**
 * Return true when running in Firefox (has getBrowserInfo).
 *
 * @returns {boolean} Whether the host browser is Firefox.
 */
function isFirefox() {
  return getBrowserKind() === "firefox";
}

/**
 * Return true when running in a Chromium-based browser (Chrome, Edge, Brave, etc.).
 *
 * @returns {boolean} Whether the host browser is Chromium-based.
 */
function isChromium() {
  return getBrowserKind() === "chromium";
}

/**
 * Return true for internal browser/extension pages that should be ignored.
 *
 * @param {string} url - Full page or request URL.
 * @returns {boolean} Whether the URL is internal to the browser or extension.
 */
function isInternalBrowserUrl(url) {
  if (!url) return true;

  try {
    const protocol = new URL(url).protocol;
    return (
      protocol === "about:" ||
      protocol === "chrome:" ||
      protocol === "chrome-extension:" ||
      protocol === "moz-extension:"
    );
  } catch {
    return true;
  }
}

/**
 * Send a runtime message and normalize errors across browsers.
 *
 * @param {object} message - Message payload for the background script.
 * @returns {Promise<object|null>} Response object or null when unavailable.
 */
async function sendExtensionMessage(message) {
  try {
    const response = await browserApi.runtime.sendMessage(message);

    if (browserApi.runtime.lastError) {
      return null;
    }

    return response ?? null;
  } catch (err) {
    const text = String(err?.message || err);
    if (
      text.includes("Could not establish connection") ||
      text.includes("Receiving end does not exist") ||
      text.includes("Extension context invalidated")
    ) {
      return null;
    }
    throw err;
  }
}

/**
 * Register a webRequest listener, trying multiple extraInfoSpec options.
 *
 * @param {Function} addListener - webRequest addListener function.
 * @param {Function} handler - Request handler callback.
 * @param {string[][]} specCandidates - extraInfoSpec values to try in order.
 * @returns {Promise<string[]>} The spec that was registered successfully.
 */
async function registerWebRequestListener(addListener, handler, specCandidates) {
  let lastError = null;

  for (const spec of specCandidates) {
    try {
      const result = addListener(handler, { urls: ["<all_urls>"] }, spec);

      if (result && typeof result.then === "function") {
        await result;
      }

      return spec;
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error("[token-copier] Failed to register webRequest listener");
}

/**
 * Return candidate onBeforeSendHeaders extraInfoSpec lists for this browser.
 *
 * @returns {string[][]} Spec options to try, most capable first.
 */
function getBeforeSendHeaderSpecCandidates() {
  return [
    ["blocking", "requestHeaders"],
    ["requestHeaders"],
  ];
}

/**
 * Return candidate onHeadersReceived extraInfoSpec lists for this browser.
 *
 * @returns {string[][]} Spec options to try, most capable first.
 */
function getResponseHeaderSpecCandidates() {
  if (isFirefox()) {
    return [["responseHeaders"]];
  }

  return [["responseHeaders", "extraHeaders"], ["responseHeaders"]];
}
