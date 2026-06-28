# 🔑 Token Copier

A browser extension to copy auth token to the clipboard in one click — useful for Swagger UI, Postman, curl, and other API tools.

Works in **Chrome**, **Edge**, **Brave**, and **Firefox**.

---

## Quick start

1. **Install** the extension 
2. **Log in** to your app in the browser so a token cookie is set, or use a web app that sends tokens in API responses.
3. Click the **🔑 Token Copier** extension icon in your toolbar.
4. Pick how the token should be found (**Stored Cookie** or **Recent Response**).
5. Click **📋 Copy Token** and paste where you need it.


---

## Features

- **Copy token** — One click copies the bearer token to your clipboard.
- **Method to read the token**
  - **Stored Cookie** — Reads a cookie from the site you’re logged into (default cookie name: `token`).
  - **Recent Response** — Watches API traffic and grabs the token from response headers.
- **Expiry hint** — After copying, shows whether the token looks valid or expired (for JWT-style tokens).
- **Swagger support** — Auto-applies the token on Swagger pages so **Try it out** requests include authorization automatically.

---

## Dev Install

### Chrome, Edge, or Brave

1. Open your browser’s extensions page (`chrome://extensions` in Chrome).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and choose the `token-copier` folder.
4. Pin the **Token Copier** icon to your toolbar if you like.

### Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…**.
3. Select `manifest.json` inside the `token-copier` folder.

> Temporary add-ons in Firefox are removed when you restart the browser. For a permanent install, the extension needs to be packaged and signed for [Firefox Add-ons](https://addons.mozilla.org).

---

## How to use

### Cookie mode (most common)

Use this when your app stores the token in a browser cookie after login.

1. Open the extension popup while you’re on the app (or after logging in).
2. Set **Token Source** to **Stored Cookie**.
3. Check **Domain** — it’s usually filled in from the current tab (e.g. `app.example.com`).
4. Set **Cookie Name** if your app uses something other than `token`.
5. Click **📋 Copy Token**.

If copy fails, open DevTools → **Application** (Chrome) or **Storage** (Firefox) → **Cookies** and confirm the cookie name and domain.

### Response mode

Use this when the token only appears in API response headers (not in a cookie).

1. Set **Token Source** to **Recent Response**.
2. Set **Domain** to the API host (e.g. `api.example.com`).
3. Set **Response Header** if needed (default: `authorization`).
4. Use the app so it makes a **GET** or **POST** request that returns the token.
5. Click **📋 Copy Token**.

### Swagger UI

1. Turn on **Auto-apply token to Swagger UI** in the popup.
2. Open your Swagger page (`app.com/swagger/`, etc.).
3. The extension applies the token when it’s available. You can still use **Copy Token** anytime.

**Optional:** **Security scheme name** — only if auto-apply doesn’t work. Use the exact name from your API spec (e.g. `BearerAuth`). Leave blank to try common names automatically.

With **Auto-apply token to Swagger UI** enabled, you may see a **short red warning** when the token is expired.

---

## Settings

| Setting | Default | What it means |
| -------- | -------- | -------------- |
| Token Source | Stored Cookie | Cookie vs API response |
| Domain | *(from current tab)* | Which site to read the token from |
| Cookie Name | `token` | Name of the auth cookie |
| Response Header | `authorization` | Header to read in Response mode |
| Auto-apply to Swagger | Off | Sends the token on Swagger API calls |
| Security scheme name | *(blank)* | Swagger auth scheme name, if needed |

Cookie mode and Response mode each have their own domain. Subdomains are matched (e.g. `api.example.com` works with domain `example.com`).

---

## Troubleshooting

**“Token not found” or cookie errors**

- Make sure you’re logged in on the configured domain.
- Check the cookie name in DevTools matches what you entered.
- Confirm the **Domain** field matches the site that set the cookie.

**Response mode finds nothing**

- Use the app so it sends a **GET** or **POST** to the configured domain.
- Confirm the response includes your header (e.g. `Authorization`) or sets the cookie you expect.
- OAuth login pages often don’t return a token in headers — try **Stored Cookie** instead.

**Swagger still returns 401**

- Enable **Auto-apply token to Swagger UI**.
- Confirm **Copy Token** works first (you need a valid token).
- Try setting **Security scheme name** to match your OpenAPI spec.
- Refresh the Swagger page after changing settings.

**Token copied but marked expired**

- Log in again to get a fresh token, then copy once more.

**Pasting into Swagger caused a Unicode / ByteString error before**

- Use **Copy Token** from this extension instead of copying from emails or docs — it copies plain text only.

---

## For developers

<details>
<summary><strong>Install for development</strong></summary>

Same steps as [Install](#install) above. Reload the extension after code changes:

- **Chrome / Edge / Brave:** `chrome://extensions` → Reload on Token Copier.
- **Firefox:** `about:debugging` → Reload.

If you change `manifest.json` (permissions, scripts), remove and re-add the extension once.

</details>

<details>
<summary><strong>Project layout</strong></summary>

```
token-copier/
├── manifest.json
├── background.js              # Token interception + Swagger header injection
├── lib/
│   ├── browser.js             # Chrome/Firefox compatibility helpers
│   ├── domain.js              # Hostname matching, cookie URLs, Swagger detection
│   ├── format.js              # Token/URL formatting, safe logging
│   ├── token.js               # JWT/PASETO expiry detection
│   ├── token-source.js        # Resolve token from cookie or storage
│   ├── swagger.js             # Swagger UI helpers
│   ├── swagger-auth.js        # Content script for Swagger auto-apply
│   └── swagger-page-bridge.js # In-page bridge for Swagger authorize API
├── popup/
│   ├── popup.html
│   ├── popup.css
│   └── popup.js
└── icons/
```

</details>

<details>
<summary><strong>Permissions</strong></summary>

| Permission | Why |
| ---------- | --- |
| `cookies` | Read the auth cookie for the configured domain |
| `storage` | Save your settings and intercepted tokens |
| `webRequest` | Capture tokens from API response headers |
| `webRequestBlocking` | Inject Authorization on Swagger requests (Firefox) |
| `activeTab` / `tabs` | Pre-fill domain from the current tab; Swagger injection |
| `<all_urls>` | Monitor requests on the domains you configure |

Clipboard access does not need a separate permission — copy runs from the popup when you click the button.

</details>

<details>
<summary><strong>Browser compatibility</strong></summary>

- **Chrome / Edge / Brave (121+):** Service worker background; response interception with `extraHeaders` where supported; Swagger auto-apply via page bridge.
- **Firefox (109+):** Event-page background via `background.scripts`; blocking `webRequest` for Swagger `Authorization` injection; no `extraHeaders` on `onHeadersReceived`.

The manifest includes both `background.service_worker` and `background.scripts` so one build works in both families.

**Swagger auto-apply:**

| Browser | Page bridge (Authorize UI) | Network header injection |
| -------- | --------------------------- | ------------------------- |
| Firefox | Yes | Yes (when auto-apply is on) |
| Chromium | Yes | Only if blocking webRequest is available |

</details>

<details>
<summary><strong>Debugging</strong></summary>

Set `DEBUG = true` at the top of `background.js` for safe diagnostic logs (secrets are redacted).

**Swagger issues**

- Page console (F12 on the Swagger tab): look for `[token-copier]` messages.
- Background console: `about:debugging` (Firefox) or extension service worker “Inspect” (Chrome).

**Common dev errors**

- `background.service_worker is currently disabled` (Firefox) — Reload after pulling latest `manifest.json`; Firefox requires `background.scripts`.
- `extraHeaders` invalid (Firefox) — Expected; Firefox uses `responseHeaders` only.
- `swaggerAutoApply: false` after intercept — Fixed by preserving config when unrelated storage keys change; re-toggle auto-apply if on an old build.

</details>
