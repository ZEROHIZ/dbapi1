import { chromium, Browser, BrowserContext, Page } from 'playwright-core';
import path from 'path';
import logger from '../../lib/logger';

class BrowserService {
  private browser: Browser | null = null;
  private contexts = new Map<string, { context: BrowserContext; page: Page; lastUsed: number }>();
  private idleTimeoutMs = 10 * 60 * 1000; // 10分钟空闲超时
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    // 启动定时清理任务
    this.cleanupInterval = setInterval(() => this.cleanupIdleContexts(), 60 * 1000);
  }

  /**
   * 初始化或获取浏览器实例
   */
  private async getBrowser(): Promise<Browser> {
    if (!this.browser) {
      logger.info('[BrowserService] 启动本地 Chromium 浏览器...');
      // 指向本地缓存的 Chromium
      const executablePath = path.resolve(
        process.cwd(),
        '.cache/fingerprint-chromium/144.0.7559.132/ungoogled-chromium_144.0.7559.132-1.1_windows_x64/chrome.exe'
      );

      this.browser = await chromium.launch({
        executablePath,
        headless: true,
        args: [
          '--disable-gpu',
          '--disable-dev-shm-usage',
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-blink-features=AutomationControlled'
        ]
      });
      logger.info('[BrowserService] 浏览器启动成功');
    }
    return this.browser;
  }

  /**
   * 获取或创建对应的上下文
   */
  private async getContext(sessionId: string, cookieString: string, referer: string): Promise<{ context: BrowserContext; page: Page }> {
    let session = this.contexts.get(sessionId);

    if (session) {
      session.lastUsed = Date.now();
      return session;
    }

    logger.info(`[BrowserService] 为 Session [${sessionId}] 创建新的浏览器上下文`);
    const browser = await this.getBrowser();
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 720 },
    });

    // 资源优化：拦截无关请求
    await context.route('**/*', (route, request) => {
      const type = request.resourceType();
      const url = request.url();
      
      // 允许文档加载、XHR/Fetch
      if (['document', 'xhr', 'fetch'].includes(type)) {
        return route.continue();
      }
      
      // 允许特定域名的脚本加载（主要是bdms等风控相关脚本）
      if (type === 'script') {
        if (url.includes('vlabstatic.com') || url.includes('bytescm.com') || url.includes('jianying.com') || url.includes('capcut.com')) {
          return route.continue();
        }
      }
      
      // 阻止图片、字体、CSS、媒体等
      return route.abort();
    });

    // 解析并设置 Cookies
    const urlObj = new URL(referer);
    const domain = urlObj.hostname;
    
    const cookiesObj = cookieString.split(';').map(c => c.trim()).reduce((acc, curr) => {
      const [key, ...val] = curr.split('=');
      acc[key] = val.join('=');
      return acc;
    }, {} as Record<string, string>);

    const cookiesToSet = Object.entries(cookiesObj).map(([name, value]) => ({
      name,
      value,
      domain,
      path: '/'
    }));
    
    await context.addCookies(cookiesToSet);

    // 创建页面并导航，触发网页环境和 bdms SDK 的加载
    const page = await context.newPage();
    
    try {
      logger.info(`[BrowserService] 正在加载网页环境: ${referer}`);
      await page.goto(referer, { waitUntil: 'domcontentloaded', timeout: 30000 });
      // 稍微等待一下确保脚本初始化
      await page.waitForTimeout(2000);
      logger.info(`[BrowserService] 网页环境加载完成`);
    } catch (e: any) {
      logger.warn(`[BrowserService] 网页加载可能超时，但将尝试继续: ${e.message}`);
    }

    session = { context, page, lastUsed: Date.now() };
    this.contexts.set(sessionId, session);
    
    return session;
  }

  /**
   * 在浏览器内执行请求，利用 SDK 自动签名
   */
  public async executeGenerateRequest(
    sessionId: string, 
    cookieString: string, 
    referer: string, 
    requestUrl: string, 
    payload: any, 
    headers: any
  ): Promise<any> {
    const { page } = await this.getContext(sessionId, cookieString, referer);

    logger.info(`[BrowserService] 正在浏览器内执行请求: ${requestUrl}`);

    // 使用 page.evaluate 在浏览器上下文中执行 fetch
    // 这样会被页面的 bdms SDK 拦截并加上 a_bogus
    const response = await page.evaluate(async ({ url, body, customHeaders }) => {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/plain, */*',
            ...customHeaders
          },
          body: JSON.stringify(body)
        });
        
        return {
          status: res.status,
          statusText: res.statusText,
          headers: Object.fromEntries(res.headers.entries()),
          data: await res.json().catch(() => null)
        };
      } catch (err: any) {
        return { error: err.message };
      }
    }, { url: requestUrl, body: payload, customHeaders: headers });

    if (response.error) {
      throw new Error(`[BrowserService] Browser Fetch Failed: ${response.error}`);
    }

    return response;
  }

  /**
   * 清理空闲的上下文
   */
  private cleanupIdleContexts() {
    const now = Date.now();
    for (const [sessionId, session] of this.contexts.entries()) {
      if (now - session.lastUsed > this.idleTimeoutMs) {
        logger.info(`[BrowserService] 清理空闲 Session [${sessionId}]`);
        session.context.close().catch(e => logger.warn(`[BrowserService] 关闭上下文失败: ${e.message}`));
        this.contexts.delete(sessionId);
      }
    }

    // 如果没有上下文了，并且浏览器还在运行，关闭浏览器
    if (this.contexts.size === 0 && this.browser) {
      logger.info(`[BrowserService] 无活跃上下文，关闭浏览器实例释放资源`);
      this.browser.close().catch(e => logger.warn(`[BrowserService] 关闭浏览器失败: ${e.message}`));
      this.browser = null;
    }
  }
}

export const browserService = new BrowserService();
