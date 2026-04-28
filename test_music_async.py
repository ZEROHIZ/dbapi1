#!/usr/bin/env python3
import argparse
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_URL = os.getenv("MUSIC_ASYNC_API_URL", "http://127.0.0.1:5566/v1/music/generations/async")
DEFAULT_TOKEN = os.getenv("MUSIC_API_TOKEN", "pooled")
DEFAULT_PROMPT = "创作一首轻快的流行歌曲，表达快乐情绪，女声演唱。"


def post_json(url: str, token: str, payload: dict, timeout: int = 60):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        },
        method="POST",
    )
    return urllib.request.urlopen(req, timeout=timeout)


def get_json(url: str, token: str, timeout: int = 60):
    req = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {token}"},
        method="GET",
    )
    return urllib.request.urlopen(req, timeout=timeout)


def read_json_response(resp):
    body = resp.read().decode("utf-8", errors="replace")
    return json.loads(body)


def main():
    parser = argparse.ArgumentParser(description="Test /v1/music/generations/async")
    parser.add_argument("--url", default=DEFAULT_URL, help=f"Async API URL, default: {DEFAULT_URL}")
    parser.add_argument("--token", default=DEFAULT_TOKEN, help="Bearer token, default: pooled")
    parser.add_argument("--prompt", default=DEFAULT_PROMPT, help="Music prompt")
    parser.add_argument("--theme", default="", help="Theme/style")
    parser.add_argument("--mood", default="Happy", help="Mood")
    parser.add_argument("--genre", default="Pop", help="Genre")
    parser.add_argument("--gender", default="Female", help="Voice gender")
    parser.add_argument("--lyric", default="", help="Existing lyric")
    parser.add_argument("--keep-conversation", action="store_true", help="Set auto_delete=false")
    parser.add_argument("--poll-interval", type=int, default=5, help="Polling interval seconds")
    parser.add_argument("--timeout", type=int, default=420, help="Total polling timeout seconds")
    args = parser.parse_args()

    payload = {
        "model": "doubao-music",
        "prompt": args.prompt,
        "theme": args.theme,
        "mood": args.mood,
        "genre": args.genre,
        "gender": args.gender,
        "lyric": args.lyric,
        "generation_type": "text_to_music" if args.lyric else "AI_lyric",
        "auto_delete": not args.keep_conversation,
        "stream": False,
    }

    print("提交异步音乐任务:")
    print(json.dumps(payload, ensure_ascii=False, indent=2))

    try:
        with post_json(args.url, args.token, payload) as resp:
            submitted = read_json_response(resp)
    except urllib.error.HTTPError as e:
        print(e.read().decode("utf-8", errors="replace"))
        return

    print("\n提交响应:")
    print(json.dumps(submitted, ensure_ascii=False, indent=2))

    data = submitted.get("data", submitted)
    task_id = data.get("task_id")
    if not task_id:
        print("未返回 task_id")
        return

    parsed_url = urllib.parse.urlparse(args.url)
    base = f"{parsed_url.scheme}://{parsed_url.netloc}"
    query_url = data.get("query_url") or f"/v1/generations/tasks/{task_id}"
    if query_url.startswith("/"):
        query_url = base + query_url

    print(f"\n开始轮询: {query_url}")
    deadline = time.time() + args.timeout
    while time.time() < deadline:
        time.sleep(args.poll_interval)
        with get_json(query_url, args.token) as resp:
            task = read_json_response(resp)
        task_data = task.get("data", task)
        status = task_data.get("status")
        print(f"status={status}")
        if status in ("succeeded", "failed"):
            print(json.dumps(task, ensure_ascii=False, indent=2)[:8000])
            return

    print("轮询超时")


if __name__ == "__main__":
    main()
