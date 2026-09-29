import json
import os
import random
import smtplib
import ssl
import sys
import time
from datetime import timezone
from email.message import EmailMessage
from pathlib import Path

import instaloader

ACCOUNTS = [
    "aespa_official",
    "katarinabluu",
    "imwinter",
    "aerichandesu",
    "imnotningning",
]

STATE_PATH = Path("state.json")
POSTS_TO_CHECK = 12


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


def post_type_name(post) -> str:
    typename = getattr(post, "typename", "")
    if typename == "GraphSidecar":
        return "轮播帖子"
    if typename == "GraphVideo":
        return "视频 / Reel"
    if typename == "GraphImage":
        return "图片帖子"
    return "Instagram 帖子"


def fetch_recent_posts(loader: instaloader.Instaloader, username: str) -> list[dict]:
    profile = instaloader.Profile.from_username(loader.context, username)
    result = []

    for index, post in enumerate(profile.get_posts()):
        if index >= POSTS_TO_CHECK:
            break

        timestamp = post.date_utc.replace(tzinfo=timezone.utc).isoformat()
        result.append(
            {
                "shortcode": post.shortcode,
                "timestamp": timestamp,
                "type": post_type_name(post),
                "url": f"https://www.instagram.com/p/{post.shortcode}/",
            }
        )

    return result


def parse_timestamp(value: str):
    if not value:
        return None
    try:
        return __import__("datetime").datetime.fromisoformat(value)
    except ValueError:
        return None


def notify_new_post(username: str, post: dict) -> None:
    subject = f"🔔 Instagram 更新：@{username}"
    body = (
        f"@{username} 刚刚发现新的 Instagram 内容。\n\n"
        f"类型：{post['type']}\n"
        f"发布时间（UTC）：{post['timestamp']}\n"
        f"链接：{post['url']}\n\n"
        "此邮件由 GitHub Actions 自动发送。"
    )
    send_email(subject, body)
    print(f"Notification sent for @{username}: {post['url']}")


def main() -> int:
    if os.environ.get("TEST_EMAIL") == "1":
        send_email(
            "✅ Instagram 监控测试邮件",
            "GitHub Actions 的 Gmail 自动发信配置已经成功。\n\n"
            "接下来程序会按计划检查 Instagram 更新。",
        )
        print("Test email sent successfully.")

    state = load_state()
    account_state = state.setdefault("accounts", {})

    loader = instaloader.Instaloader(
        download_pictures=False,
        download_videos=False,
        download_video_thumbnails=False,
        download_geotags=False,
        download_comments=False,
        save_metadata=False,
        compress_json=False,
        quiet=True,
    )

    successful_accounts = 0
    failures = []

    for username in ACCOUNTS:
        try:
            print(f"Checking @{username} ...")
            posts = fetch_recent_posts(loader, username)
            if not posts:
                raise RuntimeError("No posts were returned")

            successful_accounts += 1
            previous = account_state.get(username, {})
            previous_latest = parse_timestamp(previous.get("latest_timestamp", ""))
            previous_shortcodes = set(previous.get("recent_shortcodes", []))

            newest_timestamp = max(parse_timestamp(p["timestamp"]) for p in posts)

            if previous_latest is None:
                print(f"Initializing @{username}; existing posts will not trigger notifications.")
            else:
                new_posts = []
                for post in posts:
                    post_time = parse_timestamp(post["timestamp"])
                    if (
                        post_time is not None
                        and post_time > previous_latest
                        and post["shortcode"] not in previous_shortcodes
                    ):
                        new_posts.append(post)

                for post in sorted(new_posts, key=lambda item: item["timestamp"]):
                    notify_new_post(username, post)

                if not new_posts:
                    print(f"No new posts for @{username}.")

            account_state[username] = {
                "latest_timestamp": newest_timestamp.isoformat(),
                "recent_shortcodes": [p["shortcode"] for p in posts],
            }

            time.sleep(random.uniform(4.0, 8.0))

        except Exception as exc:
            failures.append((username, str(exc)))
            print(f"Warning: failed to check @{username}: {exc}", file=sys.stderr)
            time.sleep(random.uniform(3.0, 6.0))

    save_state(state)

    if failures:
        print("\nFailures:", file=sys.stderr)
        for username, error in failures:
            print(f"- @{username}: {error}", file=sys.stderr)

    if successful_accounts == 0:
        print("All Instagram checks failed.", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
