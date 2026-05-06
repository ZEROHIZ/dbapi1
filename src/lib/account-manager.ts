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

  // 设备信息指纹
  deviceId?: string;
  webId?: string;
  userId?: string;
  
  // New: 渠道支持的模型列表 (如 "doubao,doubao-pro")
  models?: string; 
  // New: 模型重定向映射 JSON (如 {"doubao-image": "Seedream 4.5"})
  modelMapping?: string; 
  // New: 备注，用于区分同一渠道下的不同 Key
  remark?: string;
  // New: 模型合并策略
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
  skipHealthCheck?: boolean; // 新增：是否跳过健康检查

  // 兼容旧字段（读取时转换，保存时废弃）
  dailyLimit?: number;
  dailyUsage?: number;
}


export interface Settings {
  cooldownTime: number; // 毫秒
  defaultModel: string;
  enableHealthCheck?: boolean; // 新增：是否开启全局健康检查
  videoTimeout?: number; // 毫秒
  imageGenerationDelayMs?: number; // 毫秒
  enableKeepAlive?: boolean; // 是否开启 Session 保活（默认 true）
  keepAliveIntervalMinutes?: number; // 保活间隔（分钟，默认 5）
}

export type RequestType = "chat" | "image" | "video" | "music";

class AccountManager extends EventEmitter {
  private accounts: Account[] = [];
  private lastRoundRobinIndex: number = -1; // 用于轮询
  private settings: Settings = {
    cooldownTime: 10000,
    defaultModel: "doubao-lite-4k",
    videoTimeout: 180000,
    imageGenerationDelayMs: 3000
  };

  
  // 队列需要记录请求类型
  private queue: Array<{ 
      type: RequestType;
      modelId?: string;
      resolve: (account: Account) => void; 
      reject: (err: any) => void 
  }> = [];

  /**
   * 将账号支持的模型列表与模型管理器中的提供者设置同步 (双向同步)
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
          logger.info(`[AccountManager] 已自动同步 [${targetChannels.join(', ')}] 渠道的支持模型列表`);
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

    // 每天0点重置
    new cron.CronJob("0 0 0 * * *", () => {
      this.resetDailyUsage();
    }).start();

    // 账号健康检查：每 30 分钟一次
    new cron.CronJob('0 */30 * * * *', () => {
        if (this.settings.enableHealthCheck !== false) {
            this.checkAllAccountsHealth();
        }
    }, null, true);

    // Session 保活定时任务
    const keepAliveInterval = this.settings.keepAliveIntervalMinutes || 5;
    new cron.CronJob(`0 */${keepAliveInterval} * * * *`, () => {
        if (this.settings.enableKeepAlive !== false) {
            this.keepAliveAllAccounts();
        }
    }, null, true);

    logger.success("[AccountManager] 初始化完成，已开启定时任务");

    // 初始化运行时状态
    this.accounts.forEach(acc => {
      acc.status = AccountStatus.IDLE;
    });
    
    const keepAliveStatus = this.settings.enableKeepAlive !== false ? `已开启(每${keepAliveInterval}分钟)` : '已关闭';
    logger.info(`[AccountManager] 系统初始化完成，共加载 ${this.accounts.length} 个账号。Session保活: ${keepAliveStatus}`);
  }

  private async loadAccounts() {
    try {
      if (await fs.pathExists(ACCOUNTS_FILE)) {
        const stored = await fs.readJson(ACCOUNTS_FILE);
        this.accounts = stored.map((s: any) => ({
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
            models: s.models || "",
            modelMapping: s.modelMapping || "",
            mergePolicy: s.mergePolicy || "merge",
            // 兼容逻辑：如果没有新字段，使用默认值
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
        limitChat: a.limitChat, limitImage: a.limitImage, limitVideo: a.limitVideo, limitMusic: a.limitMusic,
        usageChat: a.usageChat, usageImage: a.usageImage, usageVideo: a.usageVideo, usageMusic: a.usageMusic,
        totalUsage: a.totalUsage,
        totalPromptTokens: a.totalPromptTokens,
        totalCompletionTokens: a.totalCompletionTokens,
        cooldownUntil: a.cooldownUntil,
        cooldownReason: a.cooldownReason
      }));

      await fs.writeJson(ACCOUNTS_FILE, toSave, { spaces: 2 });
    } catch (e) {
      logger.error("保存账号文件失败:", e);
    }
  }

  private async loadSettings() {
    try {
      if (await fs.pathExists(SETTINGS_FILE)) {
        const loaded = await fs.readJson(SETTINGS_FILE);
        // 兼容旧的或由于误解产生的 videoPollingTimeout 字段
        if (loaded.videoPollingTimeout !== undefined && loaded.videoTimeout === undefined) {
             loaded.videoTimeout = loaded.videoPollingTimeout;
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

  // 计算某类服务或特定模型的总剩余额度 (如果是无限则返回一个极大值)
  public getTotalRemainingUsage(type: RequestType = 'chat', modelId?: string): number {
      return this.accounts
          .filter(a => {
              if (!a.enabled) return false;
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

    // 第一步：筛选出所有当前符合条件（存活、空闲、有额度、匹配模型）的账号
    for (const a of this.accounts) {
        if (!a.enabled) continue;
        
        // 检查状态码策略导致的冷却
        if (a.cooldownUntil && a.cooldownUntil > now) continue;

        // 检查运行时状态 (BUSY/COOLDOWN)
        if (a.status !== AccountStatus.IDLE) continue;

        // --- 新模型路由逻辑 ---
        if (modelId) {
            // 1. 如果账号配置了 specific models，则必须包含该模型
            if (a.models && a.models.trim().length > 0) {
                const supportedModels = a.models.split(/[,，]/).map(m => m.trim());
                if (!supportedModels.includes(modelId)) continue;
            }
        }

        // 检查第三方渠道功能匹配
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

    // 第四步：在最高权重的账号池中进行轮询，以分散请求压力
    // 这里借用并更新 lastRoundRobinIndex 实现简单的伪轮询选择
    this.lastRoundRobinIndex = (this.lastRoundRobinIndex + 1) % topWeightAccounts.length;
    return topWeightAccounts[this.lastRoundRobinIndex];
  }


  public acquireToken(type: RequestType = 'chat', modelId?: string): Promise<Account> {
    return new Promise((resolve, reject) => {
      // 1. 检查是否有任何账号支持该请求
      const existsCapable = this.accounts.some(a => {
          if (!a.enabled) return false;
          if (modelId && a.models && a.models.trim().length > 0) {
              const supportedModels = a.models.split(/[,，]/).map(m => m.trim());
              if (!supportedModels.includes(modelId)) return false;
          }
          if (a.type === 'openai' && a.capability && a.capability !== type) return false;
          return true;
      });

      if (!existsCapable) {
          return reject(new APIException([-403, `没有找到支持 [${type}${modelId ? ':' + modelId : ''}] 的活跃渠道，请检查配置。`]));
      }

      // 2. 检查这些支持账号的剩余额度
      const remaining = this.getTotalRemainingUsage(type, modelId);
      if (remaining <= 0) {
          return reject(new APIException([-403, `系统今日 [${type}${modelId ? ':' + modelId : ''}] 额度已耗尽。`]));
      }

      // 3. 尝试获取空闲账号
      const account = this.tryGetAvailableAccount(type, modelId);
      if (account) {
        this.lockAccount(account, type);
        resolve(account);
      } else {
        // 4. 进入队列 (只有在确实有额度只是暂时忙碌时才进入队列)
        this.queue.push({ type, modelId, resolve: (account: Account) => resolve(account), reject });
        logger.info(`[AccountManager] 暂无空闲账号，请求 [${type}:${modelId || 'any'}] 进入队列。当前排队: ${this.queue.length}`);
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
    logger.info(`[AccountManager] 账号 [${account.name}] 锁定 (Type: ${type})。`);
  }

  public releaseToken(token: string) {
    const account = this.accounts.find(a => a.token === token);
    if (!account) return;

    account.status = AccountStatus.COOLDOWN;
    logger.info(`[AccountManager] 账号 [${account.name}] 任务完成，进入 ${this.settings.cooldownTime/1000}s 冷却。`);

    setTimeout(() => {
      account.status = AccountStatus.IDLE;
      logger.info(`[AccountManager] 账号 [${account.name}] 冷却结束，恢复空闲。`);
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
            logger.info(`[AccountManager] 队列请求 [${req.type}] 已分配至 [${account.name}]。`);
            return; 
        }
    }
  }

  public getAccountsData() {
      // 计算剩余量辅助前端显示
      return this.accounts.map(a => ({
          ...a,
          remainingChat: a.limitChat === -1 ? '∞' : Math.max(0, a.limitChat - a.usageChat),
          remainingImage: Math.max(0, a.limitImage - a.usageImage),
          remainingVideo: Math.max(0, a.limitVideo - a.usageVideo),
          remainingMusic: Math.max(0, a.limitMusic - a.usageMusic),
          status: a.status
      }));
  }
  
  public getSettings() {
    return this.settings;
  }

  public getStats() {
      const usage = this.accounts.reduce((sums, a) => ({
          chat: sums.chat + (a.usageChat || 0),
          image: sums.image + (a.usageImage || 0),
          video: sums.video + (a.usageVideo || 0),
          music: sums.music + (a.usageMusic || 0)
      }), { chat: 0, image: 0, video: 0, music: 0 });

      return {
          totalAccounts: this.accounts.length,
          enabledAccounts: this.accounts.filter(a => a.enabled).length,
          statusCounts: {
              idle: this.accounts.filter(a => a.status === AccountStatus.IDLE && a.enabled).length,
              busy: this.accounts.filter(a => a.status === AccountStatus.BUSY).length,
              cooldown: this.accounts.filter(a => a.status === AccountStatus.COOLDOWN).length,
          },
          queue: this.queue.length,
          totalRemainingChat: this.getTotalRemainingUsage('chat'),
          totalRemainingImage: this.getTotalRemainingUsage('image'),
          totalRemainingVideo: this.getTotalRemainingUsage('video'),
          totalRemainingMusic: this.getTotalRemainingUsage('music'),
          totalTokens: this.accounts.reduce((sum, a) => sum + (a.totalPromptTokens || 0) + (a.totalCompletionTokens || 0), 0),
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
      // 检查是否已经存在具有相同 backendModel 的模型（如果是 merge 模式）
      let targetModelId = id;
      if (mergePolicy === 'merge') {
          const existing = ModelManager.getAllModels().find(m => m.backendModel === id || m.id === id);
          if (existing) {
              targetModelId = existing.id;
          }
      }

      await ModelManager.addOrUpdateModel({
        id: targetModelId,
        backendModel: targetModelId === id ? id : undefined, // 如果是新创建，设置 backendModel
        object: "model",
        owned_by: provider || "doubao-free-api",
        type: "chat", // 默认为 chat，用户可以在模型管理手动修改
        enabled: true
      });
    }
  }

  public async addAccount(token: string, name: string, limits: any = {}, extra: any = {}) {
    // 支持批量添加：如果 token 包含换行，拆分为多个
    const tokens = token.split(/\r?\n/).map(t => t.trim()).filter(t => t.length > 0);
    
    // 如果 token 为空但有 apiKey (OpenAI 类型)，也作为单个处理
    if (tokens.length === 0 && extra.apiKey) {
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
          enabled: true,
          type: extra.type || "doubao",
          weight: extra.weight || 1,
          baseUrl: extra.baseUrl || "",
          apiKey: extra.apiKey || "",
          capability: extra.capability || undefined,
          modelName: extra.modelName || "",
          models: extra.models || "",
          modelMapping: extra.modelMapping || "",
          mergePolicy: extra.mergePolicy || "merge",
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
   * @param id 账号ID
   * @param statusCode HTTP 状态码
   * @returns 处理动作 (retry | cooldown | etc)
   */
  public applyResponsePolicy(id: string, statusCode: number): PolicyAction | null {
    const account = this.accounts.find(a => a.id === id);
    if (!account) return null;

    const policy = ResponsePolicyManager.getPolicyForStatus(statusCode, account.type);
    if (!policy) return null;

    logger.warn(`[AccountManager] 触发响应策略: 账号 [${account.name}] 遇到 [${statusCode}], 动作: ${policy.action} (${policy.description})`);

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
   * @param accountId 账号ID
   * @param modelId 请求的模型ID
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
            logger.error(`解析账号 [${account.name}] 的模型映射失败:`, e);
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
   * Session 保活：定期向豆包发送轻量级请求以维持 session 活跃状态
   * 解决不打开浏览器时 session 因不活跃被降级导致 -2001 错误的问题
   */
  public async keepAliveAllAccounts() {
    const doubaoAccounts = this.accounts.filter(a => a.enabled && a.type === 'doubao');
    if (doubaoAccounts.length === 0) return;

    logger.info(`[KeepAlive] 开始保活 ${doubaoAccounts.length} 个豆包账号...`);
    let successCount = 0;
    let failCount = 0;

    for (const account of doubaoAccounts) {
      try {
        const alive = await this.keepAliveAccount(account);
        if (alive) {
          successCount++;
        } else {
          failCount++;
          logger.warn(`[KeepAlive] 账号 [${account.name}] 保活失败，session 可能已过期`);
          account.healthStatus = 'unhealthy';
          account.healthError = 'Session keep-alive failed';
        }
      } catch (e: any) {
        failCount++;
        logger.error(`[KeepAlive] 账号 [${account.name}] 保活异常: ${e.message}`);
      }
    }

    if (failCount === 0) {
      logger.success(`[KeepAlive] 全部 ${successCount} 个账号保活成功`);
    } else {
      logger.warn(`[KeepAlive] 保活完成: 成功=${successCount}, 失败=${failCount}`);
    }
    await this.saveAccounts();
  }

  /**
   * 单个账号保活：发送轻量级请求模拟浏览器活跃
   */
  private async keepAliveAccount(account: Account): Promise<boolean> {
    try {
      // 请求 1: 获取会话信息（轻量级 GET）
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
   * 检查所有账号健康状态
   */
  public async checkAllAccountsHealth() {
    logger.info(`[AccountManager] 开始执行账号健康检查...`);
    for (const account of this.accounts) {
       if (!account.enabled || account.skipHealthCheck) continue;
       const isHealthy = await this.checkAccountHealth(account);
       account.lastHealthCheck = Date.now();
       account.healthStatus = isHealthy ? "healthy" : "unhealthy";
       if (!isHealthy) {
          logger.error(`[AccountManager] 账号健康检查失败: [${account.name}] (${account.type})`);
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
        // 豆包接口非 200 或 code 异常通常意味着 session 过期
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
}

export default new AccountManager();
