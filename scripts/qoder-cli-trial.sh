#!/bin/bash
# Qoder CLI Trial Activator
# 1. Starts qodercli login in background (waits for browser callback)
# 2. Captures the device auth URL
# 3. Approves it via the Python bot (Camoufox)
# 4. CLI receives callback → trial activated
#
# Usage: ./qoder-cli-trial.sh <email> <password>

set -euo pipefail

EMAIL="${1:?Usage: $0 <email> <password>}"
PASSWORD="${2:?Usage: $0 <email> <password>}"
QODERCLI="/tmp/qoder-extract/qodercli"
VENV="/home/priyo/dev/OpenProject/poolprox2/scripts/auth/.venv/bin/python3"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "[*] Resetting ~/.qoder for fresh machine_id..."
rm -rf ~/.qoder

echo "[*] Starting qodercli login in background..."
DEVICE_URL=""
BROWSER=echo $QODERCLI login 2>&1 | while IFS= read -r line; do
    echo "[cli] $line"
    if [[ "$line" == *"qoder.com/device/selectAccounts"* ]]; then
        # Extract URL
        URL=$(echo "$line" | grep -oP 'https://qoder\.com/device/selectAccounts\S+')
        if [[ -n "$URL" ]]; then
            echo "[*] Got device auth URL: $URL"
            echo "$URL" > /tmp/qoder-device-url.txt
        fi
    fi
    if [[ "$line" == *"Successfully"* || "$line" == *"success"* || "$line" == *"logged in"* ]]; then
        echo "[*] CLI login completed!"
    fi
done &
CLI_PID=$!

echo "[*] Waiting for device URL..."
for i in $(seq 1 30); do
    if [[ -f /tmp/qoder-device-url.txt ]]; then
        DEVICE_URL=$(cat /tmp/qoder-device-url.txt)
        break
    fi
    sleep 1
done

if [[ -z "$DEVICE_URL" ]]; then
    echo "[!] Failed to capture device URL after 30s"
    kill $CLI_PID 2>/dev/null || true
    exit 1
fi

echo "[*] Device URL captured: ${DEVICE_URL:0:80}..."
echo "[*] Approving via Camoufox bot..."

# Run the approval bot
PYTHONUNBUFFERED=1 BATCHER_ENABLE_CAMOUFOX=true BATCHER_CAMOUFOX_HEADLESS=true $VENV -u -c "
import asyncio
import os
import sys
sys.path.insert(0, '$SCRIPT_DIR/auth')

from app.providers.kiro import (
    _fill_google_email_step,
    _fill_google_password_step,
    _handle_google_consent_continue,
    _handle_google_gaplustos,
    _is_email_step,
    _is_password_step,
)
from urllib.parse import urlparse
import time

async def approve_device_auth():
    from browserforge.fingerprints import Screen
    from camoufox.async_api import AsyncCamoufox

    device_url = '$DEVICE_URL'
    email = '$EMAIL'
    password = '$PASSWORD'

    print(f'[bot] Launching Camoufox...')
    async with AsyncCamoufox(
        headless=True,
        os='windows',
        block_webrtc=True,
        humanize=False,
        screen=Screen(max_width=1920, max_height=1080),
    ) as browser:
        page = await browser.new_page()
        page.set_default_timeout(120000)

        # First login to Qoder via Google OAuth
        print(f'[bot] Navigating to Qoder sign-in...')
        await page.goto('https://qoder.com/sso/login/google?oauth_callback=https://qoder.com/account/profile', wait_until='domcontentloaded', timeout=30000)
        await asyncio.sleep(3.0)

        # Drive Google OAuth
        print(f'[bot] Driving Google OAuth for {email}...')
        for _ in range(120):
            try:
                cur = page.url
                cur_host = urlparse(cur).netloc
            except:
                break

            if cur_host.endswith('qoder.com') and '/users/sign-in' not in cur:
                print(f'[bot] Logged into Qoder: {cur[:60]}')
                break

            if await _handle_google_gaplustos(page):
                await asyncio.sleep(1.0)
                continue
            if await _handle_google_consent_continue(page):
                await asyncio.sleep(1.0)
                continue

            if cur_host.endswith('accounts.google.com'):
                if await _is_email_step(page) and not await _is_password_step(page):
                    await _fill_google_email_step(page, email)
                    await asyncio.sleep(2.0)
                    continue
                if await _is_password_step(page):
                    await _fill_google_password_step(page, password)
                    await asyncio.sleep(2.0)
                    continue

            await asyncio.sleep(1.0)

        await asyncio.sleep(2.0)

        # Now navigate to device auth URL and approve
        print(f'[bot] Navigating to device auth URL...')
        await page.goto(device_url, wait_until='domcontentloaded', timeout=30000)
        await asyncio.sleep(3.0)

        # Click Continue to approve
        try:
            continue_btn = page.locator('button:has-text(\"Continue\")').first
            if await continue_btn.count() > 0:
                await continue_btn.click()
                print('[bot] Clicked Continue - device auth approved!')
                await asyncio.sleep(5.0)
            else:
                print('[bot] No Continue button found, checking page...')
                body = await page.evaluate('() => document.body?.innerText?.slice(0, 300) || \"\"')
                print(f'[bot] Page content: {body[:200]}')
        except Exception as e:
            print(f'[bot] Error: {e}')

asyncio.run(approve_device_auth())
" 2>&1

echo "[*] Waiting for CLI to complete..."
sleep 10

# Check if CLI login succeeded
if [[ -f ~/.qoder/.auth/user ]]; then
    echo "[*] CLI auth file exists! Login successful."
else
    echo "[!] No auth file found."
fi

# Kill background CLI process
kill $CLI_PID 2>/dev/null || true
rm -f /tmp/qoder-device-url.txt

# Check quota
echo "[*] Checking quota..."
PYTHONUNBUFFERED=1 $VENV -u -c "
import asyncio, sys
sys.path.insert(0, '/home/priyo/dev/OpenProject/poolprox2')
from src.proxy.providers.qoder import activateQoderPat, openApiHeaders

async def check():
    import aiohttp
    # Need to get PAT first - check if we can read from auth file
    # For now just report auth status
    print('Auth files present:', bool(open('/home/priyo/.qoder/.auth/user', 'rb').read()))

asyncio.run(check())
" 2>&1 || echo "[!] Quota check failed"

echo "[*] Done."
