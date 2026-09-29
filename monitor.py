import json
import os
import random
import re
import smtplib
import ssl
import sys
import time
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from pathlib import Path
from urllib.parse import quote

import feedparser
import requests

ACCOUNTS = [
    "aespa_official",
    "katarinabluu",
    "imwinter",
    "aerichandesu",
    "imnotningning",
]

STATE_PATH = Path("state.json")
MAX_ITEMS = 20
INITIAL_NOTIFY_WINDOW = timedelta(hours=1)

# Put the source that just proved reliable first. The monitor also remembers the
# last successful source per account and tries that exact URL before this list.
RSS_SOURCES = [
    "https://rssbridge.wdavery.com/?action=display&bridge=InstagramBridge&context=Username&u={username}&format=Atom",
    "https://rsshub.app/instagram/2/user/{username}",
    "https://rsshub.rssforever.com/instagram/2/user/{username}",
    "https://rsshub.feeded.xyz/instagram/2/user/{username}",
    "https://hub.slarker.me/instagram/2/user/{username}",
]

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36",
    "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
}

SESSION = requests.Session()
SESSION.headers.update(HEADERS)


def load_state() -> dict:
    if not STATE_PATH.exists():
        return {"accounts": {}}
    try:
        with STATE_PATH.open("r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            raise ValueError("state.json must contain a JSON object")
        data.setdefault("accounts", {})
        return data
    except Exception as exc:
        print(f"Warning: could not read state.json ({exc}); starting with empty state.")
        return {"accounts": {}}


def save_state(state: dict) -> None:
    with STATE_PATH.open("w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2, sort_keys=True)
        f.write("\n")


def require_email_settings() -> tuple[str, str, str]:
    sender = os.environ.get("GMAIL_ADDRESS", "").strip()
    app_password = os.environ.get("GMAIL_APP_PASSWORD", "").replace(" ", "").strip()
    recipient = os.environ.get("NOTIFY_EMAIL", "").strip()

    missing = []
    if not sender:
        missing.append("GMAIL_ADDRESS")
    if not app_password:
        missing.append("GMAIL_APP_PASSWORD")
    if not recipient:
        missing.append("NOTIFY_EMAIL")
    if missing:
        raise RuntimeError("Missing required GitHub Actions secrets: " + ", ".join(missing))

    return sender, app_password, recipient


def send_email(subject: str, body: str) -> None:
    sender, app_password, recipient = require_email_settings()

    message = EmailMessage()
    message["From"] = sender
    message["To"] = recipient
    message["Subject"] = subject
    message.set_content(body)

    context = ssl.create_default_context()
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, context=context, timeout=30) as smtp:
        smtp.login(sender, app_password)
        smtp.send_message(message)


def normalize_item_id(entry: dict) -> str:
    link = (entry.get("link") or "").strip()
    match = re.search(r"instagram\.com/(?:p|reel|tv)/([^/?#]+)", link)
    if match:
        return match.group(1)
    return (entry.get("id") or entry.get("guid") or link or entry.get("title") or "").strip()


def entry_datetime(entry: dict) -> datetime | None:
    parsed = entry.get("published_parsed") or entry.get("updated_parsed")
    if parsed:
        try:
            return datetime(*parsed[:6], tzinfo=timezone.utc)
        except (TypeError, ValueError):
            pass
    return None


def candidate_urls(username: str, preferred_source: str | None) -> list[str]:
    safe_username = quote(username, safe="")
    generated = [template.format(username=safe_username) for template in RSS_SOURCES]

    ordered = []
    if preferred_source:
        ordered.append(preferred_source)
    ordered.extend(generated)

    unique = []
    seen = set()
    for url in ordered:
        if url and url not in seen:
            seen.add(url)
            unique.append(url)
    return unique


def fetch_feed(username: str, preferred_source: str | None = None) -> tuple[list[dict], str]:
    errors = []

    for index, url in enumerate(candidate_urls(username, preferred_source)):
        try:
            print(f"Trying feed source: {url}", flush=True)
            timeout = 12 if index == 0 else 8
            response = SESSION.get(url, timeout=timeout, allow_redirects=True)
            if response.status_code != 200:
                raise RuntimeError(f"HTTP {response.status_code}")

            parsed = feedparser.parse(response.content)
            if getattr(parsed, "bozo", False) and not parsed.entries:
                raise RuntimeError(f"invalid feed: {parsed.bozo_exception}")
            if not parsed.entries:
                raise RuntimeError("feed returned no entries")

            items = []
            for entry in parsed.entries[:MAX_ITEMS]:
                item_id = normalize_item_id(entry)
                if not item_id:
                    continue
                published_dt = entry_datetime(entry)
                items.append(
                    {
                        "id": item_id,
                        "title": (entry.get("title") or "Instagram 更新").strip(),
                        "link": (entry.get("link") or f"https://www.instagram.com/{username}/").strip(),
                        "published": (entry.get("published") or entry.get("updated") or "未知").strip(),
                        "published_ts": published_dt.isoformat() if published_dt else None,
                    }
                )

            if not items:
                raise RuntimeError("feed entries had no usable IDs")

            return items, url
        except Exception as exc:
            errors.append(f"{url}: {exc}")
            print(f"Feed source failed: {url}: {exc}", file=sys.stderr, flush=True)

    raise RuntimeError("all feed sources failed | " + " || ".join(errors))


def notify_new_post(username: str, item: dict, note: str = "") -> None:
    subject = f"🔔 Instagram 更新：@{username}"
    note_block = f"\n{note}\n" if note else ""
    body = (
        f"@{username} 发现新的 Instagram 内容。\n"
        f"{note_block}\n"
        f"标题：{item['title']}\n"
        f"发布时间：{item['published']}\n"
        f"链接：{item['link']}\n\n"
        "此邮件由 GitHub Actions 自动发送。"
    )
    send_email(subject, body)
    print(f"Notification sent for @{username}: {item['link']}", flush=True)


def is_recent(item: dict, now_utc: datetime) -> bool:
    value = item.get("published_ts")
    if not value:
        return False
    try:
        published = datetime.fromisoformat(value)
    except ValueError:
        return False
    if published.tzinfo is None:
        published = published.replace(tzinfo=timezone.utc)
    return now_utc - INITIAL_NOTIFY_WINDOW <= published <= now_utc + timedelta(minutes=5)


def main() -> int:
    if os.environ.get("TEST_EMAIL") == "1":
        send_email(
            "✅ Instagram 监控测试邮件",
            "GitHub Actions 的 Gmail 自动发信配置已经成功。\n\n"
            "接下来程序会按计划检查 Instagram 更新。",
        )
        print("Test email sent successfully.", flush=True)

    state = load_state()
    account_state = state.setdefault("accounts", {})

    successful_accounts = 0
    failures = []
    now_utc = datetime.now(timezone.utc)

    for username in ACCOUNTS:
        try:
            previous = account_state.get(username, {})
            preferred_source = previous.get("last_source")

            print(f"Checking @{username} ...", flush=True)
            items, source = fetch_feed(username, preferred_source)
            successful_accounts += 1

            latest = items[0]
            print(
                f"Latest feed item for @{username}: id={latest['id']} | "
                f"published={latest['published']} | link={latest['link']}",
                flush=True,
            )

            seen_ids = set(previous.get("seen_ids", []))
            current_ids = [item["id"] for item in items]

            if not seen_ids:
                recent_items = [item for item in items if is_recent(item, now_utc)]
                if recent_items:
                    print(
                        f"Initializing @{username}; notifying {len(recent_items)} item(s) "
                        f"published within the last hour.",
                        flush=True,
                    )
                    for item in reversed(recent_items):
                        notify_new_post(
                            username,
                            item,
                            note="首次初始化保护：该内容发布时间在最近 1 小时内，因此仍发送提醒。",
                        )
                else:
                    print(
                        f"Initializing @{username} from {source}; no items from the last hour "
                        "will be back-notified.",
                        flush=True,
                    )
            else:
                new_items = [item for item in items if item["id"] not in seen_ids]
                for item in reversed(new_items):
                    notify_new_post(username, item)
                if not new_items:
                    print(f"No new posts for @{username}.", flush=True)

            merged_ids = current_ids + [item_id for item_id in seen_ids if item_id not in current_ids]
            account_state[username] = {
                "seen_ids": merged_ids[:100],
                "last_source": source,
            }

            time.sleep(random.uniform(0.5, 1.2))

        except Exception as exc:
            failures.append((username, str(exc)))
            print(f"Warning: failed to check @{username}: {exc}", file=sys.stderr, flush=True)
            time.sleep(random.uniform(0.3, 0.8))

    save_state(state)

    if failures:
        print("\nFailures:", file=sys.stderr, flush=True)
        for username, error in failures:
            print(f"- @{username}: {error}", file=sys.stderr, flush=True)

    if successful_accounts == 0:
        print("All Instagram feed checks failed.", file=sys.stderr, flush=True)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
