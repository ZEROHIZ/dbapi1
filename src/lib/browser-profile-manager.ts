import crypto from "crypto";
import path from "path";
import { spawn } from "child_process";

import axios from "axios";
import { createParser } from "eventsource-parser";
import fs from "fs-extra";
import puppeteer from "puppeteer-core";

import logger from "@/lib/logger.ts";
import util from "@/lib/util.ts";
import type {
  Account,
  BrowserCookieSnapshot,
  BrowserFingerprintSnapshot,
  BrowserStorageSnapshot,
  Settings,
} from "@/lib/account-manager.ts";

const DEFAULT_TARGET_URL = "https://www.doubao.com/chat/";
const DEFAULT_STAY_MS = 5000;

interface CaptureOptions {
  headless?: boolean;
  probeUpstream?: boolean;
  targetUrl?: string;
  stayMs?: number;
}

interface SnapshotResult {
  browserPath: string;
  browserUserDataDir: string;
  browserFingerprint: BrowserFingerprintSnapshot;
  browserCookies: BrowserCookieSnapshot[];
  browserStorageState: BrowserStorageSnapshot;
  probeResult: Record<string, any>;
  webId: string;
  deviceId: string;
  token: string;
}

class BrowserProfileManager {
  public async openProfile(account: Account, settings: Settings) {
    this.assertInteractiveBrowserSupported();
    const browserPath = this.resolveExecutablePath(
      account.browserExecutablePath || settings.browserExecutablePath || ""
    );
    const userDataDir = this.resolveUserDataDir(account);
    await fs.ensureDir(userDataDir);

    const args = [
      ...this.buildBrowserArgs(account, userDataDir),
      "--new-window",
      DEFAULT_TARGET_URL,
    ];

    const child = spawn(browserPath, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
      cwd: path.dirname(browserPath),
    });

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", (error) => reject(error));
    });

    child.unref();

    logger.info(`[BrowserProfileManager] 已打开浏览器档案: ${account.name} -> ${userDataDir}`);

    return {
      browserPath,
      browserUserDataDir: userDataDir,
      pid: child.pid || 0,
      targetUrl: DEFAULT_TARGET_URL,
    };
  }

  public async captureProfileSnapshot(
    account: Account,
    settings: Settings,
    options: CaptureOptions = {}
  ): Promise<SnapshotResult> {
    const browserPath = this.resolveExecutablePath(
      account.browserExecutablePath || settings.browserExecutablePath || ""
    );
    const userDataDir = this.resolveUserDataDir(account);
    await fs.ensureDir(userDataDir);

    const browser = await puppeteer.launch({
      executablePath: browserPath,
      headless: options.headless !== false,
      userDataDir,
      ignoreDefaultArgs: ["--enable-automation"],
      defaultViewport: options.headless === false ? null : undefined,
      args: this.buildBrowserArgs(account, userDataDir),
    });

    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(45000);
      page.setDefaultNavigationTimeout(45000);

      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, "webdriver", {
          get: () => undefined,
        });

        Object.defineProperty(navigator, "languages", {
          get: () => ["zh-CN", "zh", "en-US", "en"],
        });

        Object.defineProperty(navigator, "plugins", {
          get: () => [
            { name: "Chrome PDF Plugin" },
            { name: "Chrome PDF Viewer" },
            { name: "Native Client" },
          ],
        });

        if (!(window as any).chrome) {
          Object.defineProperty(window, "chrome", {
            value: { runtime: {} },
            configurable: true,
          });
        }
      });

      const targetUrl = options.targetUrl || DEFAULT_TARGET_URL;
      const response = await page.goto(targetUrl, {
        waitUntil: options.probeUpstream ? "load" : "domcontentloaded",
        timeout: 45000,
      });

      const stayMs = options.stayMs ?? (options.probeUpstream ? 30000 : DEFAULT_STAY_MS);
      await new Promise((resolve) => setTimeout(resolve, stayMs));

      const cookies = await page.cookies();
      const storageState = await page.evaluate(() => ({
        localStorage: { ...localStorage },
        sessionStorage: { ...sessionStorage },
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        userAgentData: (navigator as any).userAgentData
          ? {
              brands: (navigator as any).userAgentData.brands,
              mobile: (navigator as any).userAgentData.mobile,
              platform: (navigator as any).userAgentData.platform,
            }
          : null,
        webdriver: navigator.webdriver,
        language: navigator.language,
        languages: navigator.languages,
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemory: (navigator as any).deviceMemory ?? null,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        plugins: Array.from(navigator.plugins || []).map((plugin) => plugin.name),
        outerWidth: window.outerWidth,
        outerHeight: window.outerHeight,
        screenWidth: window.screen.width,
        screenHeight: window.screen.height,
        webRtcSupported: typeof (window as any).RTCPeerConnection !== "undefined",
        audioSupported:
          typeof (window as any).AudioContext !== "undefined" ||
          typeof (window as any).webkitAudioContext !== "undefined",
        fontsSupported: Boolean((document as any).fonts),
        clientRectsSupported:
          typeof document.createRange().getBoundingClientRect === "function",
        canvas2dSupported: (() => {
          const canvas = document.createElement("canvas");
          return Boolean(canvas.getContext("2d"));
        })(),
        webglInfo: (() => {
          const canvas = document.createElement("canvas");
          const gl =
            canvas.getContext("webgl") ||
            canvas.getContext("experimental-webgl");
          if (!gl) {
            return {
              supported: false,
              vendor: "",
              renderer: "",
            };
          }
          const extension = gl.getExtension("WEBGL_debug_renderer_info");
          const vendor = extension
            ? gl.getParameter(extension.UNMASKED_VENDOR_WEBGL)
            : "";
          const renderer = extension
            ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL)
            : "";
          return {
            supported: true,
            vendor,
            renderer,
          };
        })(),
      }));

      const localStorageState = storageState.localStorage || {};
      const webState = this.safeJsonParse(localStorageState.samantha_web_web_id || "{}", {});
      const webId =
        webState.web_id ||
        localStorageState.flow_tea_user_id ||
        account.webId ||
        "";
      const deviceId =
        webState.user_unique_id ||
        webState.device_id ||
        account.deviceId ||
        "";
      const token =
        cookies.find((cookie) => cookie.name === "sessionid")?.value ||
        cookies.find((cookie) => cookie.name === "sessionid_ss")?.value ||
        account.token ||
        "";
      const browserCookies = cookies.map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        expires: cookie.expires,
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
        sameSite: cookie.sameSite,
      }));

      const browserStorageState: BrowserStorageSnapshot = {
        localStorage: localStorageState,
        sessionStorage: storageState.sessionStorage || {},
      };

      const browserFingerprint: BrowserFingerprintSnapshot = {
        userAgent: {
          value: storageState.userAgent,
          platform: storageState.platform,
          userAgentData: storageState.userAgentData,
        },
        operatingSystem: {
          platform: storageState.platform,
        },
        audioFingerprint: {
          supported: storageState.audioSupported,
        },
        plugins: {
          supported: true,
          list: storageState.plugins,
        },
        cpuCores: {
          value: storageState.hardwareConcurrency ?? null,
        },
        memory: {
          value: storageState.deviceMemory,
        },
        webglImage: {
          supported: storageState.webglInfo?.supported || false,
        },
        webglMetadata: {
          supported: storageState.webglInfo?.supported || false,
          vendor: storageState.webglInfo?.vendor || "",
          renderer: storageState.webglInfo?.renderer || "",
        },
        fonts: {
          supported: storageState.fontsSupported,
        },
        canvasImage: {
          supported: storageState.canvas2dSupported,
        },
        canvasText: {
          supported: storageState.canvas2dSupported,
        },
        clientRects: {
          supported: storageState.clientRectsSupported,
        },
        webRtc: {
          supported: storageState.webRtcSupported,
        },
        languageSupport: {
          language: storageState.language,
          languages: storageState.languages,
        },
        timezoneSupport: {
          timezone: storageState.timezone,
        },
        automation: {
          webdriver: storageState.webdriver ?? null,
        },
        window: {
          viewport: {
            width: storageState.outerWidth,
            height: storageState.outerHeight,
          },
          screen: {
            width: storageState.screenWidth,
            height: storageState.screenHeight,
          },
        },
        navigation: response
          ? {
              ok: response.ok(),
              status: response.status(),
              url: response.url(),
            }
          : null,
      };

      const probeResult = options.probeUpstream
        ? await this.probeChatHealth(token, storageState.userAgent, webId, deviceId)
        : this.buildLocalProbeResult(browserCookies, browserStorageState, webId, token);

      return {
        browserPath,
        browserUserDataDir: userDataDir,
        browserFingerprint,
        browserCookies,
        browserStorageState,
        probeResult,
        webId,
        deviceId,
        token,
      };
    } finally {
      if (browser.connected) {
        await browser.close();
      }
    }
  }

  public getStoredFingerprintDetails(account: Account) {
    const sessionIdCookie = (account.browserCookies || []).find(
      (cookie) => cookie.name === "sessionid"
    );

    return {
      browserProfileId: account.browserProfileId || "",
      browserFingerprintSeed: this.getFingerprintSeed(account),
      browserUserDataDir: this.resolveUserDataDir(account),
      browserExecutablePath: account.browserExecutablePath || "",
      browserType: account.browserType || "chromium",
      sessionid: sessionIdCookie
        ? this.maskValue(sessionIdCookie.value)
        : this.maskValue(account.token || ""),
      fingerprintSupport: this.formatFingerprintSupport(account.browserFingerprint || {}),
      lastSyncAt: account.lastSyncAt || 0,
      lastProbeAt: account.lastProbeAt || 0,
      lastProbeResult: account.lastProbeResult || null,
      lastProbeError: account.lastProbeError || "",
    };
  }

  public async deleteProfileDirectory(account: Account) {
    const userDataDir = this.resolveUserDataDir(account);
    const allowedBases = [
      this.getManagedProfileBaseDir(),
      this.getLegacyManagedProfileBaseDir(),
    ].map((item) => path.resolve(item).toLowerCase());
    const normalizedDir = path.resolve(userDataDir).toLowerCase();
    const isManagedDir = allowedBases.some((normalizedBase) =>
      normalizedDir === normalizedBase ||
      normalizedDir.startsWith(`${normalizedBase}${path.sep.toLowerCase()}`)
    );

    if (!isManagedDir) {
      logger.warn(`[BrowserProfileManager] 跳过删除自定义目录: ${userDataDir}`);
      return { deleted: false, browserUserDataDir: userDataDir };
    }

    await fs.remove(userDataDir);
    return { deleted: true, browserUserDataDir: userDataDir };
  }

  public resolveUserDataDir(account: Account) {
    const configuredDir = (account.browserUserDataDir || "").trim();
    if (configuredDir) {
      const resolvedConfiguredDir = path.resolve(configuredDir);
      if (this.isLegacyManagedProfilePath(resolvedConfiguredDir)) {
        return path.join(
          this.getManagedProfileBaseDir(),
          account.browserProfileId || account.id
        );
      }
      return resolvedConfiguredDir;
    }

    return path.join(
      this.getManagedProfileBaseDir(),
      account.browserProfileId || account.id
    );
  }

  private resolveExecutablePath(browserPath: string) {
    const trimmedPath = (browserPath || "").trim();

    if (trimmedPath) {
      const resolved = path.resolve(trimmedPath);
      if (fs.existsSync(resolved)) {
        const stat = fs.statSync(resolved);
        if (stat.isFile()) {
          return resolved;
        }
        if (stat.isDirectory()) {
          const found = this.findExecutableInDirectory(resolved);
          if (found) {
            return found;
          }
        }
      }
    }

    const envPath = (process.env.FINGERPRINT_CHROMIUM_PATH || "").trim();
    if (envPath && fs.existsSync(path.resolve(envPath))) {
      return path.resolve(envPath);
    }

    const bundledExecutable = this.findBundledExecutable();
    if (bundledExecutable) {
      return bundledExecutable;
    }

    throw new Error(
      "未找到 fingerprint-chromium 可执行文件，请先配置浏览器路径，或确认 `.cache/fingerprint-chromium/**/chrome`、`.cache/fingerprint-chromium/**/ungoogled-chromium`、`.cache/fingerprint-chromium/**/chrome.exe` 已存在。"
    );
  }

  private safeJsonParse(value: string, fallback: any = {}) {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }

  private async probeChatHealth(
    sessionToken: string,
    userAgent: string,
    webId: string,
    deviceId: string
  ) {
    const requestId = util.uuid();
    const query = new URLSearchParams({
      aid: "497858",
      device_id: deviceId || webId || "0",
      device_platform: "web",
      language: "zh",
      pc_version: "2.44.0",
      pkg_type: "release_version",
      real_aid: "497858",
      region: "CN",
      samantha_web: "1",
      sys_region: "CN",
      tea_uuid: webId || deviceId || "0",
      "use-olympus-account": "1",
      version_code: "20800",
      web_id: webId || deviceId || "0",
      web_tab_id: util.uuid(),
    });

    const response = await axios.post(
      `https://www.doubao.com/samantha/chat/completion?${query.toString()}`,
      {
        messages: [
          {
            content: JSON.stringify({ text: "只回复 1" }),
            content_type: 2001,
            attachments: [],
            references: [],
          },
        ],
        completion_option: {
          is_regen: false,
          with_suggest: false,
          need_create_conversation: true,
          launch_stage: 1,
          is_replace: false,
          is_delete: false,
          message_from: 0,
          action_bar_skill_id: 0,
          use_deep_think: false,
          use_auto_cot: false,
          resend_for_regen: false,
          enable_commerce_credit: false,
          event_id: "0",
        },
        evaluate_option: { web_ab_params: "" },
        section_id: `26${util.generateRandomString({ length: 16, charset: "numeric" })}`,
        conversation_id: "0",
        local_conversation_id: `local_16${util.generateRandomString({ length: 14, charset: "numeric" })}`,
        local_message_id: requestId,
      },
      {
        headers: {
          accept: "*/*",
          origin: "https://www.doubao.com",
          referer: "https://www.doubao.com/chat/",
          "user-agent": userAgent,
          Authorization: `Bearer ${sessionToken}`,
          "agw-js-conv": "str, str",
          "x-flow-trace": `04-${util.uuid()}-${util.uuid().substring(0, 16)}-01`,
        },
        timeout: 30000,
        responseType: "stream",
        validateStatus: () => true,
      }
    );

    const result = await this.readChatProbeStream(response.status, response.data);
    return {
      ok: result.ok,
      status: response.status,
      hasAccountInfo: result.ok,
      hasWebId: Boolean(webId),
      hasSessionToken: Boolean(sessionToken),
      isLoginLikely: result.ok,
      probeCode: result.probeCode,
      responsePreview: result.responsePreview,
    };
  }

  private buildLocalProbeResult(
    browserCookies: BrowserCookieSnapshot[],
    browserStorageState: BrowserStorageSnapshot,
    webId: string,
    token: string
  ) {
    const cookieNames = browserCookies.map((cookie) => cookie.name);
    const localStorageKeys = Object.keys(browserStorageState.localStorage || {});

    return {
      ok: Boolean(token),
      hasAccountInfo: false,
      hasWebId: Boolean(webId),
      hasSessionToken: cookieNames.includes("sessionid") || cookieNames.includes("sessionid_ss"),
      isLoginLikely: Boolean(token) && (Boolean(webId) || localStorageKeys.length > 0),
      source: "local_snapshot",
    };
  }

  private async readChatProbeStream(status: number, stream: any) {
    if (status !== 200) {
      return {
        ok: false,
        probeCode: status,
        responsePreview: `HTTP ${status}`,
      };
    }

    let output = "";
    let preview = "";
    let probeCode = 0;
    let resolved = false;

    const finalize = (result: { ok: boolean; probeCode: number; responsePreview: string }) => {
      if (resolved) return result;
      resolved = true;
      try {
        if (stream && typeof stream.destroy === "function") {
          stream.destroy();
        }
      } catch {}
      return result;
    };

    return await new Promise<{ ok: boolean; probeCode: number; responsePreview: string }>(
      (resolve, reject) => {
        const timer = setTimeout(() => {
          resolve(
            finalize({
              ok: output.trim().length > 0 && probeCode !== 2001 && probeCode !== -2001,
              probeCode,
              responsePreview: (output || preview || "probe timeout").slice(0, 500),
            })
          );
        }, 15000);

        const parser = createParser((event: any) => {
          try {
            if (event.type !== "event") return;
            const raw = JSON.parse(event.data);
            if (raw.code && raw.code !== 0) {
              probeCode = Number(raw.code) || raw.code;
              clearTimeout(timer);
              resolve(
                finalize({
                  ok: probeCode !== 2001 && probeCode !== -2001 && output.trim().length > 0,
                  probeCode,
                  responsePreview: JSON.stringify(raw).slice(0, 500),
                })
              );
              return;
            }
            if (raw.event_type !== 2001) return;
            const payload = JSON.parse(raw.event_data || "{}");
            const text = this.extractProbeText(payload?.message?.content);
            if (text) {
              output += text;
              clearTimeout(timer);
              resolve(
                finalize({
                  ok: probeCode !== 2001 && probeCode !== -2001,
                  probeCode,
                  responsePreview: output.slice(0, 500),
                })
              );
            }
          } catch (error) {
            clearTimeout(timer);
            reject(error);
          }
        });

        stream.on("data", (chunk: Buffer | string) => {
          const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
          if (!preview) {
            preview = text.slice(0, 500);
          }
          parser.feed(text);
        });

        stream.once("error", (error: Error) => {
          clearTimeout(timer);
          reject(error);
        });

        stream.once("end", () => {
          clearTimeout(timer);
          resolve(
            finalize({
              ok: output.trim().length > 0 && probeCode !== 2001 && probeCode !== -2001,
              probeCode,
              responsePreview: (output || preview || "empty stream").slice(0, 500),
            })
          );
        });
      }
    );
  }

  private extractProbeText(content: any) {
    if (!content) return "";
    if (typeof content !== "string") return "";
    try {
      const parsed = JSON.parse(content);
      if (typeof parsed === "string") return parsed;
      if (typeof parsed.text === "string") return parsed.text;
      if (parsed.delta && typeof parsed.delta.text === "string") return parsed.delta.text;
      if (typeof parsed.content === "string") return parsed.content;
    } catch {
      return content;
    }
    return "";
  }

  private findBundledExecutable() {
    return this.findExecutableInDirectory(
      path.resolve(process.cwd(), ".cache", "fingerprint-chromium")
    );
  }

  private findExecutableInDirectory(rootDir: string, maxDepth = 5, depth = 0): string | null {
    if (!fs.existsSync(rootDir) || depth > maxDepth) return null;

    const entries = fs.readdirSync(rootDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(rootDir, entry.name);
      if (
        entry.isFile() &&
        /^(chrome(\.exe)?|ungoogled-chromium)$/i.test(entry.name)
      ) {
        return fullPath;
      }
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const fullPath = path.join(rootDir, entry.name);
      const nested = this.findExecutableInDirectory(fullPath, maxDepth, depth + 1);
      if (nested) {
        return nested;
      }
    }

    return null;
  }

  private maskValue(value?: string) {
    if (!value) return "";
    if (value.length <= 10) return value;
    return `${value.slice(0, 4)}...${value.slice(-4)}`;
  }

  private formatFingerprintSupport(raw: BrowserFingerprintSnapshot) {
    const normalized = {
      userAgent: raw.userAgent || {
        value: "",
        platform: "",
        userAgentData: null,
      },
      operatingSystem: raw.operatingSystem || {
        platform: "",
      },
      audioFingerprint: raw.audioFingerprint || {
        supported: false,
      },
      plugins: raw.plugins || {
        supported: false,
        list: [],
      },
      cpuCores: raw.cpuCores || {
        value: null,
      },
      memory: raw.memory || {
        value: null,
      },
      webglImage: raw.webglImage || {
        supported: false,
      },
      webglMetadata: raw.webglMetadata || {
        supported: false,
        vendor: "",
        renderer: "",
      },
      fonts: raw.fonts || {
        supported: false,
      },
      canvasImage: raw.canvasImage || {
        supported: false,
      },
      canvasText: raw.canvasText || {
        supported: false,
      },
      clientRects: raw.clientRects || {
        supported: false,
      },
      webRtc: raw.webRtc || {
        supported: false,
      },
      languageSupport: raw.languageSupport || {
        language: "",
        languages: [],
      },
      timezoneSupport: raw.timezoneSupport || {
        timezone: "",
      },
    };

    return [
      { key: "userAgent", zh: "User-Agent", en: "User-Agent", value: normalized.userAgent },
      { key: "operatingSystem", zh: "操作系统", en: "Operating System", value: normalized.operatingSystem },
      { key: "audioFingerprint", zh: "音频指纹", en: "Audio Fingerprint", value: normalized.audioFingerprint },
      { key: "plugins", zh: "插件", en: "Plugins", value: normalized.plugins },
      { key: "cpuCores", zh: "CPU 核心数", en: "CPU Cores", value: normalized.cpuCores },
      { key: "memory", zh: "内存", en: "Memory", value: normalized.memory },
      { key: "webglImage", zh: "WebGL 图像", en: "WebGL Image", value: normalized.webglImage },
      { key: "webglMetadata", zh: "WebGL 元数据", en: "WebGL Metadata", value: normalized.webglMetadata },
      { key: "fonts", zh: "字体", en: "Fonts", value: normalized.fonts },
      { key: "canvasImage", zh: "Canvas 图像", en: "Canvas Image", value: normalized.canvasImage },
      { key: "canvasText", zh: "Canvas 文本", en: "Canvas Text", value: normalized.canvasText },
      { key: "clientRects", zh: "ClientRects", en: "ClientRects", value: normalized.clientRects },
      { key: "webRtc", zh: "WebRTC", en: "WebRTC", value: normalized.webRtc },
      { key: "languageSupport", zh: "语言支持", en: "Language Support", value: normalized.languageSupport },
      { key: "timezoneSupport", zh: "时区支持", en: "Timezone Support", value: normalized.timezoneSupport },
    ];
  }

  private buildFingerprintArgs(account: Account) {
    const seed = this.getFingerprintSeed(account);
    return seed ? [`--fingerprint=${seed}`] : [];
  }

  private buildBrowserArgs(account: Account, userDataDir: string) {
    return [
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-sync",
      "--disable-blink-features=AutomationControlled",
      "--start-maximized",
      ...this.buildSandboxArgs(),
      ...this.buildFingerprintArgs(account),
    ];
  }

  private buildSandboxArgs() {
    if (process.platform === "win32") {
      return [];
    }

    if (typeof process.getuid === "function" && process.getuid() === 0) {
      return ["--no-sandbox", "--disable-setuid-sandbox"];
    }

    return [];
  }

  private assertInteractiveBrowserSupported() {
    if (process.platform === "win32") {
      return;
    }

    if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
      return;
    }

    throw new Error(
      "当前运行环境没有图形显示会话，无法弹出可视浏览器窗口。Docker/服务器环境请改用宿主机直接运行服务，或为容器配置 X11/VNC/noVNC。"
    );
  }

  private getManagedProfileBaseDir() {
    return path.resolve(process.cwd(), "data", "browser-profiles");
  }

  private getLegacyManagedProfileBaseDir() {
    return path.resolve(process.cwd(), ".cache", "fingerprint-chromium", "profiles");
  }

  private isLegacyManagedProfilePath(targetPath: string) {
    const normalizedPath = path.resolve(targetPath).toLowerCase();
    const normalizedBase = this.getLegacyManagedProfileBaseDir().toLowerCase();
    return (
      normalizedPath === normalizedBase ||
      normalizedPath.startsWith(`${normalizedBase}${path.sep.toLowerCase()}`)
    );
  }

  private getFingerprintSeed(account: Account) {
    if (account.browserFingerprintSeed && String(account.browserFingerprintSeed).trim()) {
      return String(account.browserFingerprintSeed).trim();
    }
    const source = account.browserProfileId || account.id || "fingerprint-chromium";
    const hex = crypto.createHash("md5").update(source).digest("hex").slice(0, 8);
    const seed = parseInt(hex, 16);
    return `${Math.max(100000, seed)}`;
  }
}

export default new BrowserProfileManager();
