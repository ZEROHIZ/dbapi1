import fs from "fs-extra";
import path from "path";
import util from "@/lib/util.ts";
import logger from "@/lib/logger.ts";
import cron from "cron";
import axios from "axios";
import { EventEmitter } from "events";
import ResponsePolicyManager, { PolicyAction } from "./response-policy.ts";
import ModelManager from "./model-manager.ts";
import APIException from './exceptions/APIException.ts';


const DATA_DIR = path.join(process.cwd(), "data");
const ACCOUNTS_FILE = path.join(DATA_DIR, "accounts.json");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

export enum AccountStatus {
  IDLE = "idle",
  BUSY = "busy",
  COOLDOWN = "cooldown"
}

export type AccountType = "doubao" | "openai";
export type AccountCapability = "chat" | "image" | "video" | "music";
export type AccountAuthMode = "sessionid_only" | "manual_browser_login";

export interface BrowserCookieSnapshot {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

export interface BrowserStorageSnapshot {
  localStorage?: Record<string, string>;
  sessionStorage?: Record<string, string>;
}

export interface BrowserFingerprintSnapshot {
  [key: string]: any;
}


export interface Account {
  id: string;
  token: string;
  name: string;
  enabled: boolean;
  
  // 绫诲瀷涓庢潈閲?
  type: AccountType;
  weight: number;

  // 绗笁鏂?OpenAI 鍏煎 API 瀛楁
  baseUrl?: string;
  apiKey?: string;
  capability?: AccountCapability;
  modelName?: string;

  // 璁惧淇℃伅鎸囩汗
  deviceId?: string;
  webId?: string;
  userId?: string;
  authMode?: AccountAuthMode;
  browserProfileId?: string;
  browserUserDataDir?: string;
  browserExecutablePath?: string;
  browserType?: string;
  browserFingerprint?: BrowserFingerprintSnapshot;
  browserFingerprintSeed?: string;
  browserCookies?: BrowserCookieSnapshot[];
  browserStorageState?: BrowserStorageSnapshot;
  lastBrowserOpenAt?: number;
  lastSyncAt?: number;
  lastProbeAt?: number;
  lastProbeResult?: Record<string, any> | null;
  lastProbeError?: string;
  lastLoginDetectedAt?: number;
  sessionIdSource?: string;
  
  // New: 娓犻亾鏀寔鐨勬ā鍨嬪垪琛?(濡?"doubao,doubao-pro")
  models?: string; 
  // New: 妯″瀷閲嶅畾鍚戞槧灏?JSON (濡?{"doubao-image": "Seedream 4.5"})
  modelMapping?: string; 
  // New: 澶囨敞锛岀敤浜庡尯鍒嗗悓涓€娓犻亾涓嬬殑涓嶅悓 Key
  remark?: string;
  // New: 妯″瀷鍚堝苟绛栫暐
  mergePolicy?: "new" | "merge";

  // 缁熻涓庨檺鍒?
  limitChat: number;  // -1 琛ㄧず涓嶉檺
  limitImage: number;
  limitVideo: number;
  limitMusic: number;
  
  usageChat: number;
  usageImage: number;
  usageVideo: number;
  usageMusic: number;
  
  totalUsage: number; // 鎬昏皟鐢ㄦ鏁?
  
  // Token 鐢ㄩ噺缁熻
  totalPromptTokens: number;
  totalCompletionTokens: number;

  // 杩愯鏃剁姸鎬?
  status?: AccountStatus;
  lastUsed?: number;
  cooldownUntil?: number;   // 鐘舵€佺爜绛栫暐瀵艰嚧鐨勯暱鍐峰嵈
  cooldownReason?: string;
  
  // 鍋ュ悍妫€鏌?
  lastHealthCheck?: number;
  healthStatus?: "healthy" | "unhealthy";
  healthError?: string;
  skipHealthCheck?: boolean; // 鏂板锛氭槸鍚﹁烦杩囧仴搴锋鏌?

  // 鍏煎鏃у瓧娈碉紙璇诲彇鏃惰浆鎹紝淇濆瓨鏃跺簾寮冿級
  dailyLimit?: number;
  dailyUsage?: number;
}


export interface Settings {
  cooldownTime: number; // ms
  defaultModel: string;
  enableHealthCheck?: boolean;
  videoTimeout?: number;
  imageGenerationDelayMs?: number;
  browserExecutablePath?: string;
  browserProbeIntervalMinutes?: number;
  browserProbeIntervalHours?: number;
  enableKeepAlive?: boolean;
  keepAliveIntervalMinutes?: number;
}


export type RequestType = "chat" | "image" | "video" | "music";

class AccountManager extends EventEmitter {
  private accounts: Account[] = [];
  private lastRoundRobinIndex: number = -1; // 鐢ㄤ簬杞
  private settings: Settings = {
    cooldownTime: 10000,
    defaultModel: "doubao-lite-4k",
    videoTimeout: 180000,
    imageGenerationDelayMs: 3000,
    browserExecutablePath: process.env.FINGERPRINT_CHROMIUM_PATH || "",
    browserProbeIntervalMinutes: 720
  };

  
  // 闃熷垪闇€瑕佽褰曡姹傜被鍨?
  private queue: Array<{ 
      type: RequestType;
      modelId?: string;
      resolve: (account: Account) => void; 
      reject: (err: any) => void 
  }> = [];

  /**
   * 灏嗚处鍙锋敮鎸佺殑妯″瀷鍒楄〃涓庢ā鍨嬬鐞嗗櫒涓殑鎻愪緵鑰呰缃悓姝?(鍙屽悜鍚屾)
   * @param specificChannel 鍙€夛紝鍙悓姝ョ壒瀹氭笭閬?
   */
  public async syncAccountModelsWithModelProviders(specificChannel?: string) {
      const targetChannels = specificChannel ? [specificChannel] : [...new Set(this.accounts.map(a => a.name))];
      let modified = false;

      for (const channelName of targetChannels) {
          const supportedModels = ModelManager.getModelsByProvider(channelName);
          const modelsString = supportedModels.join(', ');

          this.accounts.forEach(acc => {
              if (acc.name === channelName && acc.models !== modelsString) {
                  acc.models = modelsString;
                  modified = true;
              }
          });
      }

      if (modified) {
          await this.saveAccounts();
          logger.info("[AccountManager] 已自动同步渠道支持模型列表 [" + targetChannels.join(", ") + "]");
      }
  }

  constructor() {
    super();
    this.init();
  }

  private async init() {
    await fs.ensureDir(DATA_DIR);
    await this.loadAccounts();
    await this.loadSettings();

    // 姣忓ぉ0鐐归噸缃?
    new cron.CronJob("0 0 0 * * *", () => {
      this.resetDailyUsage();
    }).start();

    // 璐﹀彿鍋ュ悍妫€鏌ワ細姣?30 鍒嗛挓涓€娆?
    new cron.CronJob('0 */30 * * * *', () => {
        if (this.settings.enableHealthCheck !== false) {
            this.checkAllAccountsHealth();
        }
    }, null, true);

    // Session 淇濇椿瀹氭椂浠诲姟
    const keepAliveInterval = this.settings.keepAliveIntervalMinutes || 5;
    const keepAliveCron = "0 */" + keepAliveInterval + " * * * *";
    new cron.CronJob(keepAliveCron, () => {
        if (this.settings.enableKeepAlive !== false) {
            this.keepAliveAllAccounts();
        }
    }, null, true);

    // 浏览器档案探活：每分钟检查一次是否到期
    new cron.CronJob("0 * * * * *", () => {
        const intervalMinutes = Number(this.settings.browserProbeIntervalMinutes || 0);
        if (intervalMinutes > 0) {
            this.probeBrowserAccountsIfDue().catch(err => {
                logger.error("[AccountManager] 浏览器档案定时探活失败:", err);
            });
        }
    }, null, true);

    logger.success("[AccountManager] 初始化完成，已启动定时任务");

    // 初始化运行时状态
    this.accounts.forEach((acc) => {
      acc.status = AccountStatus.IDLE;
    });

    const keepAliveStatus =
      this.settings.enableKeepAlive !== false
        ? "已开启（每 " + keepAliveInterval + " 分钟）"
        : "已关闭";
    logger.info(
      "[AccountManager] 系统初始化完成，已加载 " +
        this.accounts.length +
        " 个账号，Session 保活：" +
        keepAliveStatus
    );
  }

  private async loadAccounts() {
    try {
      if (await fs.pathExists(ACCOUNTS_FILE)) {
        const stored = await fs.readJson(ACCOUNTS_FILE);
        const storedAccounts = Array.isArray(stored) ? stored : (stored.accounts || []);
        this.accounts = storedAccounts.map((s: any) => ({
            ...s,
            status: AccountStatus.IDLE,
            type: s.type || "doubao",
            weight: s.weight || 1,
            baseUrl: s.baseUrl || "",
            apiKey: s.apiKey || "",
            capability: s.capability || undefined,
            modelName: s.modelName || "",
            totalPromptTokens: s.totalPromptTokens || 0,
            totalCompletionTokens: s.totalCompletionTokens || 0,
            cooldownUntil: s.cooldownUntil || 0,
            userId: s.userId || "",
            authMode: s.authMode || "sessionid_only",
            browserProfileId: s.browserProfileId || "",
            browserUserDataDir: s.browserUserDataDir || "",
            browserExecutablePath: s.browserExecutablePath || "",
            browserType: s.browserType || "chromium",
            browserFingerprint: s.browserFingerprint || undefined,
            browserFingerprintSeed: s.browserFingerprintSeed || "",
            browserCookies: Array.isArray(s.browserCookies) ? s.browserCookies : [],
            browserStorageState: s.browserStorageState || undefined,
            lastBrowserOpenAt: s.lastBrowserOpenAt || 0,
            lastSyncAt: s.lastSyncAt || 0,
            lastProbeAt: s.lastProbeAt || 0,
            lastProbeResult: s.lastProbeResult || null,
            lastProbeError: s.lastProbeError || "",
            lastLoginDetectedAt: s.lastLoginDetectedAt || 0,
            sessionIdSource: s.sessionIdSource || "",
            models: s.models || "",
            modelMapping: s.modelMapping || "",
            mergePolicy: s.mergePolicy || "merge",
            // 兼容旧数据：缺失新字段时使用默认值
            limitChat: s.limitChat !== undefined ? s.limitChat : -1,
            limitImage: s.limitImage !== undefined ? s.limitImage : 60,
            limitVideo: s.limitVideo !== undefined ? s.limitVideo : 0,
            limitMusic: s.limitMusic !== undefined ? s.limitMusic : 0,
            usageChat: s.usageChat || 0,
            usageImage: s.usageImage || 0,
            usageVideo: s.usageVideo || 0,
            usageMusic: s.usageMusic || 0,
            totalUsage: s.totalUsage || 0
        }));
      }
    } catch (e) {
      logger.error("加载账号文件失败:", e);
    }
  }

  private async saveAccounts() {
    try {
      // 浠呬繚瀛樺繀瑕佸瓧娈碉紝娓呯悊鏃у瓧娈?
      const toSave = this.accounts.map(a => ({
        id: a.id, token: a.token, name: a.name, enabled: a.enabled,
        type: a.type, weight: a.weight,
        baseUrl: a.baseUrl, apiKey: a.apiKey, capability: a.capability, modelName: a.modelName,
        models: a.models, modelMapping: a.modelMapping, mergePolicy: a.mergePolicy || "merge",
        remark: a.remark,
        deviceId: a.deviceId, webId: a.webId, userId: a.userId,
        authMode: a.authMode || "sessionid_only",
        browserProfileId: a.browserProfileId,
        browserUserDataDir: a.browserUserDataDir,
        browserExecutablePath: a.browserExecutablePath,
        browserType: a.browserType,
        browserFingerprint: a.browserFingerprint,
        browserFingerprintSeed: a.browserFingerprintSeed,
        browserCookies: a.browserCookies,
        browserStorageState: a.browserStorageState,
        lastBrowserOpenAt: a.lastBrowserOpenAt,
        lastSyncAt: a.lastSyncAt,
        lastProbeAt: a.lastProbeAt,
        lastProbeResult: a.lastProbeResult,
        lastProbeError: a.lastProbeError,
        lastLoginDetectedAt: a.lastLoginDetectedAt,
        sessionIdSource: a.sessionIdSource,
        limitChat: a.limitChat, limitImage: a.limitImage, limitVideo: a.limitVideo, limitMusic: a.limitMusic,
        usageChat: a.usageChat, usageImage: a.usageImage, usageVideo: a.usageVideo, usageMusic: a.usageMusic,
        totalUsage: a.totalUsage,
        totalPromptTokens: a.totalPromptTokens,
        totalCompletionTokens: a.totalCompletionTokens,
        cooldownUntil: a.cooldownUntil,
        cooldownReason: a.cooldownReason
      }));

      await fs.writeJson(ACCOUNTS_FILE, { accounts: toSave }, { spaces: 2 });
    } catch (e) {
      logger.error("保存账号文件失败:", e);
    }
  }

  private async loadSettings() {
    try {
      if (await fs.pathExists(SETTINGS_FILE)) {
        const loaded = await fs.readJson(SETTINGS_FILE);
        // 鍏煎鏃х殑鎴栫敱浜庤瑙ｄ骇鐢熺殑 videoPollingTimeout 瀛楁
        if (loaded.videoPollingTimeout !== undefined && loaded.videoTimeout === undefined) {
             loaded.videoTimeout = loaded.videoPollingTimeout;
        }
        if (loaded.browserProbeIntervalMinutes === undefined && loaded.browserProbeIntervalHours !== undefined) {
             loaded.browserProbeIntervalMinutes = Number(loaded.browserProbeIntervalHours) * 60;
        }
        this.settings = { ...this.settings, ...loaded };
      }
    } catch (e) {
      logger.error("加载设置失败:", e);
    }
  }

  public async saveSettings(newSettings: Partial<Settings>) {
    this.settings = { ...this.settings, ...newSettings };
    try {
      await fs.writeJson(SETTINGS_FILE, this.settings, { spaces: 2 });
    } catch (e) {
      logger.error("保存设置失败:", e);
    }
  }

  // 璁＄畻鏌愮被鏈嶅姟鎴栫壒瀹氭ā鍨嬬殑鎬诲墿浣欓搴?(濡傛灉鏄棤闄愬垯杩斿洖涓€涓瀬澶у€?
  public getTotalRemainingUsage(type: RequestType = 'chat', modelId?: string): number {
      return this.accounts
          .filter(a => {
              if (!a.enabled) return false;
              if (this.isBrowserManagedAccount(a)) return false;
              if (modelId && a.models && a.models.trim().length > 0) {
                  const supportedModels = a.models.split(/[,，]/).map(m => m.trim());
                  if (!supportedModels.includes(modelId)) return false;
              }
              if (a.type === 'openai' && a.capability && a.capability !== type) return false;
              return true;
          })
          .reduce((sum, a) => {
              if (type === 'chat') return a.limitChat === -1 ? sum + 999999 : sum + Math.max(0, a.limitChat - a.usageChat);
              if (type === 'image') return sum + Math.max(0, a.limitImage - a.usageImage);
              if (type === 'video') return sum + Math.max(0, a.limitVideo - a.usageVideo);
              if (type === 'music') return sum + Math.max(0, a.limitMusic - a.usageMusic);
              return sum;
          }, 0);
  }

  private tryGetAvailableAccount(type: RequestType, modelId?: string): Account | null {
    const total = this.accounts.length;
    if (total === 0) return null;

    const now = Date.now();
    const availableAccounts: Account[] = [];

    // 绗竴姝ワ細绛涢€夊嚭鎵€鏈夊綋鍓嶇鍚堟潯浠讹紙瀛樻椿銆佺┖闂层€佹湁棰濆害銆佸尮閰嶆ā鍨嬶級鐨勮处鍙?
    for (const a of this.accounts) {
        if (!a.enabled) continue;
        if (this.isBrowserManagedAccount(a)) continue;
        
        // 妫€鏌ョ姸鎬佺爜绛栫暐瀵艰嚧鐨勫喎鍗?        if (a.cooldownUntil && a.cooldownUntil > now) continue;

        // 妫€鏌ヨ繍琛屾椂鐘舵€?(BUSY/COOLDOWN)
        if (a.status !== AccountStatus.IDLE) continue;

        // --- 鏂版ā鍨嬭矾鐢遍€昏緫 ---
        if (modelId) {
            // 1. 濡傛灉璐﹀彿閰嶇疆浜?specific models锛屽垯蹇呴』鍖呭惈璇ユā鍨?
            if (a.models && a.models.trim().length > 0) {
                const supportedModels = a.models.split(/[,，]/).map(m => m.trim());
                if (!supportedModels.includes(modelId)) continue;
            }
        }

        // 妫€鏌ョ涓夋柟娓犻亾鍔熻兘鍖归厤
        if (a.type === 'openai') {
           if (a.capability && a.capability !== type) continue;
        }
        
        // 妫€鏌ュ搴旈搴?
        if (type === 'chat' && a.limitChat !== -1 && a.usageChat >= a.limitChat) continue;
        if (type === 'image' && a.usageImage >= a.limitImage) continue;
        if (type === 'video' && a.usageVideo >= a.limitVideo) continue;
        if (type === 'music' && a.usageMusic >= a.limitMusic) continue;
        
        availableAccounts.push(a);
    }

    if (availableAccounts.length === 0) return null;

    // 绗簩姝ワ細鎸夋潈閲嶉檷搴忔帓搴?
    availableAccounts.sort((a, b) => (b.weight || 1) - (a.weight || 1));

    // 绗笁姝ワ細鍙栧嚭鎵€鏈夋渶楂樻潈閲嶇殑璐﹀彿
    const highestWeight = availableAccounts[0].weight || 1;
    const topWeightAccounts = availableAccounts.filter(a => (a.weight || 1) === highestWeight);

    // 绗洓姝ワ細鍦ㄦ渶楂樻潈閲嶇殑璐﹀彿姹犱腑杩涜杞锛屼互鍒嗘暎璇锋眰鍘嬪姏
    // 杩欓噷鍊熺敤骞舵洿鏂?lastRoundRobinIndex 瀹炵幇绠€鍗曠殑浼疆璇㈤€夋嫨
    this.lastRoundRobinIndex = (this.lastRoundRobinIndex + 1) % topWeightAccounts.length;
    return topWeightAccounts[this.lastRoundRobinIndex];
  }


  public acquireToken(type: RequestType = 'chat', modelId?: string): Promise<Account> {
    return new Promise((resolve, reject) => {
      // 1. 妫€鏌ユ槸鍚︽湁浠讳綍璐﹀彿鏀寔璇ヨ姹?
      const existsCapable = this.accounts.some(a => {
          if (!a.enabled) return false;
          if (this.isBrowserManagedAccount(a)) return false;
          if (modelId && a.models && a.models.trim().length > 0) {
              const supportedModels = a.models.split(/[,，]/).map(m => m.trim());
              if (!supportedModels.includes(modelId)) return false;
          }
          if (a.type === 'openai' && a.capability && a.capability !== type) return false;
          return true;
      });

      if (!existsCapable) {
          return reject(
              new APIException([-403, "No active channel supports [" + type + (modelId ? ":" + modelId : "") + "]"])
          );
      }

      // 2. 妫€鏌ヨ繖浜涙敮鎸佽处鍙风殑鍓╀綑棰濆害
      const remaining = this.getTotalRemainingUsage(type, modelId);
      if (remaining <= 0) {
          return reject(
              new APIException([-403, "System quota exhausted for [" + type + (modelId ? ":" + modelId : "") + "] today"])
          );
      }

      // 3. 灏濊瘯鑾峰彇绌洪棽璐﹀彿
      const account = this.tryGetAvailableAccount(type, modelId);
      if (account) {
        this.lockAccount(account, type);
        resolve(account);
      } else {
        // 4. 杩涘叆闃熷垪 (鍙湁鍦ㄧ‘瀹炴湁棰濆害鍙槸鏆傛椂蹇欑鏃舵墠杩涘叆闃熷垪)
        this.queue.push({ type, modelId, resolve: (account: Account) => resolve(account), reject });
        logger.info("[AccountManager] 暂无可用账号，请求进入队列 [" + type + ":" + (modelId || "any") + "]，当前队列长度: " + this.queue.length);
      }
    });
  }

  private lockAccount(account: Account, type: RequestType) {
    account.status = AccountStatus.BUSY;
    account.lastUsed = Date.now();
    account.totalUsage++;
    
    if (type === 'chat') account.usageChat++;
    if (type === 'image') account.usageImage++;
    if (type === 'video') account.usageVideo++;
    if (type === 'music') account.usageMusic++;
    
    this.saveAccounts(); 
    logger.info("[AccountManager] 账号 [" + account.name + "] 已锁定（类型: " + type + "）");
  }

  public releaseToken(token: string) {
    const account = this.accounts.find(a => a.token === token);
    if (!account) return;

    account.status = AccountStatus.COOLDOWN;
    logger.info("[AccountManager] 账号 [" + account.name + "] 任务完成，进入冷却 " + (this.settings.cooldownTime / 1000) + " 秒");

    setTimeout(() => {
      account.status = AccountStatus.IDLE;
      logger.info("[AccountManager] 账号 [" + account.name + "] 冷却结束，恢复可用");
      this.processQueue();
    }, this.settings.cooldownTime);
  }

  private processQueue() {
    if (this.queue.length === 0) return;

    // 閬嶅巻闃熷垪锛屽鎵剧涓€涓兘琚弧瓒崇殑璇锋眰
    for (let i = 0; i < this.queue.length; i++) {
        const req = this.queue[i];
        const account = this.tryGetAvailableAccount(req.type, req.modelId);
        
        if (account) {
            this.queue.splice(i, 1);
            this.lockAccount(account, req.type);
            req.resolve(account);
            logger.info("[AccountManager] 队列请求 [" + req.type + "] 已分配给账号 [" + account.name + "]");
            return; 
        }
    }
  }

  public getAccountsData() {
      // Calculate remaining quota for the frontend
      return this.accounts
      .filter(a => !this.isBrowserManagedAccount(a))
      .map(a => ({
          ...a,
           remainingChat: a.limitChat === -1 ? "unlimited" : Math.max(0, a.limitChat - a.usageChat),
          remainingImage: Math.max(0, a.limitImage - a.usageImage),
          remainingVideo: Math.max(0, a.limitVideo - a.usageVideo),
          remainingMusic: Math.max(0, a.limitMusic - a.usageMusic),
          status: a.status
      }));
  }

  public getBrowserAccountsData() {
      return this.accounts
      .filter(a => this.isBrowserManagedAccount(a))
      .map(a => ({
          ...a,
          status: a.status,
          tokenSummary: this.maskValue(a.token),
      }));
  }
  
  public getSettings() {
    return this.settings;
  }

  public getStats() {
      const statsAccounts = this.accounts.filter(a => !this.isBrowserManagedAccount(a));
      const usage = statsAccounts.reduce((sums, a) => ({
          chat: sums.chat + (a.usageChat || 0),
          image: sums.image + (a.usageImage || 0),
          video: sums.video + (a.usageVideo || 0),
          music: sums.music + (a.usageMusic || 0)
      }), { chat: 0, image: 0, video: 0, music: 0 });

      return {
          totalAccounts: statsAccounts.length,
          enabledAccounts: statsAccounts.filter(a => a.enabled).length,
          statusCounts: {
              idle: statsAccounts.filter(a => a.status === AccountStatus.IDLE && a.enabled).length,
              busy: statsAccounts.filter(a => a.status === AccountStatus.BUSY).length,
              cooldown: statsAccounts.filter(a => a.status === AccountStatus.COOLDOWN).length,
          },
          queue: this.queue.length,
          totalRemainingChat: statsAccounts.reduce((sum, a) => a.limitChat === -1 ? sum + 999999 : sum + Math.max(0, a.limitChat - a.usageChat), 0),
          totalRemainingImage: statsAccounts.reduce((sum, a) => sum + Math.max(0, a.limitImage - a.usageImage), 0),
          totalRemainingVideo: statsAccounts.reduce((sum, a) => sum + Math.max(0, a.limitVideo - a.usageVideo), 0),
          totalRemainingMusic: statsAccounts.reduce((sum, a) => sum + Math.max(0, a.limitMusic - a.usageMusic), 0),
          totalTokens: statsAccounts.reduce((sum, a) => sum + (a.totalPromptTokens || 0) + (a.totalCompletionTokens || 0), 0),
          usage: usage
      };
  }

  /**
   * 灏嗚处鍙锋敮鎸佺殑妯″瀷鍚屾鍒?ModelManager
   * @param modelsStr 鏀寔妯″瀷瀛楃涓?
   * @param provider 鎻愪緵鑰呭悕绉?
   * @param mergePolicy 鍚堝苟绛栫暐: 'new' | 'merge'
   */
  private async syncModels(modelsStr: string, provider: string, mergePolicy: 'new' | 'merge' = 'merge') {
    if (!modelsStr || modelsStr.trim().length === 0) return;
    const modelIds = modelsStr.split(/[,，]/).map((m) => m.trim()).filter(m => m.length > 0);
    
    for (const id of modelIds) {
      // 妫€鏌ユ槸鍚﹀凡缁忓瓨鍦ㄥ叿鏈夌浉鍚?backendModel 鐨勬ā鍨嬶紙濡傛灉鏄?merge 妯″紡锛?
      let targetModelId = id;
      if (mergePolicy === 'merge') {
          const existing = ModelManager.getAllModels().find(m => m.backendModel === id || m.id === id);
          if (existing) {
              targetModelId = existing.id;
          }
      }

      await ModelManager.addOrUpdateModel({
        id: targetModelId,
        backendModel: targetModelId === id ? id : undefined, // 濡傛灉鏄柊鍒涘缓锛岃缃?backendModel
        object: "model",
        owned_by: provider || "doubao-free-api",
        type: "chat", // 榛樿涓?chat锛岀敤鎴峰彲浠ュ湪妯″瀷绠＄悊鎵嬪姩淇敼
        enabled: true
      });
    }
  }

  public async addAccount(token: string, name: string, limits: any = {}, extra: any = {}) {
    // 鏀寔鎵归噺娣诲姞锛氬鏋?token 鍖呭惈鎹㈣锛屾媶鍒嗕负澶氫釜
    const tokens = token.split(/\r?\n/).map(t => t.trim()).filter(t => t.length > 0);
    
    // 濡傛灉 token 涓虹┖浣嗗睘浜庡吋瀹?API 鎴栨祻瑙堝櫒妗ｆ璐﹀彿锛屼篃浣滀负鍗曚釜澶勭悊
    if (tokens.length === 0 && (extra.apiKey || extra.authMode === "manual_browser_login")) {
        tokens.push(""); 
    }

    const channelName = name || `娓犻亾 ${this.accounts.length + 1}`;
    const createdAccounts: Account[] = [];

    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        const newAccount: Account = {
          id: util.uuid(),
          token: t,
          name: channelName,
          remark: tokens.length > 1 ? `Key ${i + 1}` : (extra.remark || ''),
          enabled: extra.enabled !== undefined ? !!extra.enabled : true,
          type: extra.type || "doubao",
          weight: extra.weight || 1,
          baseUrl: extra.baseUrl || "",
          apiKey: extra.apiKey || "",
          capability: extra.capability || undefined,
          modelName: extra.modelName || "",
          models: extra.models || "",
          modelMapping: extra.modelMapping || "",
          mergePolicy: extra.mergePolicy || "merge",
          authMode: extra.authMode || "sessionid_only",
          browserProfileId: extra.browserProfileId || "",
          browserUserDataDir: extra.browserUserDataDir || "",
          browserExecutablePath: extra.browserExecutablePath || "",
          browserType: extra.browserType || "chromium",
          browserFingerprint: extra.browserFingerprint || undefined,
          browserFingerprintSeed: extra.browserFingerprintSeed || "",
          browserCookies: Array.isArray(extra.browserCookies) ? extra.browserCookies : [],
          browserStorageState: extra.browserStorageState || undefined,
          lastBrowserOpenAt: extra.lastBrowserOpenAt || 0,
          lastSyncAt: extra.lastSyncAt || 0,
          lastProbeAt: extra.lastProbeAt || 0,
          lastProbeResult: extra.lastProbeResult || null,
          lastProbeError: extra.lastProbeError || "",
          lastLoginDetectedAt: extra.lastLoginDetectedAt || 0,
          sessionIdSource: extra.sessionIdSource || "",
          deviceId: `7${util.generateRandomString({length: 18, charset: "numeric"})}`,
          webId: `7${util.generateRandomString({length: 18, charset: "numeric"})}`,
          userId: util.uuid(false),
          limitChat: limits.chat !== undefined ? limits.chat : -1,
          limitImage: limits.image !== undefined ? limits.image : 60,
          limitVideo: limits.video !== undefined ? limits.video : 0,
          limitMusic: limits.music !== undefined ? limits.music : 0,
          usageChat: 0,
          usageImage: 0,
          usageVideo: 0,
          usageMusic: 0,
          totalUsage: 0,
          totalPromptTokens: 0,
          totalCompletionTokens: 0,
          skipHealthCheck: !!extra.skipHealthCheck,
          status: AccountStatus.IDLE,
          lastUsed: 0,
          cooldownUntil: 0,
          cooldownReason: ""
        };

        this.accounts.push(newAccount);
        createdAccounts.push(newAccount);
        
        // 鍚屾妯″瀷
        if (extra.models) {
            await this.syncModels(extra.models, newAccount.name, extra.mergePolicy);
        }
    }

    await this.saveAccounts();
    this.processQueue();
    return createdAccounts.length === 1 ? createdAccounts[0] : createdAccounts;
  }

  public async addBrowserAccount(payload: any = {}) {
    const profileId = payload.browserProfileId ||
      `profile-${util.generateRandomString({ length: 10, charset: "alphanumeric" }).toLowerCase()}`;
    const fingerprintSeed = payload.browserFingerprintSeed ||
      `${Math.floor(100000 + Math.random() * 2147383647)}`;

    const account = await this.addAccount("", payload.name || `娴忚鍣ㄦ。妗?${profileId}`, {
      chat: payload.limitChat !== undefined ? payload.limitChat : -1,
      image: payload.limitImage !== undefined ? payload.limitImage : 60,
      video: payload.limitVideo !== undefined ? payload.limitVideo : 0,
      music: payload.limitMusic !== undefined ? payload.limitMusic : 0,
    }, {
      ...payload,
      type: "doubao",
      authMode: "manual_browser_login",
      browserProfileId: profileId,
      browserFingerprintSeed: fingerprintSeed,
      browserUserDataDir: payload.browserUserDataDir || path.join(".cache", "fingerprint-chromium", "profiles", profileId),
      browserType: payload.browserType || "chromium",
      enabled: payload.enabled === true,
      sessionIdSource: "browser_profile"
    });

    return account;
  }

  public async updateAccount(id: string, updates: Partial<Account> & { mergePolicy?: 'new' | 'merge' }) {
    const index = this.accounts.findIndex((a) => a.id === id);
    if (index !== -1) {
      const wasEnabled = this.accounts[index].enabled;
      // 纭繚鏁板€煎瓧娈佃姝ｇ‘杞崲
      if (updates.weight !== undefined) updates.weight = Number(updates.weight);
      if (updates.limitChat !== undefined) updates.limitChat = Number(updates.limitChat);
      if (updates.limitImage !== undefined) updates.limitImage = Number(updates.limitImage);
      if (updates.limitVideo !== undefined) updates.limitVideo = Number(updates.limitVideo);
      if (updates.limitMusic !== undefined) updates.limitMusic = Number(updates.limitMusic);
      
      const { mergePolicy, ...rest } = updates;
      this.accounts[index] = { ...this.accounts[index], ...rest, mergePolicy: mergePolicy || this.accounts[index].mergePolicy || "merge" };
      if (!wasEnabled && updates.enabled) this.processQueue();
      if (updates.models) await this.syncModels(updates.models, this.accounts[index].name, mergePolicy);
      await this.saveAccounts();
      return this.accounts[index];
    }
    return null;
  }

  public getAccountById(id: string) {
    return this.accounts.find((a) => a.id === id) || null;
  }

  public getBrowserAccountById(id: string) {
    const account = this.getAccountById(id);
    if (!account || !this.isBrowserManagedAccount(account)) return null;
    return account;
  }

  /**
   * 鎸夊悕绉颁竴閿惎鐢?绂佺敤鏁翠釜娓犻亾锛堝寘鍚涓?Key锛?
   */
  public async toggleChannel(name: string, enabled: boolean) {
      let updatedCount = 0;
      let wasEnabledCount = 0;
      
      this.accounts = this.accounts.map(a => {
          if (a.name === name) {
              if (a.enabled) wasEnabledCount++;
              updatedCount++;
              return { ...a, enabled };
          }
          return a;
      });

      if (updatedCount > 0) {
          if (wasEnabledCount === 0 && enabled) {
              this.processQueue(); // 鏈夎妭鐐归噸鏂板惎鐢紝鍞ら啋闃熷垪
          }
          await this.saveAccounts();
      }
      return updatedCount;
  }

  /**
   * 鎸夊悕绉颁竴閿垹闄ゆ暣涓笭閬擄紙鍖呭惈澶氫釜 Key锛?
   */
  public async deleteChannel(name: string) {
      const originalLength = this.accounts.length;
      this.accounts = this.accounts.filter((a) => a.name !== name);
      const deletedCount = originalLength - this.accounts.length;
      
      if (deletedCount > 0) {
          await this.saveAccounts();
          // 鍚屾椂浠庢ā鍨嬬鐞嗕腑绉婚櫎璇ユ彁渚涜€?
          await ModelManager.removeProviderFromAllModels(name);
      }
      return deletedCount;
  }

  /**
   * 搴旂敤鍝嶅簲鐮佺瓥鐣?
   * @param id 璐﹀彿ID
   * @param statusCode HTTP 鐘舵€佺爜
   * @returns 澶勭悊鍔ㄤ綔 (retry | cooldown | etc)
   */
  public applyResponsePolicy(id: string, statusCode: number): PolicyAction | null {
    const account = this.accounts.find(a => a.id === id);
    if (!account) return null;

    const policy = ResponsePolicyManager.getPolicyForStatus(statusCode, account.type);
    if (!policy) return null;

    logger.warn("[AccountManager] 触发响应策略：账号 [" + account.name + "] 遇到状态码 [" + statusCode + "]，动作: " + policy.action + " (" + policy.description + ")");

    switch (policy.action) {
      case "disable":
        account.enabled = false;
        break;
      case "cooldown_1h":
        account.cooldownUntil = Date.now() + 3600 * 1000;
        account.cooldownReason = `Status ${statusCode}: ${policy.description}`;
        break;
      case "cooldown_24h":
        account.cooldownUntil = Date.now() + 24 * 3600 * 1000;
        account.cooldownReason = `Status ${statusCode}: ${policy.description}`;
        break;
    }

    this.saveAccounts();
    return policy.action;
  }



  /**
   * 鏇存柊璐﹀彿鐢ㄩ噺鍜?Token 缁熻
   */
  public async updateAccountUsage(id: string, type: AccountCapability, promptTokens: number = 0, completionTokens: number = 0) {
    const account = this.accounts.find(a => a.id === id);
    if (!account) return;

    if (type === 'chat') {
      account.usageChat += 1;
    } else if (type === 'image') {
      account.usageImage += 1;
    } else if (type === 'video') {
      account.usageVideo += 1;
    } else if (type === 'music') {
      account.usageMusic += 1;
    }
    
    account.totalUsage += 1;
    account.totalPromptTokens += promptTokens;
    account.totalCompletionTokens += completionTokens;

    await this.saveAccounts();
  }

  /**
   * 鑾峰彇鎵€鏈夊彲鐢ㄧ殑妯″瀷鍒楄〃
   */
  public getAvailableModels() {
    return ModelManager.getEnabledModels();
  }

  /**
   * 鑾峰彇璐﹀彿瀵圭壒瀹氳姹傛ā鍨嬬殑鏄犲皠锛堥噸瀹氬悜锛?
   * @param accountId 璐﹀彿ID
   * @param modelId 璇锋眰鐨勬ā鍨婭D
   * @returns 鏄犲皠鍚庣殑鍚庣妯″瀷鍚嶇О
   */
  public getMappedModel(accountId: string, modelId: string): string {
    const account = this.accounts.find(a => a.id === accountId);
    if (!account) return modelId;

    // 1. 浼樺厛妫€鏌ヨ处鍙风骇鍒殑鏄犲皠
    if (account.modelMapping) {
        try {
            const mapping = JSON.parse(account.modelMapping);
            if (mapping[modelId]) return mapping[modelId];
        } catch (e) {
            logger.error("[AccountManager] 解析账号 [" + account.name + "] 的模型映射失败:", e);
        }
    }

    // 2. 鍏舵妫€鏌ュ叏灞€妯″瀷榛樿鏄犲皠
    const globalConfig = ModelManager.getModelConfig(modelId);
    if (globalConfig && globalConfig.backendModel) {
        return globalConfig.backendModel;
    }

    // 3. 鏈€鍚庡鏋滆处鍙烽厤缃簡榛樿妯″瀷鍚嶇О涓旇姹傜鍚堢被鍨?
    if (account.modelName) return account.modelName;

    return modelId;
  }

  /**
   * Session 淇濇椿锛氬畾鏈熷悜璞嗗寘鍙戦€佽交閲忕骇璇锋眰浠ョ淮鎸?session 娲昏穬鐘舵€?
   * 瑙ｅ喅涓嶆墦寮€娴忚鍣ㄦ椂 session 鍥犱笉娲昏穬琚檷绾у鑷?-2001 閿欒鐨勯棶棰?
   */
  public async keepAliveAllAccounts() {
    const doubaoAccounts = this.accounts.filter(a => a.enabled && a.type === 'doubao' && !this.isBrowserManagedAccount(a));
    if (doubaoAccounts.length === 0) return;

    logger.info("[KeepAlive] 开始为 " + doubaoAccounts.length + " 个账号执行保活...");
    let successCount = 0;
    let failCount = 0;

    for (const account of doubaoAccounts) {
      try {
        const alive = await this.keepAliveAccount(account);
        if (alive) {
          successCount++;
        } else {
          failCount++;
          logger.warn("[KeepAlive] 账号 [" + account.name + "] 保活失败，session 可能已失效");
          account.healthStatus = 'unhealthy';
          account.healthError = "Session 保活失败";
        }
      } catch (e: any) {
        failCount++;
        logger.error("[KeepAlive] 账号 [" + account.name + "] 保活异常: " + e.message);
      }
    }

    if (failCount === 0) {
      logger.success("[KeepAlive] 全部 " + successCount + " 个账号保活成功");
    } else {
      logger.warn("[KeepAlive] 保活完成: 成功=" + successCount + ", 失败=" + failCount);
    }
    await this.saveAccounts();
  }

  /**
   * 鍗曚釜璐﹀彿淇濇椿锛氬彂閫佽交閲忕骇璇锋眰妯℃嫙娴忚鍣ㄦ椿璺?
   */
  private async keepAliveAccount(account: Account): Promise<boolean> {
    try {
      // 璇锋眰 1: 鑾峰彇浼氳瘽淇℃伅锛堣交閲忕骇 GET锛?
      const res = await axios.get("https://www.doubao.com/im/conversation/info", {
        headers: {
          "Cookie": `sessionid=${account.token}; sessionid_ss=${account.token}`,
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          "Referer": "https://www.doubao.com/chat/",
          "Origin": "https://www.doubao.com"
        },
        timeout: 15000,
        validateStatus: () => true
      });

      const isAlive = res.status === 200;
      if (isAlive) {
        account.healthStatus = 'healthy';
        account.healthError = undefined;
        account.lastHealthCheck = Date.now();
      }
      return isAlive;
    } catch (e: any) {
      account.healthError = `KeepAlive error: ${e.message}`;
      return false;
    }
  }

  /**
   * 妫€鏌ユ墍鏈夎处鍙峰仴搴风姸鎬?
   */
  public async checkAllAccountsHealth() {
    logger.info("[AccountManager] 开始执行账号健康检查...");
    for (const account of this.accounts) {
       if (!account.enabled || account.skipHealthCheck || this.isBrowserManagedAccount(account)) continue;
       const isHealthy = await this.checkAccountHealth(account);
       account.lastHealthCheck = Date.now();
       account.healthStatus = isHealthy ? "healthy" : "unhealthy";
       if (!isHealthy) {
          logger.error("[AccountManager] 账号健康检查失败 [" + account.name + "] (" + account.type + ")");
          // 濡傛灉鏄眴鍖呰处鍙?session 澶辨晥锛屽彲浠ヨ€冭檻鑷姩绂佺敤鎴栦粎鏍囪
          // account.enabled = false; 
       }
    }
    await this.saveAccounts();
  }

  /**
   * 妫€鏌ュ崟涓处鍙峰仴搴风姸鎬?
   */
  public async checkAccountHealth(account: Account): Promise<boolean> {
    try {
      if (account.type === 'doubao') {
        const res = await axios.get("https://www.doubao.com/im/conversation/info", {
          headers: {
            "Cookie": `sessionid=${account.token}`,
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
          },
          timeout: 10000,
          validateStatus: () => true 
        });
        // 璞嗗寘鎺ュ彛闈?200 鎴?code 寮傚父閫氬父鎰忓懗鐫€ session 杩囨湡
        const healthy = res.status === 200 && (!res.data || res.data.code !== 401);
        if (!healthy) account.healthError = `HTTP ${res.status}: ${JSON.stringify(res.data)}`;
        else account.healthError = undefined;
        return healthy;
      } else {
        const url = (account.baseUrl || "").replace(/\/$/, "") + "/v1/models";
        const res = await axios.get(url, {
          headers: { "Authorization": `Bearer ${account.apiKey}` },
          timeout: 10000,
          validateStatus: () => true
        });
        const healthy = res.status === 200;
        if (!healthy) account.healthError = `HTTP ${res.status}`;
        else account.healthError = undefined;
        return healthy;
      }
    } catch (e: any) {
      account.healthError = e.message;
      return false;
    }
  }

  public async deleteAccount(id: string) {
    const account = this.accounts.find(a => a.id === id);
    if (!account) return;

    const channelName = account.name;
    this.accounts = this.accounts.filter((a) => a.id !== id);
    await this.saveAccounts();

    // 濡傛灉璇ユ笭閬撲笅娌℃湁鍏朵粬璐﹀彿浜嗭紝鍒欎粠妯″瀷绠＄悊涓Щ闄よ鎻愪緵鑰?
    const hasRemaining = this.accounts.some(a => a.name === channelName);
    if (!hasRemaining) {
        await ModelManager.removeProviderFromAllModels(channelName);
    }
  }

  public async resetDailyUsage() {
    this.accounts.forEach(acc => {
        acc.usageChat = 0;
        acc.usageImage = 0;
        acc.usageVideo = 0;
        acc.usageMusic = 0;
    });
    await this.saveAccounts();
    this.processQueue();
  }

  public async probeBrowserAccountsIfDue() {
    const intervalMinutes = Math.max(1, Number(this.settings.browserProbeIntervalMinutes || 720));
    const dueAccounts = this.accounts.filter(account => {
      if (!this.isBrowserManagedAccount(account) || !account.enabled) return false;
      const lastProbeAt = Number(account.lastProbeAt || 0);
      return !lastProbeAt || Date.now() - lastProbeAt >= intervalMinutes * 60 * 1000;
    });

    if (dueAccounts.length === 0) return;

    const { default: BrowserProfileManager } = await import("./browser-profile-manager.ts");
    logger.info("[AccountManager] 开始为 " + dueAccounts.length + " 个浏览器账号执行定时探活...");

    for (const account of dueAccounts) {
      try {
        const snapshot = await BrowserProfileManager.captureProfileSnapshot(account, this.settings, {
          probeUpstream: true,
          headless: true
        });
        await this.updateAccount(account.id, {
          token: snapshot.token || account.token,
          webId: snapshot.webId || account.webId,
          deviceId: snapshot.deviceId || account.deviceId,
          browserFingerprint: snapshot.browserFingerprint,
          browserCookies: snapshot.browserCookies,
          browserStorageState: snapshot.browserStorageState,
          lastProbeAt: Date.now(),
          lastProbeResult: snapshot.probeResult,
          lastProbeError: "",
          lastLoginDetectedAt: snapshot.probeResult?.isLoginLikely ? Date.now() : account.lastLoginDetectedAt,
          sessionIdSource: snapshot.token ? "browser_profile" : account.sessionIdSource
        });
      } catch (err: any) {
        logger.error("[AccountManager] 浏览器档案探活失败 [" + account.name + "]:", err);
        await this.updateAccount(account.id, {
          lastProbeAt: Date.now(),
          lastProbeError: err?.message || String(err),
          lastProbeResult: {
            ok: false,
            error: err?.message || String(err)
          }
        });
      }
    }
  }

  private isBrowserManagedAccount(account: Account) {
    return account.authMode === "manual_browser_login";
  }

  private maskValue(value?: string) {
    if (!value) return "";
    if (value.length <= 10) return value;
    return `${value.slice(0, 4)}...${value.slice(-4)}`;
  }
}

export default new AccountManager();

