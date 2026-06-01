from __future__ import annotations

import asyncio
import json
import os
import re
import time
from typing import Any
from urllib.parse import urlparse

import aiohttp

from app.errors.codes import ErrorCode
from app.errors.exceptions import NonRetryableBatcherError, RetryableBatcherError
from app.providers.base import NormalizedAccount, ProviderAdapter
from app.providers.kiro import (
    _fill_google_email_step,
    _fill_google_password_step,
    _handle_google_consent_continue,
    _handle_google_gaplustos,
    _is_email_step,
    _is_password_step,
)

_EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

PIONEER_AUTH_URL = "https://agent.pioneer.ai/auth"
PIONEER_API_BASE = "https://api.pioneer.ai"
PIONEER_USER_URL = f"{PIONEER_API_BASE}/users/me"
PIONEER_BILLING_URL = f"{PIONEER_API_BASE}/billing/billing-status"
PIONEER_LIST_KEYS_URL = f"{PIONEER_API_BASE}/list-api-keys"
PIONEER_CREATE_KEY_URL = f"{PIONEER_API_BASE}/create-api-key"


def _debug(msg: str) -> None:
    if os.getenv("BATCHER_DEBUG", "").lower() == "true":
        print(f"[pioneer-debug] {msg}", flush=True)


async def _drive_pioneer_auth(page: Any, email: str, password: str) -> None:
    email_transition_deadline = 0.0
    password_transition_deadline = 0.0
    email_step_started_at: float | None = None

    for _ in range(120):
        try:
            cur = page.url
        except Exception:
            return

        try:
            cur_host = urlparse(cur).netloc
        except Exception:
            cur_host = ""

        if cur_host.endswith("agent.pioneer.ai"):
            _debug("redirected back to Pioneer")
            return

        now = time.monotonic()

        if await _handle_google_gaplustos(page):
            await asyncio.sleep(1.0)
            continue

        if await _handle_google_consent_continue(page):
            await asyncio.sleep(1.0)
            continue

        on_google_auth = cur_host.endswith("accounts.google.com")
        if on_google_auth:
            at_password_step = await _is_password_step(page)
            at_email_step = await _is_email_step(page)

            if at_email_step and not at_password_step:
                if email_step_started_at is None:
                    email_step_started_at = now
                elif now - email_step_started_at > 60.0:
                    raise RetryableBatcherError(
                        ErrorCode.browser_challenge_blocked,
                        "pioneer captcha suspected: email step stuck > 60s",
                    )
                if now < email_transition_deadline:
                    await asyncio.sleep(0.5)
                    continue
                if await _fill_google_email_step(page, email):
                    email_transition_deadline = time.monotonic() + 6.0
                    await asyncio.sleep(1.5)
                    continue

            if at_password_step:
                email_step_started_at = None
                if now < password_transition_deadline:
                    await asyncio.sleep(0.5)
                    continue
                if await _fill_google_password_step(page, password):
                    password_transition_deadline = time.monotonic() + 8.0
                    await asyncio.sleep(1.5)
                    continue

            await asyncio.sleep(0.7)
            continue

        email_step_started_at = None
        await asyncio.sleep(1.0)


class PioneerProviderAdapter(ProviderAdapter):
    name = "pioneer"

    async def parse_account(self, raw_line: str) -> NormalizedAccount:
        parts = [p.strip() for p in raw_line.split("|")]
        if len(parts) < 2 or not parts[0] or not parts[1]:
            raise NonRetryableBatcherError(
                ErrorCode.input_invalid_format,
                "pioneer account must be email|password or email|api_key",
            )
        email = parts[0]
        secret = parts[1]
        if not _EMAIL_PATTERN.match(email):
            raise NonRetryableBatcherError(
                ErrorCode.input_invalid_format,
                "pioneer account email format is invalid",
            )
        secret_kind = "api_key" if secret.startswith("pio_sk_") else "password"
        return NormalizedAccount(
            provider=self.name,
            identifier=email,
            secret=secret,
            metadata={"secret_kind": secret_kind},
            raw=raw_line,
        )

    async def bootstrap_session(self, account: NormalizedAccount) -> Any:
        secret_kind = account.metadata.get("secret_kind", "password")
        if secret_kind == "api_key":
            return {"mode": "api_key", "stub": True}

        if os.getenv("BATCHER_ENABLE_CAMOUFOX", "false").lower() != "true":
            return {"mode": "password", "stub": True}

        try:
            from browserforge.fingerprints import Screen
            from camoufox.async_api import AsyncCamoufox
        except Exception as exc:
            raise RetryableBatcherError(
                ErrorCode.browser_start_failed,
                f"camoufox import failed: {exc}",
            ) from exc

        camoufox_kwargs: dict[str, Any] = {
            "headless": os.getenv("BATCHER_CAMOUFOX_HEADLESS", "false").lower() == "true",
            "os": "windows",
            "block_webrtc": True,
            "humanize": False,
            "screen": Screen(max_width=1920, max_height=1080),
        }

        from app.proxy_pool import get_next_proxy

        proxy_url = get_next_proxy() or ""
        if proxy_url:
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

        try:
            manager = AsyncCamoufox(**camoufox_kwargs)
            browser = await manager.__aenter__()
            page = await browser.new_page()
            page.set_default_timeout(120000)
            await page.goto(PIONEER_AUTH_URL, wait_until="domcontentloaded", timeout=30000)
        except Exception as exc:
            raise RetryableBatcherError(
                ErrorCode.browser_start_failed,
                f"camoufox launch failed: {exc}",
            ) from exc

        return {
            "mode": "password",
            "stub": False,
            "manager": manager,
            "browser": browser,
            "page": page,
            "proxy_url": proxy_url or None,
        }

    async def authenticate(
        self, account: NormalizedAccount, session: Any
    ) -> dict[str, Any]:
        if session is None:
            raise RetryableBatcherError(
                ErrorCode.browser_unexpected_state, "no session for pioneer auth"
            )

        mode = session.get("mode", "password")

        if mode == "api_key":
            return {"mode": "api_key", "api_key": account.secret}

        if session.get("stub"):
            raise RetryableBatcherError(
                ErrorCode.browser_start_failed,
                "pioneer requires browser for Google OAuth login",
            )

        page = session["page"]

        # Click "Continue with Google" button
        try:
            google_btn = page.locator(
                'button:has-text("Google"), '
                'a:has-text("Google"), '
                '[data-provider="google"], '
                'button:has-text("Continue with Google")'
            ).first
            await asyncio.sleep(1.0)
            if await google_btn.count() > 0:
                await google_btn.click()
                await asyncio.sleep(2.0)
            else:
                _debug("No Google button found, checking if already on Google auth")
        except Exception as exc:
            _debug(f"Error clicking Google button: {exc}")

        # Handle Google OAuth
        await _drive_pioneer_auth(page, account.identifier, account.secret)

        # Wait for redirect back to Pioneer
        timeout_seconds = int(os.getenv("PIONEER_LOGIN_TIMEOUT", "120"))
        deadline = time.monotonic() + timeout_seconds

        redirected = False
        last_url = ""
        while time.monotonic() < deadline:
            try:
                cur = page.url
                last_url = cur
                cur_host = urlparse(cur).netloc
                if cur_host.endswith("agent.pioneer.ai"):
                    redirected = True
                    break
            except Exception:
                pass
            await asyncio.sleep(1.0)

        if not redirected:
            page_text = ""
            try:
                page_text = (await page.evaluate("() => (document.body && document.body.innerText) || ''"))[:300]
            except Exception:
                pass
            raise RetryableBatcherError(
                ErrorCode.auth_timeout,
                f"pioneer login timed out after {timeout_seconds}s @ url={last_url[:200]} | body={page_text!r}",
            )

        # Extract Supabase anon key from page config (needed for token refresh later)
        supabase_anon_key = ""
        try:
            supabase_anon_key = await page.evaluate("""() => {
                // Try common Supabase config locations
                if (window.__NEXT_DATA__) {
                    const env = window.__NEXT_DATA__.props?.pageProps?.env || window.__NEXT_DATA__.runtimeConfig || {};
                    for (const [k, v] of Object.entries(env)) {
                        if (k.toLowerCase().includes('supabase') && k.toLowerCase().includes('anon') && typeof v === 'string') return v;
                    }
                }
                // Search all script tags for supabase anon key pattern
                for (const script of document.querySelectorAll('script')) {
                    const text = script.textContent || '';
                    const match = text.match(/sb_publishable_[A-Za-z0-9_-]+/);
                    if (match) return match[0];
                    const match2 = text.match(/SUPABASE_ANON_KEY['":\\s]+['"]([^'"]+)['"]/);
                    if (match2) return match2[1];
                }
                // Check meta tags
                for (const meta of document.querySelectorAll('meta')) {
                    const content = meta.getAttribute('content') || '';
                    const match = content.match(/sb_publishable_[A-Za-z0-9_-]+/);
                    if (match) return match[0];
                }
                return '';
            }""")
        except Exception:
            pass
        _debug(f"supabase_anon_key: {supabase_anon_key[:20]}..." if supabase_anon_key else "supabase_anon_key: not found")

        # Poll localStorage for Supabase session — Supabase JS lib parses URL hash async
        supabase_session = None
        session_deadline = time.monotonic() + 30.0
        while time.monotonic() < session_deadline:
            supabase_session = await page.evaluate("""() => {
                for (let i = 0; i < localStorage.length; i++) {
                    const key = localStorage.key(i);
                    if (key && key.startsWith('sb-') && key.endsWith('-auth-token')) {
                        try {
                            const v = JSON.parse(localStorage.getItem(key));
                            if (v && v.access_token) return v;
                        } catch {}
                    }
                }
                return null;
            }""")
            if supabase_session:
                break
            await asyncio.sleep(1.0)

        if not supabase_session:
            # Diagnostic dump — what page are we actually on?
            try:
                cur_url = page.url
            except Exception:
                cur_url = "?"
            try:
                ls_keys = await page.evaluate("() => Object.keys(localStorage)")
            except Exception:
                ls_keys = []
            try:
                hash_part = await page.evaluate("() => location.hash || ''")
            except Exception:
                hash_part = ""
            try:
                body_text = (await page.evaluate("() => (document.body && document.body.innerText) || ''"))[:300]
            except Exception:
                body_text = ""
            raise RetryableBatcherError(
                ErrorCode.auth_token_extraction_failed,
                f"no Supabase session | url={cur_url[:120]} | hash={str(hash_part)[:80]} | ls_keys={ls_keys[:20]} | body={body_text!r}",
            )

        access_token = supabase_session.get("access_token", "")
        refresh_token = supabase_session.get("refresh_token", "")
        user = supabase_session.get("user", {})
        user_id = user.get("id", "")

        if not access_token:
            raise RetryableBatcherError(
                ErrorCode.auth_token_extraction_failed,
                "no access_token in Supabase session",
            )

        return {
            "mode": "password",
            "access_token": access_token,
            "refresh_token": refresh_token,
            "user_id": user_id,
            "supabase_anon_key": supabase_anon_key,
        }

    async def fetch_tokens(
        self,
        account: NormalizedAccount,
        auth_state: dict[str, Any],
        session: Any,
    ) -> dict[str, str]:
        mode = auth_state.get("mode", "password")

        if mode == "api_key":
            api_key = auth_state["api_key"]
            return {
                "api_key": api_key,
                "email": account.identifier,
                "method": "api_key",
            }

        access_token = auth_state["access_token"]
        refresh_token = auth_state.get("refresh_token", "")
        user_id = auth_state.get("user_id", "")

        headers = {"Authorization": f"Bearer {access_token}"}
        timeout = aiohttp.ClientTimeout(total=30)

        from app.proxy_pool import get_next_proxy, get_pool_size

        max_attempts = min(get_pool_size(), 5) or 1
        proxy_url = session.get("proxy_url") if session else None
        api_key = ""
        last_error = ""

        for attempt in range(max_attempts):
            try:
                async with aiohttp.ClientSession(timeout=timeout) as http:
                    create_body = {"name": f"poolprox2-{int(time.time())}"}
                    async with http.post(
                        PIONEER_CREATE_KEY_URL,
                        headers={**headers, "Content-Type": "application/json"},
                        json=create_body,
                        proxy=proxy_url,
                    ) as resp:
                        if resp.status in (407, 429):
                            text = await resp.text()
                            last_error = f"({resp.status}): {text[:200]}"
                            _debug(f"create-api-key attempt {attempt+1} failed {resp.status}, rotating proxy")
                            proxy_url = get_next_proxy()
                            continue
                        if resp.status not in (200, 201):
                            text = await resp.text()
                            raise RetryableBatcherError(
                                ErrorCode.auth_token_extraction_failed,
                                f"failed to create API key ({resp.status}): {text[:200]}",
                            )
                        data = await resp.json()
                        api_key = data.get("secret_key", "")
                        break
            except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
                last_error = str(exc)
                _debug(f"create-api-key attempt {attempt+1} network error: {last_error}, rotating proxy")
                proxy_url = get_next_proxy()
                continue

        if not api_key:
            raise RetryableBatcherError(
                ErrorCode.auth_token_extraction_failed,
                f"could not obtain Pioneer API key after {max_attempts} attempts: {last_error}",
            )

        return {
            "api_key": api_key,
            "access_token": access_token,
            "refresh_token": refresh_token,
            "user_id": user_id,
            "email": account.identifier,
            "method": "google_oauth",
            "supabase_anon_key": auth_state.get("supabase_anon_key", ""),
        }

    async def fetch_quota(
        self,
        account: NormalizedAccount,
        tokens: dict[str, str],
        session: Any,
    ) -> dict[str, Any] | None:
        access_token = tokens.get("access_token", "")
        if not access_token:
            return {"remaining_credits": 20000, "total_credits": 20000}

        headers = {"Authorization": f"Bearer {access_token}"}
        timeout = aiohttp.ClientTimeout(total=20)
        proxy_url = session.get("proxy_url") if session else None

        try:
            async with aiohttp.ClientSession(timeout=timeout) as http:
                async with http.get(PIONEER_BILLING_URL, headers=headers, proxy=proxy_url) as resp:
                    if resp.status != 200:
                        return {"remaining_credits": 20000, "total_credits": 20000}
                    data = await resp.json()
                    total = float(data.get("credit_limit") or 20000)
                    used = float(data.get("total_usage") or 0)
                    remaining = float(data.get("free_tier_remaining") or max(0.0, total - used))
                    return {
                        "remaining_credits": remaining,
                        "total_credits": total,
                        "current_usage": used,
                        "payment_plan": data.get("payment_plan", "hobby"),
                    }
        except Exception:
            return {"remaining_credits": 20000, "total_credits": 20000}

    async def post_login_hook(
        self,
        account: NormalizedAccount,
        tokens: dict[str, str],
        session: Any,
        existing_quota: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        if not isinstance(session, dict) or session.get("stub") or session.get("mode") == "api_key":
            return None

        page = session.get("page")
        if not page:
            return None

        from app.providers.vcc_pool import VCCPool

        vcc_pool = VCCPool.from_env()
        if vcc_pool.remaining() == 0:
            _debug("no VCC cards available")
            return {"payment_added": False, "payment_error": "no VCC cards available in pool"}

        address_raw = os.getenv("BATCHER_BILLING_ADDRESS", "{}")
        try:
            address = json.loads(address_raw)
        except (json.JSONDecodeError, TypeError):
            address = {}

        from app.providers.pioneer_payment import add_payment_method

        _debug("starting add payment method flow")
        try:
            success, message = await add_payment_method(page, vcc_pool, address)
            _debug(f"add payment result: success={success}, message={message}")
            return {"payment_added": success, "payment_message": message}
        except Exception as exc:
            _debug(f"add payment hook error: {exc}")
            return {"payment_added": False, "payment_error": str(exc)}

    async def cleanup_session(self, session: Any) -> None:
        if not isinstance(session, dict):
            return
        browser = session.get("browser")
        manager = session.get("manager")
        try:
            if browser:
                await browser.close()
        except Exception:
            pass
        try:
            if manager:
                await manager.__aexit__(None, None, None)
        except Exception:
            pass
