#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
豆包 API 同步与异步图片/视频生成交互式测试脚本
支持按 1、2、3、4 选择菜单测试不同步骤。
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request

# 解决 Windows CMD 控制台输出 Unicode / Emoji 编码问题
if sys.stdout and hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

# 默认配置
DEFAULT_BASE_URL = os.getenv("DOUBAO_API_BASE", "http://127.0.0.1:5566")
DEFAULT_TOKEN = os.getenv("DOUBAO_API_TOKEN", "pooled")


def request_json(method: str, url: str, token: str, payload: dict | None = None, timeout: int = 120) -> dict:
    """发送 HTTP 请求并解析 JSON 响应"""
    data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {token}",
    }
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            return json.loads(body)
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace")
        print(f"\n[!] HTTP 错误 {e.code}: {err_body}")
        raise
    except Exception as e:
        print(f"\n[!] 网络/解析错误: {e}")
        raise


def unwrap_data(response: dict) -> dict:
    """解包包装在 code/data 格式中的 data"""
    if response.get("code") == 0 and isinstance(response.get("data"), dict):
        return response["data"]
    return response


# ==============================================================================
# 步骤 1: 同步生成图片
# ==============================================================================
def test_sync_image(base_url: str, token: str):
    print("\n" + "=" * 55)
    print(" 【1】 测试：同步生成图片 (Sync Text-to-Image)")
    print("=" * 55)

    prompt = input("请输入图片提示词 [默认: 一只可爱的赛博朋克风格猫咪，3D卡通，高细节]: ").strip()
    if not prompt:
        prompt = "一只可爱的赛博朋克风格猫咪，3D卡通，高细节"

    model = input("请输入图片模型 [默认: Seedream 4.0]: ").strip()
    if not model:
        model = "Seedream 4.0"

    ratio = input("请输入图片比例 (1:1 / 16:9 / 9:16) [默认: 1:1]: ").strip()
    if not ratio:
        ratio = "1:1"

    url = base_url.rstrip("/") + "/v1/images/generations"
    payload = {
        "model": model,
        "prompt": prompt,
        "ratio": ratio,
        "stream": False,
        "auto_delete": True
    }

    print(f"\n正在发送同步图片生成请求至: {url}")
    print(f"请求体: {json.dumps(payload, ensure_ascii=False)}")

    start_time = time.time()
    res = request_json("POST", url, token, payload, timeout=120)
    elapsed = time.time() - start_time

    print(f"\n[+] 同步图片生成成功! (耗时: {elapsed:.2f}s)")
    print("响应结果:")
    print(json.dumps(res, ensure_ascii=False, indent=2))

    # 提取图片 URL
    choices = res.get("choices", [])
    if choices:
        msg = choices[0].get("message", {})
        images = msg.get("images", [])
        if images:
            print("\n生成图片地址:")
            for idx, img_url in enumerate(images, 1):
                print(f"  [{idx}] {img_url}")


# ==============================================================================
# 步骤 2: 异步生成图片 + 轮询
# ==============================================================================
def test_async_image(base_url: str, token: str):
    print("\n" + "=" * 55)
    print(" 【2】 测试：异步生成图片 (Async Text-to-Image)")
    print("=" * 55)

    prompt = input("请输入图片提示词 [默认: 极简现代风科技客厅，暖色调光影，8k分辨率]: ").strip()
    if not prompt:
        prompt = "极简现代风科技客厅，暖色调光影，8k分辨率"

    model = input("请输入图片模型 [默认: Seedream 4.0]: ").strip()
    if not model:
        model = "Seedream 4.0"

    ratio = input("请输入图片比例 [默认: 16:9]: ").strip()
    if not ratio:
        ratio = "16:9"

    url = base_url.rstrip("/") + "/v1/images/generations/async"
    payload = {
        "model": model,
        "prompt": prompt,
        "ratio": ratio,
        "style": "auto",
        "auto_delete": True
    }

    print(f"\n正在提交异步图片生成任务至: {url}")
    res = request_json("POST", url, token, payload, timeout=60)
    print("提交响应结果:")
    print(json.dumps(res, ensure_ascii=False, indent=2))

    data = unwrap_data(res)
    task_id = data.get("task_id")
    if not task_id:
        print("[!] 未获取到 task_id，任务创建失败")
        return

    # 开始轮询
    poll_and_display_task(base_url, token, task_id, interval=3, timeout=180)


# ==============================================================================
# 步骤 3: 同步生成视频
# ==============================================================================
def test_sync_video(base_url: str, token: str):
    print("\n" + "=" * 55)
    print(" 【3】 测试：同步生成视频 (Sync Text-to-Video)")
    print("=" * 55)

    prompt = input("请输入视频提示词 [默认: 金色沙滩上，层层浪花拍打着海岸，远处的夕阳徐徐落下，镜头缓慢向前推进]: ").strip()
    if not prompt:
        prompt = "金色沙滩上，层层浪花拍打着海岸，远处的夕阳徐徐落下，镜头缓慢向前推进"

    model = input("请输入视频模型 (sdmini / sdfast / seedance_v2.0) [默认: sdmini]: ").strip()
    if not model:
        model = "sdmini"

    duration = input("请输入生成时长(秒) [默认: 5]: ").strip()
    duration_val = int(duration) if duration.isdigit() else 5

    url = base_url.rstrip("/") + "/v1/video/generations"
    payload = {
        "model": model,
        "prompt": prompt,
        "ratio": "16:9",
        "duration": duration_val,
        "stream": False,
        "auto_delete": False
    }

    print(f"\n正在发送同步视频生成请求至: {url} (请耐心等待 1-3 分钟)...")
    print(f"请求体: {json.dumps(payload, ensure_ascii=False)}")

    start_time = time.time()
    res = request_json("POST", url, token, payload, timeout=300)
    elapsed = time.time() - start_time

    print(f"\n[+] 同步视频生成成功! (耗时: {elapsed:.2f}s)")
    print("响应结果:")
    print(json.dumps(res, ensure_ascii=False, indent=2))

    # 提取视频直链
    choices = res.get("choices", [])
    if choices:
        msg = choices[0].get("message", {})
        videos = msg.get("videos", [])
        if videos:
            print("\n生成视频（超清无水印直链）:")
            for idx, v in enumerate(videos, 1):
                print(f"  [{idx}] VID: {v.get('vid')}")
                print(f"      无水印直链: {v.get('url')}")
                print(f"      封面预览: {v.get('cover')}")


# ==============================================================================
# 步骤 4: 异步生成视频 + 轮询
# ==============================================================================
def test_async_video(base_url: str, token: str):
    print("\n" + "=" * 55)
    print(" 【4】 测试：异步生成视频 (Async Text-to-Video)")
    print("=" * 55)

    prompt = input("请输入视频提示词 [默认: 金色沙滩上，层层浪花拍打着海岸，远处的夕阳徐徐落下，镜头缓慢向前推进]: ").strip()
    if not prompt:
        prompt = "金色沙滩上，层层浪花拍打着海岸，远处的夕阳徐徐落下，镜头缓慢向前推进"

    model = input("请输入视频模型 (sdmini / sdfast / seedance_v2.0) [默认: sdmini]: ").strip()
    if not model:
        model = "sdmini"

    duration = input("请输入生成时长(秒) [默认: 5]: ").strip()
    duration_val = int(duration) if duration.isdigit() else 5

    url = base_url.rstrip("/") + "/v1/video/generations/async"
    payload = {
        "model": model,
        "prompt": prompt,
        "ratio": "16:9",
        "duration": duration_val,
        "auto_delete": False
    }

    print(f"\n正在提交异步视频生成任务至: {url}")
    res = request_json("POST", url, token, payload, timeout=60)
    print("提交响应结果:")
    print(json.dumps(res, ensure_ascii=False, indent=2))

    data = unwrap_data(res)
    task_id = data.get("task_id")
    if not task_id:
        print("[!] 未获取到 task_id，任务创建失败")
        return

    # 开始轮询
    poll_and_display_task(base_url, token, task_id, interval=5, timeout=300)


# ==============================================================================
# 步骤 5: 查询异步任务 ID
# ==============================================================================
def test_query_task(base_url: str, token: str):
    print("\n" + "=" * 55)
    print(" 【5】 测试：手动查询异步任务状态")
    print("=" * 55)

    task_id = input("请输入任务 ID (例如 media-1785350264655-2i2jhelm): ").strip()
    if not task_id:
        print("[!] 任务 ID 不能为空")
        return

    query_url = base_url.rstrip("/") + f"/v1/generations/tasks/{task_id}"
    print(f"\n正在查询任务状态: {query_url}")
    res = request_json("GET", query_url, token, timeout=30)
    print("查询结果:")
    print(json.dumps(res, ensure_ascii=False, indent=2))


# ==============================================================================
# 轮询帮助函数
# ==============================================================================
def poll_and_display_task(base_url: str, token: str, task_id: str, interval: int = 5, timeout: int = 300):
    query_url = base_url.rstrip("/") + f"/v1/generations/tasks/{task_id}"
    deadline = time.time() + timeout
    last_status = None

    print(f"\n开始轮询异步任务: {task_id} (每 {interval} 秒轮询一次)")

    while time.time() < deadline:
        res = request_json("GET", query_url, token, timeout=30)
        data = unwrap_data(res)
        status = data.get("status")

        if status != last_status:
            print(f"[{time.strftime('%H:%M:%S')}] 任务状态变更为 -> {status}")
            last_status = status

        if status in ("succeeded", "failed"):
            print("\n任务终态响应:")
            print(json.dumps(res, ensure_ascii=False, indent=2))

            if status == "succeeded":
                media = data.get("media") or []
                print(f"\n[+] 任务成功生成！共获得 {len(media)} 个文件:")
                for idx, item in enumerate(media, 1):
                    print(f"  [{idx}] 类型: {item.get('type')}")
                    print(f"      无水印/原始 URL: {item.get('url')}")
                    print(f"      本地访问 URL: {item.get('local_url')}")
                    print(f"      本地磁盘路径: {item.get('local_path')}")
                    print(f"      文件大小: {item.get('size')} 字节")
            else:
                print(f"\n[!] 任务生成失败: {data.get('error')}")
            return

        time.sleep(interval)

    print(f"\n[!] 轮询超时！任务在 {timeout} 秒内未完成。任务 ID: {task_id}")


# ==============================================================================
# 主交互逻辑
# ==============================================================================
def main():
    print("=" * 60)
    print("      豆包 API 图片与视频生成交互式测试工具")
    print("=" * 60)
    print(f"默认服务地址 (API Base) : {DEFAULT_BASE_URL}")
    print(f"默认鉴权令牌 (Token)    : {DEFAULT_TOKEN}")

    try:
        custom_url = input(f"\n按 Enter 使用默认服务地址 [{DEFAULT_BASE_URL}] 或输入新地址: ").strip()
        base_url = custom_url if custom_url else DEFAULT_BASE_URL

        custom_token = input(f"按 Enter 使用默认 Token [{DEFAULT_TOKEN}] 或输入新 Token: ").strip()
        token = custom_token if custom_token else DEFAULT_TOKEN
    except (KeyboardInterrupt, EOFError):
        print("\n已退出。")
        return

    while True:
        print("\n" + "=" * 60)
        print(" 请选择您想要执行的测试步骤:")
        print("  [1] 同步生成图片 (Sync Text-to-Image)")
        print("  [2] 异步生成图片 + 自动轮询 (Async Text-to-Image)")
        print("  [3] 同步生成视频 (Sync Text-to-Video)")
        print("  [4] 异步生成视频 + 自动轮询 (Async Text-to-Video)")
        print("  [5] 手动查询异步任务状态 (Query Task ID)")
        print("  [0] 退出脚本 (Exit)")
        print("=" * 60)

        try:
            choice = input("请输入步骤数字 (0-5): ").strip()
        except (KeyboardInterrupt, EOFError):
            print("\n已退出。")
            break

        try:
            if choice == "1":
                test_sync_image(base_url, token)
            elif choice == "2":
                test_async_image(base_url, token)
            elif choice == "3":
                test_sync_video(base_url, token)
            elif choice == "4":
                test_async_video(base_url, token)
            elif choice == "5":
                test_query_task(base_url, token)
            elif choice in ("0", "q", "exit"):
                print("\n已退出测试程序。")
                break
            else:
                print("\n⚠️ 无效的选项，请输入数字 0 到 5。")
        except Exception as err:
            print(f"\n[!] 执行步骤 [{choice}] 遇到错误: {err}")

        try:
            input("\n按 Enter 键返回主菜单...")
        except (KeyboardInterrupt, EOFError):
            break


if __name__ == "__main__":
    main()
