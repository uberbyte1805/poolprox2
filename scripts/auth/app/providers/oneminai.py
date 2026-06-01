from __future__ import annotations

import asyncio
import os
import re
from typing import Any

from app.errors.codes import ErrorCode
from app.errors.exceptions import NonRetryableBatcherError, RetryableBatcherError
from app.providers.base import NormalizedAccount, ProviderAdapter
from app.providers.kiro import (
    _fill_google_email_step,
    _fill_google_password_step,
    _handle_google_gaplustos,
    _handle_google_consent_continue,
    _detect_google_blocking_challenge,
    _is_email_step,
    _is_password_step,
    _click_continue_button,
)

_EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_HEX64 = re.compile(r"^[a-f0-9]{64}$", re.I)

ONEMINAI_APP_URL = "https://app.1min.ai/"
ONEMINAI_API_BASE = "https://api.1min.ai"
ONEMINAI_USERS_URL = f"{ONEMINAI_API_BASE}/users"


class OneMinAiProviderAdapter(ProviderAdapter):
    """1min.ai farmer: Google OAuth login (Camoufox) -> capture JWT from request
    headers -> resolve teamId via /users -> list/create 64-hex api_key via
    /api/teams/{teamId}/keys. The 64-hex key is what the chat endpoint requires
    (API-KEY header); the JWT alone is rejected by /api/chat-with-ai."""

    name = "oneminai"

    async def parse_account(self, raw_line: str) -> NormalizedAccount:
        parts = [p.strip() for p in raw_line.split("|")]
        if len(parts) != 2:
            raise NonRetryableBatcherError(
                ErrorCode.input_invalid_format,
                "oneminai account must be email|password",
            )
        email, password = parts
        if not email or not password:
            raise NonRetryableBatcherError(
                ErrorCode.input_missing_required_field,
                "oneminai account requires email and password",
            )
        if not _EMAIL_PATTERN.match(email):
            raise NonRetryableBatcherError(
                ErrorCode.input_invalid_format,
                "oneminai account email format is invalid",
            )
        return NormalizedAccount(
            provider=self.name, identifier=email, secret=password, raw=raw_line
        )

    async def bootstrap_session(self, account: NormalizedAccount) -> Any:
        try:
            from browserforge.fingerprints import Screen
            from camoufox.async_api import AsyncCamoufox

            camoufox_kwargs: dict[str, Any] = {
                "headless": os.getenv("BATCHER_CAMOUFOX_HEADLESS", "true").lower() == "true",
                "humanize": True,
                "locale": "en-US",
                "block_webrtc": True,
                "screen": Screen(max_width=1920, max_height=1080),
            }
            proxy_url = os.getenv("BATCHER_PROXY_URL", "")
            if proxy_url:
                from urllib.parse import urlparse
                parsed = urlparse(proxy_url)
                proxy_cfg: dict[str, Any] = {
                    "server": f"{parsed.scheme}://{parsed.hostname}:{parsed.port}"
                }
                if parsed.username:
                    proxy_cfg["username"] = parsed.username
                if parsed.password:
                    proxy_cfg["password"] = parsed.password
                camoufox_kwargs["proxy"] = proxy_cfg
                camoufox_kwargs["geoip"] = True

            manager = AsyncCamoufox(**camoufox_kwargs)
            browser = await manager.__aenter__()
            page = await browser.new_page()
            page.set_default_timeout(15000)
            await page.set_viewport_size({"width": 1366, "height": 768})

            # JWT is sent as `x-auth-token: Bearer <jwt>` on every api.1min.ai
            # request once logged in. Sniff it from request headers (it is NOT
            # in localStorage).
            jwt_box: dict[str, str | None] = {"tok": None}

            def _on_request(req: Any) -> None:
                try:
                    if "api.1min.ai" in req.url and not jwt_box["tok"]:
                        a = req.headers.get("x-auth-token", "") or req.headers.get(
                            "authorization", ""
                        )
                        if a.startswith("Bearer ") and len(a) > 30:
                            jwt_box["tok"] = a[7:]
                except Exception:
                    pass

            page.on("request", _on_request)

            await page.goto(ONEMINAI_APP_URL, wait_until="commit", timeout=60000)
            await asyncio.sleep(7)

            return {
                "manager": manager,
                "browser": browser,
                "page": page,
                "jwt_box": jwt_box,
                "popup": None,
            }
        except Exception as exc:
            raise RetryableBatcherError(
                ErrorCode.browser_start_failed,
                str(exc) or "oneminai camoufox bootstrap failed",
            ) from exc

    async def authenticate(self, account: NormalizedAccount, session: Any) -> dict[str, Any]:
        if session is None or session.get("stub"):
            return {"authenticated": True}

        page = session["page"]
        jwt_box = session["jwt_box"]

        # 1) Remove the SVG pointer-events overlay and wait for the in-app
        #    "Log In" button to render (SPA timing is flaky -> retry up to 3x).
        btn_sel = (
            'button:has-text("Log In"), button:has-text("Login"), '
            'button:has-text("Sign In"), button:has-text("Log in")'
        )
        rendered = False
        for attempt in range(3):
            try:
                await page.evaluate(
                    "() => document.querySelectorAll('rect[pointer-events]')"
                    ".forEach(r=>r.remove())"
                )
            except Exception:
                pass
            try:
                await page.wait_for_selector(btn_sel, timeout=12000)
                rendered = True
                break
            except Exception:
                if attempt == 2:
                    break
                await asyncio.sleep(4)
        if not rendered:
            raise RetryableBatcherError(
                ErrorCode.browser_unexpected_state,
                "oneminai: Log In button never rendered",
            )

        await page.evaluate(
            """() => {
                const b=Array.from(document.querySelectorAll('button'))
                    .find(x=>/^(log\\s?in|login|sign\\s?in)$/i.test(x.textContent.trim()));
                if(b) b.click();
            }"""
        )
        await asyncio.sleep(3)

        # 2) Click "Log in with Google" -> opens the Google OAuth popup.
        gbtn = await page.wait_for_selector(
            'button:has-text("Log in with Google")', timeout=12000
        )
        # The SVG overlay (rect[pointer-events="auto"]) can re-render between the
        # first "Log In" click and here, intercepting the Google button click
        # (flaky across runs). Strip it again immediately before clicking, and
        # fall back to force-click if a normal click still gets intercepted.
        try:
            await page.evaluate(
                "() => document.querySelectorAll('rect[pointer-events]')"
                ".forEach(r=>r.remove())"
            )
        except Exception:
            pass
        async with page.expect_popup() as popup_info:
            try:
                await gbtn.click(timeout=8000)
            except Exception:
                # Overlay re-intercepted — bypass pointer-events hit-testing.
                await gbtn.click(timeout=8000, force=True)
        popup = await popup_info.value
        session["popup"] = popup
        await asyncio.sleep(2)

        if "accounts.google.com" not in popup.url:
            raise RetryableBatcherError(
                ErrorCode.browser_unexpected_state,
                f"oneminai: expected Google OAuth, got {popup.url[:80]}",
            )

        # 3) Drive the Google OAuth flow (reuse kiro helpers).
        email_done = False
        password_done = False
        for _ in range(60):
            try:
                current_url = popup.url
            except Exception:
                break
            if "accounts.google.com" not in current_url:
                break
            try:
                if await _handle_google_gaplustos(popup):
                    await asyncio.sleep(0.8)
                    continue
                if await _handle_google_consent_continue(popup):
                    await asyncio.sleep(0.8)
                    continue

                at_email = await _is_email_step(popup)
                at_password = await _is_password_step(popup)

                if at_email and not email_done:
                    if await _fill_google_email_step(popup, account.identifier):
                        email_done = True
                        await asyncio.sleep(1)
                        continue

                if at_password and not password_done:
                    if await _fill_google_password_step(popup, account.secret):
                        password_done = True
                        await asyncio.sleep(1)
                        continue

                if not at_email and not at_password:
                    challenge = await _detect_google_blocking_challenge(popup)
                    if challenge:
                        raise RetryableBatcherError(
                            ErrorCode.browser_challenge_blocked,
                            f"oneminai: Google challenge detected: {challenge}",
                        )

                await _click_continue_button(popup)
            except RetryableBatcherError:
                raise
            except NonRetryableBatcherError:
                raise
            except Exception:
                break
            await asyncio.sleep(1)

        # 4) Wait for the popup to settle, then re-navigate so the app fires
        #    api.1min.ai requests -> the request listener captures the JWT.
        for _ in range(10):
            try:
                if popup.is_closed():
                    break
                _ = popup.url
                await asyncio.sleep(1)
            except Exception:
                break

        await asyncio.sleep(3)
        try:
            await page.goto(ONEMINAI_APP_URL, wait_until="commit", timeout=40000)
        except Exception:
            pass

        for _ in range(20):
            if jwt_box["tok"]:
                break
            await asyncio.sleep(1)

        if not jwt_box["tok"]:
            raise NonRetryableBatcherError(
                ErrorCode.auth_invalid_credentials,
                "oneminai: login failed — no JWT captured after OAuth",
            )

        return {"authenticated": True, "jwt": jwt_box["tok"]}

    async def fetch_tokens(
        self,
        account: NormalizedAccount,
        auth_state: dict[str, Any],
        session: Any,
    ) -> dict[str, str]:
        jwt = auth_state.get("jwt") or (session or {}).get("jwt_box", {}).get("tok")
        if not jwt:
            raise NonRetryableBatcherError(
                ErrorCode.provider_unsupported_response,
                "oneminai: no JWT available for token fetch",
            )

        import aiohttp

        timeout = aiohttp.ClientTimeout(total=20)
        headers = {"x-auth-token": f"Bearer {jwt}", "Content-Type": "application/json"}

        async with aiohttp.ClientSession(timeout=timeout) as client:
            # 1) Resolve the team uuid from /users.
            async with client.get(ONEMINAI_USERS_URL, headers=headers) as resp:
                if resp.status != 200:
                    raise RetryableBatcherError(
                        ErrorCode.provider_unsupported_response,
                        f"oneminai: /users returned {resp.status}",
                    )
                udata = await resp.json()

            user = udata.get("user", {}) or {}
            user_id = user.get("uuid", "")
            teams = user.get("teams", []) or []
            if not teams:
                raise NonRetryableBatcherError(
                    ErrorCode.provider_unsupported_response,
                    "oneminai: account has no teams",
                )
            team = teams[0].get("team", {}) or {}
            team_id = team.get("uuid", "")
            if not team_id:
                raise NonRetryableBatcherError(
                    ErrorCode.provider_unsupported_response,
                    "oneminai: could not resolve team uuid",
                )

            keys_url = f"{ONEMINAI_API_BASE}/api/teams/{team_id}/keys"
            api_key = ""

            # 2) Reuse an existing 64-hex key if present.
            async with client.get(keys_url, headers=headers) as resp:
                if resp.status == 200:
                    kdata = await resp.json()
                    for k in kdata.get("apiKeyList", []) or []:
                        cand = (k or {}).get("key", "")
                        if _HEX64.match(cand or ""):
                            api_key = cand
                            break

            # 3) Otherwise create one.
            if not api_key:
                async with client.post(
                    keys_url, headers=headers, json={"name": "poolprox"}
                ) as resp:
                    if resp.status not in (200, 201):
                        body = await resp.text()
                        raise RetryableBatcherError(
                            ErrorCode.provider_unsupported_response,
                            f"oneminai: create key {resp.status}: {body[:120]}",
                        )
                    cdata = await resp.json()
                    api_key = ((cdata.get("apiKey", {}) or {}).get("key", "")) or ""

            if not _HEX64.match(api_key or ""):
                raise NonRetryableBatcherError(
                    ErrorCode.provider_unsupported_response,
                    "oneminai: no valid 64-hex api_key obtained",
                )

        return {
            "api_key": api_key,
            "jwt": jwt,
            "team_id": team_id,
            "user_id": user_id,
            "email": account.identifier,
        }

    async def fetch_quota(
        self,
        account: NormalizedAccount,
        tokens: dict[str, str],
        session: Any,
    ) -> dict[str, Any] | None:
        jwt = tokens.get("jwt", "")
        if not jwt:
            return None

        import aiohttp

        timeout = aiohttp.ClientTimeout(total=15)
        headers = {"x-auth-token": f"Bearer {jwt}", "Content-Type": "application/json"}
        try:
            async with aiohttp.ClientSession(timeout=timeout) as client:
                async with client.get(ONEMINAI_USERS_URL, headers=headers) as resp:
                    if resp.status != 200:
                        return None
                    data = await resp.json()
            teams = data.get("user", {}).get("teams", []) or []
            if not teams:
                return None
            t0 = teams[0]
            team = t0.get("team", {}) or {}
            credit = float(team.get("credit", 0) or 0)
            credit_limit = float(t0.get("creditLimit", 0) or 0) or credit
            used = float(t0.get("usedCredit", 0) or 0)
            return {
                "limit": credit_limit,
                "remaining": credit,
                "remaining_credits": credit,
                "total_credits": credit_limit,
                "current_usage": used,
            }
        except Exception:
            return None

    async def cleanup_session(self, session: Any) -> None:
        if not isinstance(session, dict):
            return
        manager = session.get("manager")
        if manager:
            try:
                await manager.__aexit__(None, None, None)
            except Exception:
                pass
