import crypto from "crypto";
import path from "path";
import { execFile, spawn } from "child_process";

import axios from "axios";
import { createParser } from "eventsource-parser";
import fs from "fs-extra";
import puppeteer from "puppeteer-core";

import chat from "@/api/controllers/chat.ts";
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
const DEFAULT_PROBE_STAY_MS = 8000;
const STORED_BROWSER_COOKIE_NAMES = new Set([
  "sessionid",
  "sessionid_ss",
  "sid_tt",
  "sid_guard",
  "uid_tt",
  "uid_tt_ss",
  "ttwid",
]);
const STORED_LOCAL_STORAGE_KEYS = [
  "samantha_web_web_id",
  "flow_tea_user_id",
];
const STORED_SESSION_STORAGE_KEYS: string[] = [];
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
  userId: string;
  token: string;
}

interface WarmupResult {
  browserPath: string;
  browserUserDataDir: string;
  targetUrl: string;
  browserCookies: BrowserCookieSnapshot[];
  browserStorageState: BrowserStorageSnapshot;
  probeResult: Record<string, any>;
  webId: string;
  deviceId: string;
  userId: string;
  token: string;
}

class BrowserProfileManager {
  public async openProfile(account: Account, settings: Settings) {
    this.assertBrowserProfileSupported();
    const browserPath = this.resolveExecutablePath(
      account.browserExecutablePath || settings.browserExecutablePath || ""
    );
    const userDataDir = this.resolveUserDataDir(account);
    await fs.ensureDir(userDataDir);

    const targetUrl = (account.targetUrl || "").trim() || DEFAULT_TARGET_URL;
    const args = [
      ...this.buildBrowserArgs(account, userDataDir),
      "--new-window",
      targetUrl,
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

    logger.info(`[BrowserProfileManager] 已打开浏览器档案: ${account.name} -> ${userDataDir} (${targetUrl})`);

    return {
      browserPath,
      browserUserDataDir: userDataDir,
      pid: child.pid || 0,
      targetUrl,
    };
  }

  public async captureProfileSnapshot(
    account: Account,
    settings: Settings,
    options: CaptureOptions = {}
  ): Promise<SnapshotResult> {
    this.assertBrowserProfileSupported();

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
    const browserProcess = browser.process();
    let page: puppeteer.Page | null = null;

    try {
      page = await browser.newPage();
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

      const targetUrl = options.targetUrl || (account.targetUrl || "").trim() || DEFAULT_TARGET_URL;
      const response = await this.gotoBestEffort(page, targetUrl);

      const stayMs = options.stayMs ?? DEFAULT_STAY_MS;
      await new Promise((resolve) => setTimeout(resolve, stayMs));

      const cookies = await page.cookies();
      const storageState = await page.evaluate(
        (storageKeys) => {
          const pickStorage = (storage: Storage, keys: string[]) => {
            const picked: Record<string, string> = {};
            for (const key of keys) {
              const value = storage.getItem(key);
              if (value !== null) picked[key] = value;
            }
            return picked;
          };

          return {
        localStorage: pickStorage(localStorage, storageKeys.local),
        sessionStorage: pickStorage(sessionStorage, storageKeys.session),
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
          const gl = (canvas.getContext("webgl") ||
            canvas.getContext(
              "experimental-webgl"
            )) as WebGLRenderingContext | null;
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
          };
        },
        {
          local: STORED_LOCAL_STORAGE_KEYS,
          session: STORED_SESSION_STORAGE_KEYS,
        }
      );

      const localStorageState = (storageState.localStorage || {}) as Record<string, string>;
      const webState = this.safeJsonParse(
        localStorageState.samantha_web_web_id || "{}",
        {}
      ) as Record<string, any>;
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
      const userId =
        cookies.find((cookie) => cookie.name === "uid_tt")?.value ||
        cookies.find((cookie) => cookie.name === "uid_tt_ss")?.value ||
        account.userId ||
        "";
      const token =
        cookies.find((cookie) => cookie.name === "sessionid")?.value ||
        cookies.find((cookie) => cookie.name === "sessionid_ss")?.value ||
        account.token ||
        "";
      const browserCookies = this.toStoredCookieSnapshots(cookies);

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

      const probeResult = this.buildLocalProbeResult(
        browserCookies,
        browserStorageState,
        webId,
        token
      );

      return {
        browserPath,
        browserUserDataDir: userDataDir,
        browserFingerprint,
        browserCookies,
        browserStorageState,
        probeResult,
        webId,
        deviceId,
        userId,
        token,
      };
    } finally {
      await this.closeBrowser(page, browser, browserProcess, userDataDir);
    }
  }

  public async warmupProfile(
    account: Account,
    settings: Settings,
    options: { headless?: boolean; targetUrl?: string; stayMs?: number } = {}
  ): Promise<WarmupResult> {
    this.assertBrowserProfileSupported();

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
    const browserProcess = browser.process();
    let page: puppeteer.Page | null = null;

    try {
      page = await browser.newPage();
      page.setDefaultTimeout(45000);
      page.setDefaultNavigationTimeout(45000);

      const targetUrl = options.targetUrl || (account.targetUrl || "").trim() || DEFAULT_TARGET_URL;
      await this.gotoBestEffort(page, targetUrl);

      const stayMs = options.stayMs ?? DEFAULT_PROBE_STAY_MS;
      await new Promise((resolve) => setTimeout(resolve, stayMs));
      const authState = await this.captureMinimalAuthState(page, account);

      return {
        browserPath,
        browserUserDataDir: userDataDir,
        targetUrl,
        ...authState,
      };
    } finally {
      await this.closeBrowser(page, browser, browserProcess, userDataDir);
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
      webId: account.webId || "",
      deviceId: account.deviceId || "",
      userId: account.userId || "",
      sessionid: sessionIdCookie?.value || account.token || "",
      cookieSummaries: {
        ttwid: this.maskValue(this.getCookieValue(account, ["ttwid"])),
        sidGuard: this.maskValue(this.getCookieValue(account, ["sid_guard"])),
        uidTt: this.maskValue(this.getCookieValue(account, ["uid_tt"])),
      },
      localStorageKeys: Object.keys(account.browserStorageState?.localStorage || {}),
      sessionStorageKeys: Object.keys(account.browserStorageState?.sessionStorage || {}),
      fingerprintSupport: this.formatFingerprintSupport(account.browserFingerprint || {}),
      lastSyncAt: account.lastSyncAt || 0,
      lastProbeAt: account.lastProbeAt || 0,
      lastProbeResult: account.lastProbeResult || null,
      lastProbeError: account.lastProbeError || "",
    };
  }

  public async probeAccountViaApi(account: Account) {
    const sessionToken = account.token || "";
    if (!sessionToken) {
      return {
        ok: false,
        status: 0,
        hasAccountInfo: false,
        hasWebId: Boolean(account.webId),
        hasSessionToken: false,
        isLoginLikely: false,
        probeCode: 0,
        responseSummary: "sessionid 缺失",
        responsePreview: "missing sessionid",
      };
    }

    const targetUrl = (account.targetUrl || "").toLowerCase();
    const name = (account.name || "").toLowerCase();
    const isMiaoxiang = targetUrl.includes("music.douyin.com") || targetUrl.includes("miaoxiang") || name.includes("妙响") || name.includes("音乐");
    const isJimeng = targetUrl.includes("jimeng") || targetUrl.includes("jianying") || name.includes("即梦");

    if (isJimeng) {
      try {
        const { getTokenLiveStatus } = await import("@/jimeng/controllers/core.ts");
        const isLive = await getTokenLiveStatus(sessionToken);
        return {
          ok: isLive,
          status: isLive ? 200 : 401,
          hasAccountInfo: true,
          hasWebId: Boolean(account.webId),
          hasSessionToken: true,
          isLoginLikely: isLive,
          probeCode: isLive ? 0 : "JIMENG_SESSION_EXPIRED",
          responseSummary: isLive ? "即梦 Cookie 探活正常" : "即梦 Cookie 已失效",
          responsePreview: isLive ? "即梦探活成功" : "sessionid expired",
        };
      } catch (err: any) {
        return {
          ok: false,
          status: 0,
          hasAccountInfo: false,
          hasWebId: Boolean(account.webId),
          hasSessionToken: true,
          isLoginLikely: false,
          probeCode: "JIMENG_PROBE_FAILED",
          responseSummary: `即梦探活异常: ${err.message || String(err)}`,
          responsePreview: err.message || String(err),
        };
      }
    }

    if (isMiaoxiang) {
      try {
        const res = await axios.get("https://music.douyin.com/studio/", {
          headers: {
            "Cookie": `sessionid=${sessionToken}`,
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
          },
          timeout: 10000,
          validateStatus: () => true
        });
        const isLive = res.status === 200;
        return {
          ok: isLive,
          status: res.status,
          hasAccountInfo: true,
          hasWebId: Boolean(account.webId),
          hasSessionToken: true,
          isLoginLikely: isLive,
          probeCode: isLive ? 0 : "MIAOXIANG_SESSION_EXPIRED",
          responseSummary: isLive ? "抖音妙响 Cookie 探活正常" : `妙响 Cookie 探测失败 (HTTP ${res.status})`,
          responsePreview: `HTTP ${res.status}`,
        };
      } catch (err: any) {
        return {
          ok: false,
          status: 0,
          hasAccountInfo: false,
          hasWebId: Boolean(account.webId),
          hasSessionToken: true,
          isLoginLikely: false,
          probeCode: "MIAOXIANG_PROBE_FAILED",
          responseSummary: `妙响探活失败: ${err.message || String(err)}`,
          responsePreview: err.message || String(err),
        };
      }
    }

    try {
      const result = await chat.probeCompletion(
        {
          token: sessionToken,
          webId: account.webId || "",
          deviceId: account.deviceId || "",
          userId: account.userId || "",
        },
        "doubao"
      );
      const content = result?.choices?.[0]?.message?.content;
      return {
        ok: true,
        status: 200,
        hasAccountInfo: true,
        hasWebId: Boolean(account.webId),
        hasSessionToken: true,
        isLoginLikely: true,
        probeCode: 0,
        responseSummary: "豆包 chat 探活正常",
        responsePreview:
          typeof content === "string" && content.trim()
            ? content.slice(0, 500)
            : "chat ok",
      };
    } catch (err: any) {
      const message = (err?.message || String(err) || "chat request failed").slice(0, 500);
      return {
        ok: false,
        status: 0,
        hasAccountInfo: false,
        hasWebId: Boolean(account.webId),
        hasSessionToken: true,
        isLoginLikely: false,
        probeCode: "CHAT_REQUEST_FAILED",
        responseSummary: `豆包 chat 探活失败: ${message.slice(0, 120)}`,
        responsePreview: message,
      };
    }
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
      "未找到 fingerprint-chromium 可执行文件，请先运行 `start-windows-5566.bat` 自动下载，或在后台系统设置里配置 Windows 版 chrome.exe 路径。"
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
    authContext: {
      token: string;
      webId?: string;
      deviceId?: string;
      userId?: string;
    },
    userAgent = "",
    webId = "",
    deviceId = ""
  ) {
    const sessionToken = authContext?.token || "";
    if (!sessionToken) {
      return {
        ok: false,
        status: 0,
        hasAccountInfo: false,
        hasWebId: Boolean(webId),
        hasSessionToken: false,
        isLoginLikely: false,
        probeCode: 0,
        responseSummary: "sessionid 缺失",
        responsePreview: "missing sessionid",
      };
    }

    try {
      const result = await chat.createCompletion(
        [{ role: "user", content: "1" }],
        {
          token: sessionToken,
          webId: authContext.webId || webId || "",
          deviceId: authContext.deviceId || deviceId || "",
          userId: authContext.userId || "",
        },
        undefined,
        "",
        0,
        undefined,
        true,
        "doubao"
      );
      const content = result?.choices?.[0]?.message?.content;
      return {
        ok: true,
        status: 200,
        hasAccountInfo: true,
        hasWebId: false,
        hasSessionToken: true,
        isLoginLikely: true,
        probeCode: 0,
        responseSummary: "chat 正常",
        responsePreview:
          typeof content === "string" && content.trim()
            ? content.slice(0, 500)
            : "chat ok",
      };
    } catch (err: any) {
      const message = (err?.message || String(err) || "chat request failed").slice(0, 500);
      return {
        ok: false,
        status: 0,
        hasAccountInfo: false,
        hasWebId: false,
        hasSessionToken: true,
        isLoginLikely: false,
        probeCode: "CHAT_REQUEST_FAILED",
        responseSummary: `chat 请求失败: ${message.slice(0, 120)}`,
        responsePreview: message,
      };
    }

    const resolvedWebId =
      webId || `7${util.generateRandomString({ length: 18, charset: "numeric" })}`;
    const resolvedDeviceId =
      deviceId || `7${util.generateRandomString({ length: 18, charset: "numeric" })}`;

    const requestId = util.uuid();
    const query = new URLSearchParams({
      aid: "497858",
      device_id: resolvedDeviceId,
      device_platform: "web",
      language: "zh",
      pc_version: "2.44.0",
      pkg_type: "release_version",
      real_aid: "497858",
      region: "CN",
      samantha_web: "1",
      sys_region: "CN",
      tea_uuid: resolvedWebId,
      "use-olympus-account": "1",
      version_code: "20800",
      web_id: resolvedWebId,
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
      responseSummary: this.buildProbeSummary(
        result.ok,
        response.status,
        result.probeCode
      ),
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

  private async captureMinimalAuthState(page: puppeteer.Page, account: Account) {
    const cookies = await page.cookies();
    const browserCookies = this.toStoredCookieSnapshots(cookies);
    const browserStorageState = await page.evaluate(
      (storageKeys) => {
        const pickStorage = (storage: Storage, keys: string[]) => {
          const picked: Record<string, string> = {};
          for (const key of keys) {
            const value = storage.getItem(key);
            if (value !== null) picked[key] = value;
          }
          return picked;
        };

        return {
          localStorage: pickStorage(localStorage, storageKeys.local),
          sessionStorage: pickStorage(sessionStorage, storageKeys.session),
        };
      },
      {
        local: STORED_LOCAL_STORAGE_KEYS,
        session: STORED_SESSION_STORAGE_KEYS,
      }
    ) as BrowserStorageSnapshot;

    const localStorageState = browserStorageState.localStorage || {};
    const webState = this.safeJsonParse(
      localStorageState.samantha_web_web_id || "{}",
      {}
    ) as Record<string, any>;
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
    const userId =
      cookies.find((cookie) => cookie.name === "uid_tt")?.value ||
      cookies.find((cookie) => cookie.name === "uid_tt_ss")?.value ||
      account.userId ||
      "";
    const token =
      cookies.find((cookie) => cookie.name === "sessionid")?.value ||
      cookies.find((cookie) => cookie.name === "sessionid_ss")?.value ||
      account.token ||
      "";

    return {
      browserCookies,
      browserStorageState,
      probeResult: this.buildLocalProbeResult(
        browserCookies,
        browserStorageState,
        webId,
        token
      ),
      webId,
      deviceId,
      userId,
      token,
    };
  }

  private toStoredCookieSnapshots(cookies: any[]): BrowserCookieSnapshot[] {
    return cookies
      .filter((cookie) => STORED_BROWSER_COOKIE_NAMES.has(String(cookie.name || "")))
      .map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        expires: cookie.expires,
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
        sameSite: cookie.sameSite,
      }));
  }

  private async gotoBestEffort(page: puppeteer.Page, targetUrl: string) {
    try {
      return await page.goto(targetUrl, {
        waitUntil: "domcontentloaded",
        timeout: 45000,
      });
    } catch (err: any) {
      logger.warn(
        `[BrowserProfileManager] 浏览器打开 ${targetUrl} 未完成导航，继续读取本地 session: ${err?.message || err}`
      );
      return null;
    }
  }

  private async closeBrowser(
    page: puppeteer.Page | null,
    browser: puppeteer.Browser,
    browserProcess: ReturnType<puppeteer.Browser["process"]>,
    userDataDir?: string
  ) {
    try {
      if (page && !page.isClosed()) {
        await page.close();
      }
    } catch {}
    try {
      if (browser.connected) {
        await browser.close();
      }
    } catch {}

    if (!browserProcess) return;
    await this.waitForProcessExit(browserProcess, 2000);
    if (browserProcess.exitCode === null && browserProcess.signalCode === null) {
      await this.killProcessTree(browserProcess);
    }
    await this.killProcessesByUserDataDir(userDataDir, browserProcess.pid || undefined);
  }

  private waitForProcessExit(processRef: any, timeoutMs: number) {
    if (!processRef || processRef.exitCode !== null || processRef.signalCode !== null) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      processRef.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private async killProcessTree(processRef: any) {
    if (!processRef?.pid) return;
    if (process.platform !== "win32") {
      try {
        processRef.kill("SIGKILL");
      } catch {}
      return;
    }

    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(processRef.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.once("close", () => resolve());
      killer.once("error", () => {
        try {
          processRef.kill("SIGKILL");
        } catch {}
        resolve();
      });
    });
  }

  private async killProcessesByUserDataDir(userDataDir?: string, excludePid?: number) {
    if (process.platform !== "win32" || !userDataDir) return;

    const normalizedDir = path.resolve(userDataDir).replace(/'/g, "''");
    const command = [
      "$ErrorActionPreference='SilentlyContinue'",
      `$dir='${normalizedDir}'`,
      "$escaped=[Regex]::Escape($dir)",
      "$targets=Get-CimInstance Win32_Process | Where-Object {",
      "  $_.ProcessId -ne $PID -and",
      `  $_.ProcessId -ne ${Number(excludePid || 0)} -and`,
      "  $_.CommandLine -and",
      "  $_.CommandLine -match '--user-data-dir=' -and",
      "  $_.CommandLine -match $escaped",
      "}",
      "foreach($p in $targets){ Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }",
    ].join("; ");

    await new Promise<void>((resolve) => {
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", command],
        { windowsHide: true },
        () => resolve()
      );
    });
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
    const isSuccess = () => output.trim().length > 0 && probeCode === 0;

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
              ok: isSuccess(),
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
                  ok: false,
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
                  ok: isSuccess(),
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
              ok: isSuccess(),
              probeCode,
              responsePreview: (output || preview || "empty stream").slice(0, 500),
            })
          );
        });
      }
    );
  }

  private buildProbeSummary(ok: boolean, status: number, probeCode: number | string) {
    if (ok) return "chat 正常";
    if (status && status !== 200) return `chat 返回 HTTP ${status}`;
    if (probeCode && probeCode !== 0) return `chat 返回业务错误码: ${probeCode}`;
    return "chat 未通过";
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
      if (entry.isFile() && /^chrome\.exe$/i.test(entry.name)) {
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

  private getCookieValue(account: Account, names: string[]) {
    const lowerNames = names.map((name) => name.toLowerCase());
    const cookie = (account.browserCookies || []).find((item) =>
      lowerNames.includes(String(item.name || "").toLowerCase())
    );
    return cookie?.value || "";
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

  private assertBrowserProfileSupported() {
    if (process.platform === "win32") return;
    throw new Error(
      `当前服务进程运行在 ${process.platform} 环境，浏览器档案登录只支持宿主 Windows 桌面运行。` +
      " Docker、Linux、WSL 或服务器环境只能运行普通 API 服务，不支持浏览器档案登录/探活。"
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
