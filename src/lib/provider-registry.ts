/**
 * @file provider-registry.ts
 * @description 渠道驱动注册中心 (Provider Plugin Architecture)。
 * 核心职责：
 *   1. 统一管理系统中所有的渠道驱动 (Doubao, Miaoxiang, Jimeng, OpenAI, 等)。
 *   2. 解耦前端硬编码与后端路由 if-else 判定，支持新增渠道插件化动态注册。
 *   3. 暴露 getAllProvidersInfo() 供 /v1/admin/providers 接口返回给前端动态渲染“添加渠道”界面。
 */

import logger from "@/lib/logger.ts";

export type ProviderCapability = "chat" | "image" | "video" | "music";

export interface ProviderInfo {
    id: string;
    name: string;
    description: string;
    capabilities: ProviderCapability[];
    defaultModels: string[];
}

export interface ProviderDriver extends ProviderInfo {
    createCompletion(params: any, account: any, options?: any): Promise<any>;
    createCompletionStream?(params: any, account: any, options?: any): Promise<any>;
}

class ProviderRegistry {
    private drivers = new Map<string, ProviderDriver>();

    /**
     * 注册一个新的渠道驱动
     */
    public registerDriver(driver: ProviderDriver) {
        this.drivers.set(driver.id, driver);
        logger.info(`[ProviderRegistry] 成功注册渠道驱动: ${driver.name} (id: ${driver.id})`);
    }

    /**
     * 根据渠道 ID 获取驱动实例
     */
    public getDriver(id: string): ProviderDriver | undefined {
        if (!id) return undefined;
        return this.drivers.get(id.toLowerCase());
    }

    /**
     * 获取所有已注册驱动的元数据列表（供前端 API 动态渲染渠道选择框）
     */
    public getAllProvidersInfo(): ProviderInfo[] {
        return Array.from(this.drivers.values()).map(d => ({
            id: d.id,
            name: d.name,
            description: d.description,
            capabilities: d.capabilities,
            defaultModels: d.defaultModels
        }));
    }

    /**
     * 判断指定渠道 ID 是否已注册
     */
    public hasDriver(id: string): boolean {
        return this.drivers.has(id.toLowerCase());
    }
}

const providerRegistry = new ProviderRegistry();
export default providerRegistry;
