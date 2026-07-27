# Token Copier

A browser extension to copy your application's bearer token to the clipboard in one click - then paste it into Postman, curl, Swagger UI, or any API tool for testing purposes.

Works in **Chrome**, **Edge**, **Brave**, and **Firefox**.

> **Use this extension for authorized development and testing only!** See [Disclaimer](#disclaimer) before use.

---

## Get started in 3 steps

1. **Install** the extension (see [Install](#install) below).
2. **Log in** to your web app so a token is available (usually stored in a cookie).
3. Click the **Token Copier** icon → **Copy Token** → paste wherever you need it.

That's it for most apps. The extension remembers your settings for next time.

---

## Install

### Chrome, Edge, or Brave

1. Open `chrome://extensions` (or your browser's extensions page).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select this `token-copier` folder.
4. Pin **Token Copier** to your toolbar for quick access.

### Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…**.
3. Choose `manifest.json` inside this folder.

> Temporary add-ons are removed when Firefox restarts. For a permanent install, the extension must be published on [Firefox Add-ons](https://addons.mozilla.org).

---

## How it works

The popup gives you two ways to find a token. Pick the one that matches your app.

### Stored Cookie *(default - use this first)*

Best when your app saves the token in a browser cookie after login.

| Setting | What to enter |
| -------- | -------------- |
| **Domain** | Your app's hostname (e.g. `app.example.com`). Auto-filled from the current tab. |
| **Cookie Name** | The cookie that holds the token. Default: `token`. |

**Steps**

1. Log in to your app in the browser.
2. Open the Token Copier popup.
3. Confirm **Domain** and **Cookie Name** look right.
4. Click **Copy Token**.

**Tip:** Not sure of the cookie name? Open DevTools → **Application** (Chrome) or **Storage** (Firefox) → **Cookies** and look for your auth cookie.

### Recent Response

Best when the token only appears in API response headers - not in a cookie.

| Setting | What to enter |
| -------- | -------------- |
| **Domain** | The API hostname (e.g. `api.example.com`). |
| **Response Header** | The header that carries the token. Default: `authorization`. |

**Steps**

1. Set **Token Source** to **Recent Response**.
2. Enter the **Domain** and **Response Header**.
3. Use the app so it makes a **GET** or **POST** request that returns the token.
4. Click **Copy Token**.

---

## Swagger UI

Testing APIs in Swagger? Turn on **Auto-apply token to Swagger UI** in the popup.

- The extension applies your token automatically when you open a Swagger page.
- **Try it out** requests will include authorization without manual paste.
- You can still click **Copy Token** anytime.

**Security scheme name** - leave blank unless auto-apply fails. Then enter the exact name from your OpenAPI spec (e.g. `BearerAuth`).

If your token is expired, you'll see a short warning on the Swagger page. Log in again and copy a fresh token.

---

## All settings

| Setting | Default | Purpose |
| -------- | -------- | -------- |
| Token Source | Stored Cookie | Cookie vs API response |
| Domain | From current tab | Which site to read from |
| Cookie Name | `token` | Auth cookie name |
| Response Header | `authorization` | Header to capture in Response mode |
| Auto-apply to Swagger | Off | Auto-authorize Swagger requests |
| Security scheme name | *(blank)* | Swagger auth scheme, if needed |

Settings save automatically. Cookie and Response modes each remember their own domain. Subdomains are matched - e.g. domain `example.com` also covers `api.example.com`.

After copying, the popup shows a **preview** of the token and whether it looks **valid** or **expired** (for JWT-style tokens).

---

## Troubleshooting

| Problem | What to try |
| -------- | ------------ |
| **Token not found** | Confirm you're logged in. Check cookie name and domain in DevTools. |
| **Response mode finds nothing** | Trigger a GET/POST to the configured domain first. Try **Stored Cookie** if login happens via OAuth redirect. |
| **Swagger returns 401** | Enable auto-apply. Make sure **Copy Token** works first. Set the security scheme name. Refresh the Swagger page. |
| **Token marked expired** | Log in again, then copy a fresh token. |
| **Unicode / ByteString error in Swagger** | Copy from this extension instead of email or docs - it copies plain text only. |

---

## Disclaimer

**Intended use.** Token Copier is a developer and QA tool for **testing only**. Use it only on systems and accounts you own or are explicitly permitted to access. Do not use it to obtain credentials without authorization, bypass security controls, or access data you are not allowed to use.

**Your responsibility.** Authentication tokens are sensitive secrets. You are responsible for:

- Keeping copied tokens secure and not sharing them in unsafe places (chat, tickets, public repos, screen shares).
- Following your organization's security policies, terms of service, and applicable laws.
- Revoking or rotating tokens if they are exposed.
- Confirming you have permission before copying or reusing tokens from any application.

**How data is handled.** The extension reads cookies or response headers **locally in your browser** to copy a token to your clipboard or apply it in Swagger UI. It does **not** send tokens or browsing data to the author or any third-party service.

**No guarantees.** Token preview and expiry hints (e.g. for JWT-style tokens) are **informational only** — they are not a security audit. The extension is provided **"as is"**, without warranty of any kind. See the [LICENSE](LICENSE) file for the full MIT license terms.

**Limitation of liability.** The authors and contributors are **not liable** for any misuse of this software, unauthorized access, data loss, security incidents, compliance violations, or damages arising from your use of copied tokens or this extension — whether that use is authorized or not.

By installing or using Token Copier, you agree to these terms and accept full responsibility for how you use it.

---

## For developers

<details>
<summary><strong>Reload after code changes</strong></summary>

- **Chrome / Edge / Brave:** `chrome://extensions` → Reload on Token Copier.
- **Firefox:** `about:debugging` → Reload.

If you change `manifest.json`, remove and re-add the extension once.

</details>

<details>
<summary><strong>Project layout</strong></summary>

```
token-copier/
├── manifest.json
├── background.js              # Token interception + Swagger header injection
├── lib/
│   ├── browser.js             # Chrome/Firefox compatibility
│   ├── domain.js              # Hostname matching, cookie URLs
│   ├── format.js              # Token/URL formatting
│   ├── token.js               # JWT/PASETO expiry detection
│   ├── token-source.js        # Resolve token from cookie or storage
│   ├── swagger.js             # Swagger UI helpers
│   ├── swagger-auth.js        # Content script for Swagger auto-apply
│   └── swagger-page-bridge.js # In-page bridge for Swagger authorize API
├── popup/                     # Extension popup UI
└── icons/
```

</details>

<details>
<summary><strong>Permissions</strong></summary>

| Permission | Why |
| ---------- | --- |
| `cookies` | Read the auth cookie |
| `storage` | Save settings and intercepted tokens |
| `webRequest` | Capture tokens from response headers |
| `activeTab` / `tabs` | Pre-fill domain from the current tab |
| `<all_urls>` | Monitor requests on configured domains |

Clipboard access needs no extra permission - copy runs when you click the button in the popup.

</details>

<details>
<summary><strong>Browser notes</strong></summary>

- **Chrome / Edge / Brave (121+):** Service worker background; Swagger auto-apply via page bridge.
- **Firefox (109+):** Event-page background; blocking `webRequest` for Swagger header injection.

One build supports both - the manifest includes `background.service_worker` and `background.scripts`.

</details>

<details>
<summary><strong>Debugging</strong></summary>

Set `DEBUG = true` at the top of `background.js` for diagnostic logs (secrets are redacted).

- **Swagger page:** browser console (F12) - look for `[token-copier]` messages.
- **Background:** extension service worker "Inspect" (Chrome) or `about:debugging` (Firefox).

</details>
