#!/usr/bin/env python3
import json
import os
import argparse
import time
import urllib.error
import urllib.request

DEFAULT_URL = os.getenv("MUSIC_API_URL", "http://127.0.0.1:5566/v1/music/generations")
DEFAULT_TOKEN = os.getenv("MUSIC_API_TOKEN", "pooled")
DEFAULT_PROMPT = "我想创作一首流行歌曲，用AI帮我写歌词。这首歌传达快乐的情绪，使用女声演唱。"


def ask(text: str, default: str = "") -> str:
    suffix = f" [{default}]" if default else ""
    value = input(f"{text}{suffix}: ").strip()
    return value or default


def post_json(url: str, token: str, payload: dict, timeout: int):
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


def main():
    parser = argparse.ArgumentParser(description="Test /v1/music/generations")
    parser.add_argument("--url", default=None, help=f"API URL, default: {DEFAULT_URL}")
    parser.add_argument("--token", default=None, help="Bearer token, default: pooled")
    parser.add_argument("--prompt", default=None, help="Music prompt")
    parser.add_argument("--theme", default=None, help="Theme/style")
    parser.add_argument("--mood", default=None, help="Mood")
    parser.add_argument("--genre", default=None, help="Genre")
    parser.add_argument("--gender", default=None, help="Voice gender")
    parser.add_argument("--lyric", default=None, help="Existing lyric")
    parser.add_argument("--keep-conversation", action="store_true", help="Set auto_delete=false")
    parser.add_argument("--no-input", action="store_true", help="Use defaults and CLI args without prompting")
    args = parser.parse_args()

    print("豆包音乐生成测试 /v1/music/generations\n")
    if args.no_input:
        url = args.url or DEFAULT_URL
        token = args.token or DEFAULT_TOKEN
        prompt = args.prompt or DEFAULT_PROMPT
        theme = args.theme or "薛之谦风格"
        mood = args.mood or "Happy"
        genre = args.genre or "Pop"
        gender = args.gender or "Female"
        lyric = args.lyric or ""
    else:
        url = args.url or ask("接口地址", DEFAULT_URL)
        token = args.token or ask("Authorization Bearer token，账号池可填 pooled", DEFAULT_TOKEN)
        prompt = args.prompt or ask("歌曲描述 prompt", DEFAULT_PROMPT)
        theme = args.theme or ask("主题/风格 theme", "薛之谦风格")
        mood = args.mood or ask("情绪 mood", "Happy")
        genre = args.genre or ask("曲风 genre", "Pop")
        gender = args.gender or ask("音色 gender", "Female")
        lyric = args.lyric if args.lyric is not None else ask("已有歌词 lyric，留空则 AI 写词", "")

    payload = {
        "model": "doubao-music",
        "prompt": prompt,
        "theme": theme,
        "mood": mood,
        "genre": genre,
        "gender": gender,
        "lyric": lyric,
        "generation_type": "text_to_music" if lyric else "AI_lyric",
        "auto_delete": not args.keep_conversation,
        "stream": False,
    }

    print("\n请求 payload:")
    print(json.dumps(payload, ensure_ascii=False, indent=2))

    start = time.time()
    try:
        with post_json(url, token, payload, timeout=900) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            elapsed = int((time.time() - start) * 1000)
            print(f"\nHTTP {resp.status} in {elapsed}ms\n")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        print(f"\nHTTP {e.code}\n{body}")
        return
    except Exception as e:
        print(f"\n请求失败: {e}")
        return

    try:
        parsed = json.loads(body)
    except json.JSONDecodeError:
        print(body)
        return

    message = parsed.get("choices", [{}])[0].get("message", {})
    music_items = message.get("music", [])

    print("结果 content:")
    print(message.get("content", ""))
    print("\n音乐条目:")
    print(json.dumps(music_items, ensure_ascii=False, indent=2)[:5000])

    urls = [item.get("url") for item in music_items if item.get("url")]
    if urls:
        print("\n音频 URL:")
        for index, url in enumerate(urls, start=1):
            print(f"{index}. {url}")
    else:
        print("\n未提取到音频 URL，请查看上面的 raw 结构或服务端 request_debug.jsonl。")


if __name__ == "__main__":
    main()
