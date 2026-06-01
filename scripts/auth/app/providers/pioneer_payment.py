"""
Pioneer Add Payment Method — Stripe Elements form automation on /billing page.

Fills card + address iframes and clicks "Add payment method" button.
No charge occurs — this is card verification only.
"""

from __future__ import annotations

import asyncio
import json
import os
from typing import Any, Tuple

from app.providers.vcc_pool import VCCCard, VCCPool


def _debug(msg: str) -> None:
    if os.getenv("BATCHER_DEBUG", "").lower() == "true":
        print(f"[pioneer-payment] {msg}", flush=True)


def _progress(step: str, message: str) -> None:
    try:
        print(json.dumps({"type": "progress", "provider": "pioneer", "step": step, "message": message}), flush=True)
    except BrokenPipeError:
        pass


async def dismiss_onboarding_dialog(page: Any) -> None:
    """Close the onboarding dialog if it appears."""
    try:
        close_btn = page.locator('dialog button:has-text("Close"), [role="dialog"] button:has-text("Close")')
        if await close_btn.count() > 0:
            await close_btn.first.click(timeout=3000)
            await asyncio.sleep(0.5)
            _debug("dismissed onboarding dialog")
    except Exception:
        pass


async def navigate_to_billing(page: Any) -> bool:
    """Navigate to /billing and wait for Stripe iframe to appear."""
    try:
        cur_url = page.url or ""
        if "/billing" not in cur_url:
            await page.goto("https://agent.pioneer.ai/billing", wait_until="domcontentloaded", timeout=30000)
            await asyncio.sleep(2.0)

        await dismiss_onboarding_dialog(page)

        # Wait for Stripe card iframe to appear
        stripe_iframe = page.locator('iframe[src*="js.stripe.com"]').first
        await stripe_iframe.wait_for(state="attached", timeout=20000)
        _debug("billing page loaded, Stripe iframe found")
        return True
    except Exception as exc:
        _debug(f"navigate_to_billing failed: {exc}")
        return False


async def _has_payment_on_file(page: Any) -> bool:
    """Check if a payment method is already saved (card-on-file indicator visible)."""
    try:
        # Only return True if we positively see a card-on-file indicator
        card_display = page.locator('text=/ending in \\d{4}/, text=/•••• \\d{4}/, text=/Visa|Mastercard|Amex/i')
        if await card_display.count() > 0:
            return True
        return False
    except Exception:
        return False


async def fill_stripe_card(page: Any, card: VCCCard) -> bool:
    """Fill card number, expiry, and CVC in the Stripe Card Element iframe."""
    try:
        all_stripe_iframes = page.locator('iframe[src*="js.stripe.com"]')
        iframe_count = await all_stripe_iframes.count()
        _debug(f"found {iframe_count} stripe iframe(s)")

        # Find the correct card iframe by looking for the one with card number input
        card_frame = None
        for i in range(iframe_count):
            frame = page.frame_locator('iframe[src*="js.stripe.com"]').nth(i)
            try:
                card_input = frame.locator('[placeholder="Card number"]')
                if await card_input.count() > 0:
                    card_frame = frame
                    _debug(f"card iframe found at index {i}")
                    break
            except Exception:
                continue

        if not card_frame:
            _debug("could not find card iframe with placeholder='Card number'")
            return False

        # Card number
        card_input = card_frame.locator('[placeholder="Card number"]')
        await card_input.click(timeout=5000)
        await card_input.press_sequentially(card.number, delay=55)
        await asyncio.sleep(0.3)

        # Expiry
        exp_str = f"{card.exp_month}{card.exp_year[-2:]}"
        exp_input = card_frame.locator('[placeholder="MM / YY"]')
        await exp_input.click(timeout=3000)
        await exp_input.press_sequentially(exp_str, delay=55)
        await asyncio.sleep(0.3)

        # CVC
        cvc_input = card_frame.locator('[placeholder="CVC"]')
        await cvc_input.click(timeout=3000)
        await cvc_input.press_sequentially(card.cvv, delay=55)
        await asyncio.sleep(0.3)

        _debug(f"filled card ending {card.last4}")
        return True
    except Exception as exc:
        _debug(f"fill_stripe_card failed: {exc}")
        return False


async def fill_stripe_address(page: Any, card: VCCCard, address: dict[str, str]) -> bool:
    """Fill billing address in the Stripe Address Element iframe."""
    try:
        all_stripe_iframes = page.locator('iframe[src*="js.stripe.com"]')
        iframe_count = await all_stripe_iframes.count()

        # Find the address iframe — it contains "First name" or "Address" fields
        addr_frame = None
        for i in range(iframe_count):
            frame = page.frame_locator('iframe[src*="js.stripe.com"]').nth(i)
            try:
                # Try multiple selectors to find the address iframe
                for selector in [
                    'input[aria-label="First name"]',
                    'input[placeholder="First"]',
                    'input[aria-label="Address line 1"]',
                    'select[aria-label="Country or region"]',
                    ':text("First name")',
                ]:
                    el = frame.locator(selector)
                    if await el.count() > 0:
                        addr_frame = frame
                        _debug(f"address iframe found at index {i} via {selector}")
                        break
                if addr_frame:
                    break
            except Exception:
                continue

        if not addr_frame:
            _debug("could not find address iframe")
            return True

        first_name = address.get("first_name", "")
        last_name = address.get("last_name", "")
        if not first_name and not last_name:
            full_name = address.get("name", card.name or "John Doe")
            parts = full_name.strip().split(" ", 1)
            first_name = parts[0]
            last_name = parts[1] if len(parts) > 1 else "Doe"

        # Fill address fields using role-based selectors
        # Stripe Address Element uses textbox role with accessible names
        # First name
        try:
            fn_input = addr_frame.get_by_role("textbox", name="First name")
            await fn_input.click(timeout=5000)
            await fn_input.fill(first_name)
            await asyncio.sleep(0.2)
            _debug(f"filled first name: {first_name}")
        except Exception as e:
            _debug(f"first name fill failed: {e}")

        # Last name
        try:
            ln_input = addr_frame.get_by_role("textbox", name="Last name")
            await ln_input.click(timeout=3000)
            await ln_input.fill(last_name)
            await asyncio.sleep(0.2)
            _debug(f"filled last name: {last_name}")
        except Exception as e:
            _debug(f"last name fill failed: {e}")

        # Country — already defaults to "United States", skip if US
        country = address.get("country", "US")
        if country and country != "US":
            try:
                country_select = addr_frame.get_by_role("combobox", name="Country or region")
                await country_select.select_option(country, timeout=3000)
                await asyncio.sleep(0.5)
            except Exception:
                _debug(f"country select failed for {country}")
        else:
            _debug("country already US (default), skipping")

        # Address line 1
        line1 = address.get("line1", "123 Main St")
        try:
            addr1_input = addr_frame.get_by_role("textbox", name="Address line 1")
            await addr1_input.click(timeout=3000)
            await addr1_input.fill(line1)
            await asyncio.sleep(0.2)
            _debug(f"filled address: {line1}")
        except Exception as e:
            _debug(f"address fill failed: {e}")

        # City
        city = address.get("city", "New York")
        try:
            city_input = addr_frame.get_by_role("textbox", name="City")
            await city_input.click(timeout=3000)
            await city_input.fill(city)
            await asyncio.sleep(0.2)
            _debug(f"filled city: {city}")
        except Exception as e:
            _debug(f"city fill failed: {e}")

        # State — may be a combobox (select) or textbox depending on country
        state = address.get("state", "NY")
        try:
            # Try combobox first (US states use dropdown)
            state_combo = addr_frame.get_by_role("combobox", name="State")
            if await state_combo.count() > 0:
                await state_combo.select_option(state, timeout=3000)
                _debug(f"filled state via combobox: {state}")
            else:
                state_input = addr_frame.get_by_role("textbox", name="State")
                await state_input.click(timeout=3000)
                await state_input.fill(state)
                _debug(f"filled state via textbox: {state}")
            await asyncio.sleep(0.2)
        except Exception as e:
            _debug(f"state fill failed: {e}")

        # ZIP code
        postal = address.get("postal_code", "10001")
        try:
            zip_input = addr_frame.get_by_role("textbox", name="ZIP code")
            await zip_input.click(timeout=3000)
            await zip_input.fill(postal)
            await asyncio.sleep(0.2)
            _debug(f"filled zip: {postal}")
        except Exception as e:
            _debug(f"zip fill failed: {e}")

        _debug("filled billing address")
        return True
    except Exception as exc:
        _debug(f"fill_stripe_address failed: {exc}")
        return False


async def click_add_payment(page: Any) -> tuple[bool, str | None]:
    """
    Click 'Add payment method' and intercept Stripe network response.
    Returns (clicked, instant_result) where instant_result is:
      - "success" if setup_intents/confirm returned 200
      - "declined:<msg>" if Stripe returned 402/400
      - None if we couldn't intercept (fall back to DOM polling)
    """
    result: dict[str, str | None] = {"status": None}
    clicked_at: dict[str, float] = {"ts": 0.0}

    def on_response(response):
        # Ignore responses that arrived before we clicked
        if clicked_at["ts"] == 0.0:
            return
        url = response.url or ""
        if "api.stripe.com" not in url and "stripe.com" not in url:
            return
        status = response.status
        if "/v1/setup_intents" in url and "/confirm" in url:
            if status == 200:
                result["status"] = "success"
            elif status in (400, 402, 403):
                result["status"] = f"declined:{status}"
        elif "/v1/setup_intents" in url or "/v1/payment_methods" in url:
            if status in (400, 402, 403):
                result["status"] = f"declined:{status}"

    try:
        page.on("response", on_response)
    except Exception:
        pass

    try:
        btn = page.locator('button:has-text("Add payment method")').last
        await btn.wait_for(state="visible", timeout=5000)

        for _ in range(20):
            if await btn.is_enabled():
                break
            await asyncio.sleep(0.5)

        import time as _time
        clicked_at["ts"] = _time.monotonic()
        await btn.click(timeout=5000)
        _debug("clicked Add payment method")

        # Wait for Stripe network response (max 10s)
        for _ in range(20):
            if result["status"]:
                break
            await asyncio.sleep(0.5)

        return True, result["status"]
    except Exception as exc:
        _debug(f"click_add_payment failed: {exc}")
        return False, None
    finally:
        try:
            page.remove_listener("response", on_response)
        except Exception:
            pass


async def detect_error(page: Any) -> str | None:
    """Check for Stripe error messages in the card iframe."""
    try:
        card_frame = page.frame_locator('iframe[src*="js.stripe.com"]').first
        error_el = card_frame.locator('[class*="Error"], [role="alert"], .StripeElement--invalid')
        if await error_el.count() > 0:
            text = await error_el.first.inner_text(timeout=2000)
            if text.strip():
                return text.strip()
    except Exception:
        pass

    # Check main page for error toasts/messages
    try:
        error_toast = page.locator('[role="alert"], .toast-error, [class*="error" i]:visible')
        for i in range(await error_toast.count()):
            text = await error_toast.nth(i).inner_text(timeout=1000)
            text_lower = text.strip().lower()
            if any(kw in text_lower for kw in ["decline", "invalid", "fail", "error", "unable"]):
                return text.strip()
    except Exception:
        pass

    return None


async def detect_success(page: Any) -> bool:
    """Check if payment method was successfully added.
    Only returns True on positive confirmation — never on absence of button alone.
    """
    # Check for card-on-file display (strongest signal)
    try:
        card_display = page.locator('text=/ending in \\d{4}/, text=/•••• \\d{4}/, text=/Visa|Mastercard|Amex/i')
        if await card_display.count() > 0:
            return True
    except Exception:
        pass

    # Check for success toast/notification
    try:
        success_indicators = page.locator(
            'text=/payment method (added|saved|updated)/i, '
            'text=/card (added|saved|verified)/i, '
            'text=/successfully/i'
        )
        if await success_indicators.count() > 0:
            return True
    except Exception:
        pass
    except Exception:
        pass

    return False


async def clear_card_fields(page: Any) -> None:
    """Clear card fields for retry with a different card."""
    try:
        card_frame = page.frame_locator('iframe[src*="js.stripe.com"]').first
        for placeholder in ["Card number", "MM / YY", "CVC"]:
            try:
                field = card_frame.locator(f'[placeholder="{placeholder}"]')
                await field.click(timeout=2000)
                await field.press("Control+A")
                await field.press("Backspace")
                await asyncio.sleep(0.1)
            except Exception:
                pass
    except Exception:
        pass


async def add_payment_method(
    page: Any,
    vcc_pool: VCCPool,
    address: dict[str, str],
) -> Tuple[bool, str]:
    """
    Orchestrator: iterate cards from pool, fill form, submit, detect result.
    Returns (success, message).
    """
    if not await navigate_to_billing(page):
        return False, "failed to navigate to billing page"

    if await _has_payment_on_file(page):
        _progress("payment_skip", "Payment method already on file")
        return True, "already_has_payment"

    card_index = 0
    for card in vcc_pool:
        card_index += 1
        _progress("payment_filling", f"Trying card {card_index} (ending {card.last4})")

        if card_index > 1:
            await clear_card_fields(page)
            await asyncio.sleep(0.5)

        if not await fill_stripe_card(page, card):
            _debug(f"card {card.last4} fill failed, trying next")
            vcc_pool.mark_declined(card)
            continue

        if not await fill_stripe_address(page, card, address):
            _debug(f"address fill failed for card {card.last4}")

        clicked, instant_result = await click_add_payment(page)
        if not clicked:
            _debug("submit button click failed, retrying")
            await asyncio.sleep(1.0)
            clicked, instant_result = await click_add_payment(page)
            if not clicked:
                vcc_pool.mark_declined(card)
                continue

        # Fast path: network intercept gave us an instant answer
        if instant_result == "success":
            await asyncio.sleep(1.0)
            vcc_pool.mark_success(card)
            _progress("payment_success", f"Payment method added (card ending {card.last4})")
            return True, f"success: card ending {card.last4}"
        elif instant_result and instant_result.startswith("declined"):
            _progress("payment_declined", f"Card {card.last4} declined (network: {instant_result})")
            vcc_pool.mark_declined(card)
            # Clear and try next card immediately
            await clear_card_fields(page)
            await asyncio.sleep(0.5)
            continue

        # Slow path: DOM polling fallback (network intercept missed)
        _progress("payment_waiting", f"Waiting for result (card {card.last4})...")
        for poll in range(30):
            if await detect_success(page):
                vcc_pool.mark_success(card)
                _progress("payment_success", f"Payment method added (card ending {card.last4})")
                return True, f"success: card ending {card.last4}"

            error = await detect_error(page)
            if error:
                error_lower = error.lower()
                if any(kw in error_lower for kw in ["decline", "insufficient", "invalid card", "expired"]):
                    _progress("payment_declined", f"Card {card.last4} declined: {error[:100]}")
                    vcc_pool.mark_declined(card)
                    break
                else:
                    _debug(f"non-decline error: {error}")
                    if poll > 10:
                        vcc_pool.mark_declined(card)
                        break

            await asyncio.sleep(0.5)
        else:
            if await detect_success(page):
                vcc_pool.mark_success(card)
                _progress("payment_success", f"Payment method added (card ending {card.last4})")
                return True, f"success: card ending {card.last4}"
            _debug(f"timeout for card {card.last4}, trying next")
            vcc_pool.mark_declined(card)

        # Clear fields for next card attempt (no reload needed)
        await clear_card_fields(page)
        await asyncio.sleep(0.5)

    return False, f"all {card_index} cards exhausted"
