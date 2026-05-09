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
  
  // 类型与权重
  type: AccountType;
  weight: number;

  // 第三方 OpenAI 兼容 API 字段
  baseUrl?: string;
  apiKey?: string;
  capability?: AccountCapability;
  modelName?: string;

  // 设备信息与浏览器指纹
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
  
  // 渠道支持的模型列表，例如 "doubao,doubao-pro"
  models?: string; 
  // 模型重定向映射 JSON，例如 {"doubao-image": "Seedream 4.5"}
  modelMapping?: string; 
  // 备注，用于区分同一渠道下的不同 Key
  remark?: string;
  // 模型合并策略
  mergePolicy?: "new" | "merge";

  // 统计与限制
  limitChat: number;  // -1 表示不限
  limitImage: number;
  limitVideo: number;
  limitMusic: number;
  
  usageChat: number;
  usageImage: number;
  usageVideo: number;
  usageMusic: number;
  
  totalUsage: number; // 总调用次数
  
  // Token 用量统计
  totalPromptTokens: number;
  totalCompletionTokens: number;

  // 运行时状态
  status?: AccountStatus;
  lastUsed?: number;
  cooldownUntil?: number;   // 状态码策略导致的长冷却
  cooldownReason?: string;
  
  // 健康检查
  lastHealthCheck?: number;
  healthStatus?: "healthy" | "unhealthy";
  healthError?: string;
  skipHealthCheck?: boolean; // 是否跳过健康检查

  // 兼容旧字段（读取时转换，保存时废弃）
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
  browserProbeHeadless?: boolean;
}


export type RequestType = "chat" | "image" | "video" | "music";

class AccountManager extends EventEmitter {
  private accounts: Account[] = [];
  private lastRoundRobinIndex: number = -1; // 用于轮询
  private settings: Settings = {
    cooldownTime: 10000,
    defaultModel: "doubao-lite-4k",
    videoTimeout: 180000,
    imageGenerationDelayMs: 3000,
    browserExecutablePath: process.env.FINGERPRINT_CHROMIUM_PATH || "",
    browserProbeIntervalMinutes: 720,
    browserProbeHeadless: true
  };

  
  // 队列中需要记录请求类型
  private queue: Array<{ 
      type: RequestType;
      modelId?: string;
      resolve: (account: Account) => void; 
      reject: (err: any) => void 
  }> = [];

  /**
   * 将账号支持的模型列表与模型管理器中的提供者配置同步（双向同步）
   * @param specificChannel 可选，只同步特定渠道
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

    // 每天 0 点重置
    new cron.CronJob("0 0 0 * * *", () => {
      this.resetDailyUsage();
    }).start();

    // 账号健康检查：每 30 分钟执行一次
    new cron.CronJob('0 */30 * * * *', () => {
        if (this.settings.enableHealthCheck !== false) {
            this.checkAllAccountsHealth();
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

    logger.info(
      "[AccountManager] 系统初始化完成，已加载 " +
        this.accounts.length +
        " 个账号，浏览器探活间隔：" +
        (this.settings.browserProbeIntervalMinutes || 0) +
        " 分钟"
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
      // 仅保存必要字段，清理旧字段
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
        // 兼容旧的 videoPollingTimeout 字段
        if (loaded.videoPollingTimeout !== undefined && loaded.videoTimeout === undefined) {
             loaded.videoTimeout = loaded.videoPollingTimeout;
        }
        if (loaded.browserProbeIntervalMinutes === undefined && loaded.browserProbeIntervalHours !== undefined) {
             loaded.browserProbeIntervalMinutes = Number(loaded.browserProbeIntervalHours) * 60;
        }
        delete loaded.enableKeepAlive;
        delete loaded.keepAliveIntervalMinutes;
        this.settings = { ...this.settings, ...loaded };
      }
    } catch (e) {
      logger.error("加载设置失败:", e);
    }
  }

  public async saveSettings(newSettings: Partial<Settings>) {
    this.settings = { ...this.settings, ...newSettings };
    try {
      const settingsToSave: Settings = {
        cooldownTime: this.settings.cooldownTime,
        defaultModel: this.settings.defaultModel,
        enableHealthCheck: this.settings.enableHealthCheck,
        videoTimeout: this.settings.videoTimeout,
        imageGenerationDelayMs: this.settings.imageGenerationDelayMs,
        browserExecutablePath: this.settings.browserExecutablePath,
        browserProbeIntervalMinutes: this.settings.browserProbeIntervalMinutes,
        browserProbeIntervalHours: this.settings.browserProbeIntervalHours,
        browserProbeHeadless: this.settings.browserProbeHeadless,
      };
      await fs.writeJson(SETTINGS_FILE, settingsToSave, { spaces: 2 });
    } catch (e) {
      logger.error("保存设置失败:", e);
    }
  }

  // 计算某类服务或特定模型的总剩余额度；如果是无限则返回一个极大值
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

    // 第一步：筛选出所有当前符合条件的账号
    for (const a of this.accounts) {
        if (!a.enabled) continue;
        if (this.isBrowserManagedAccount(a)) continue;
        
        // 检查状态码策略导致的长冷却
        if (a.cooldownUntil && a.cooldownUntil > now) continue;

        // 检查运行时状态（BUSY/COOLDOWN）
        if (a.status !== AccountStatus.IDLE) continue;

        // 新模型路由逻辑
        if (modelId) {
            // 1. 如果账号配置了 specific models，则必须包含该模型
            if (a.models && a.models.trim().length > 0) {
                const supportedModels = a.models.split(/[,，]/).map(m => m.trim());
                if (!supportedModels.includes(modelId)) continue;
            }
        }

        // 检查第三方渠道能力匹配
        if (a.type === 'openai') {
           if (a.capability && a.capability !== type) continue;
        }
        
        // 检查对应额度
        if (type === 'chat' && a.limitChat !== -1 && a.usageChat >= a.limitChat) continue;
        if (type === 'image' && a.usageImage >= a.limitImage) continue;
        if (type === 'video' && a.usageVideo >= a.limitVideo) continue;
        if (type === 'music' && a.usageMusic >= a.limitMusic) continue;
        
        availableAccounts.push(a);
    }

    if (availableAccounts.length === 0) return null;

    // 第二步：按权重降序排序
    availableAccounts.sort((a, b) => (b.weight || 1) - (a.weight || 1));

    // 第三步：取出所有最高权重的账号
    const highestWeight = availableAccounts[0].weight || 1;
    const topWeightAccounts = availableAccounts.filter(a => (a.weight || 1) === highestWeight);

    // 第四步：在最高权重账号池中轮询，分散请求压力
    // 这里借助 lastRoundRobinIndex 实现简单轮询选择
    this.lastRoundRobinIndex = (this.lastRoundRobinIndex + 1) % topWeightAccounts.length;
    return topWeightAccounts[this.lastRoundRobinIndex];
  }


  public acquireToken(type: RequestType = 'chat', modelId?: string): Promise<Account> {
    return new Promise((resolve, reject) => {
      // 1. 检查是否有任何账号支持该请求
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

      // 2. 检查这些支持账号的剩余额度
      const remaining = this.getTotalRemainingUsage(type, modelId);
      if (remaining <= 0) {
          return reject(
              new APIException([-403, "System quota exhausted for [" + type + (modelId ? ":" + modelId : "") + "] today"])
          );
      }

      // 3. 尝试获取空闲账号
      const account = this.tryGetAvailableAccount(type, modelId);
      if (account) {
        this.lockAccount(account, type);
        resolve(account);
      } else {
        // 4. 进入队列：只有确认有额度、只是暂时无空闲账号时才排队
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

    // 遍历队列，寻找第一个能被满足的请求
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
      // 为前端补充剩余额度
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
   * 将账号支持的模型同步到 ModelManager
   * @param modelsStr 支持模型字符串
   * @param provider 提供者名称
   * @param mergePolicy 合并策略: 'new' | 'merge'
   */
  private async syncModels(modelsStr: string, provider: string, mergePolicy: 'new' | 'merge' = 'merge') {
    if (!modelsStr || modelsStr.trim().length === 0) return;
    const modelIds = modelsStr.split(/[,，]/).map((m) => m.trim()).filter(m => m.length > 0);
    
    for (const id of modelIds) {
      // merge 模式下，检查是否已经存在相同 backendModel 的模型
      let targetModelId = id;
      if (mergePolicy === 'merge') {
          const existing = ModelManager.getAllModels().find(m => m.backendModel === id || m.id === id);
          if (existing) {
              targetModelId = existing.id;
          }
      }

      await ModelManager.addOrUpdateModel({
        id: targetModelId,
        backendModel: targetModelId === id ? id : undefined, // 新创建时设置 backendModel
        object: "model",
        owned_by: provider || "doubao-free-api",
        type: "chat", // 默认是 chat，用户可在模型管理中手动修改
        enabled: true
      });
    }
  }

  public async addAccount(token: string, name: string, limits: any = {}, extra: any = {}) {
    // 支持批量添加：如果 token 包含换行，则拆分为多个
    const tokens = token.split(/\r?\n/).map(t => t.trim()).filter(t => t.length > 0);
    
    // 如果 token 为空，但属于兼容 API 或浏览器档案账号，也按单个处理
    if (tokens.length === 0 && (extra.apiKey || extra.authMode === "manual_browser_login")) {
        tokens.push(""); 
    }

    const channelName = name || `渠道 ${this.accounts.length + 1}`;
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
        
        // 同步模型
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

    const account = await this.addAccount("", payload.name || `浏览器档案 ${profileId}`, {
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
      browserUserDataDir: payload.browserUserDataDir || path.join("data", "browser-profiles", profileId),
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
      // 确保数值字段被正确转换
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
   * 按名称一键启用/禁用整个渠道（包含多个 Key）
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
              this.processQueue(); // 有节点重新启用，唤醒队列
          }
          await this.saveAccounts();
      }
      return updatedCount;
  }

  /**
   * 按名称一键删除整个渠道（包含多个 Key）
   */
  public async deleteChannel(name: string) {
      const originalLength = this.accounts.length;
      this.accounts = this.accounts.filter((a) => a.name !== name);
      const deletedCount = originalLength - this.accounts.length;
      
      if (deletedCount > 0) {
          await this.saveAccounts();
          // 同时从模型管理中移除该提供者
          await ModelManager.removeProviderFromAllModels(name);
      }
      return deletedCount;
  }

  /**
   * 应用响应码策略
   * @param id 账号 ID
   * @param statusCode HTTP 状态码
   * @returns 处理动作 (retry | cooldown | etc)
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
   * 更新账号用量和 Token 统计
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
   * 获取所有可用的模型列表
   */
  public getAvailableModels() {
    return ModelManager.getEnabledModels();
  }

  /**
   * 获取账号对特定请求模型的映射（重定向）
   * @param accountId 账号 ID
   * @param modelId 请求模型 ID
   * @returns 映射后的后端模型名称
   */
  public getMappedModel(accountId: string, modelId: string): string {
    const account = this.accounts.find(a => a.id === accountId);
    if (!account) return modelId;

    // 1. 优先检查账号级别的映射
    if (account.modelMapping) {
        try {
            const mapping = JSON.parse(account.modelMapping);
            if (mapping[modelId]) return mapping[modelId];
        } catch (e) {
            logger.error("[AccountManager] 解析账号 [" + account.name + "] 的模型映射失败:", e);
        }
    }

    // 2. 其次检查全局模型默认映射
    const globalConfig = ModelManager.getModelConfig(modelId);
    if (globalConfig && globalConfig.backendModel) {
        return globalConfig.backendModel;
    }

    // 3. 最后如果账号配置了默认模型名称且请求符合类型
    if (account.modelName) return account.modelName;

    return modelId;
  }

  /**
   * 检查所有账号健康状态
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
          // 如果是豆包账号 session 失效，可以考虑自动禁用或仅标记
          // account.enabled = false; 
       }
    }
    await this.saveAccounts();
  }

  /**
   * 检查单个账号健康状态
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
        // 豆包接口非 200 或 code 异常通常意味着 session 已过期
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

    // 如果该渠道下没有其他账号了，则从模型管理中移除该提供者
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
          headless: this.settings.browserProbeHeadless !== false
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

