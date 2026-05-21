import Koa from 'koa';
import KoaRouter from 'koa-router';
import koaRange from 'koa-range';
import koaCors from "koa2-cors";
import koaBody from 'koa-body';
import _ from 'lodash';
import path from 'path';
import fs from 'fs-extra';

import Exception from './exceptions/Exception.ts';
import Request from './request/Request.ts';
import Response from './response/Response.js';
import FailureBody from './response/FailureBody.ts';
import EX from './consts/exceptions.ts';
import logger from './logger.ts';
import { sanitizeLogValue } from './logger.ts';
import config from './config.ts';

class Server {

    app;
    router;
    
    constructor() {
        this.app = new Koa();
        this.app.use(koaCors());
        // 范围请求支持
        this.app.use(koaRange);
        this.router = new KoaRouter({ prefix: config.service.urlPrefix });
        // 前置处理异常拦截
        this.app.use(async (ctx: any, next: Function) => {
            if(ctx.request.type === "application/xml" || ctx.request.type === "application/ssml+xml")
                ctx.req.headers["content-type"] = "text/xml";
            try { await next() }
            catch (err) {
                logger.error(err);
                const failureBody = new FailureBody(err);
                new Response(failureBody).injectTo(ctx);
            }
        });
        // 载荷解析器支持
        this.app.use(koaBody(_.clone(config.system.requestBody)));
        this.app.on("error", (err: any) => {
            // 忽略连接重试、中断、管道、取消错误
            if (["ECONNRESET", "ECONNABORTED", "EPIPE", "ECANCELED"].includes(err.code)) return;
            logger.error(err);
        });
        logger.success("Server initialized");
    }

    /**
     * 附加路由
     * 
     * @param routes 路由列表
     */
    attachRoutes(routes: any[]) {
        routes.forEach((route: any) => {
            const prefix = route.prefix || "";
            for (let method in route) {
                if(method === "prefix") continue;
                if (!_.isObject(route[method])) {
                    logger.warn(`Router ${prefix} ${method} invalid`);
                    continue;
                }
                for (let uri in route[method]) {
                    this.router[method](`${prefix}${uri}`, async ctx => {
                        const { request, response } = await this.#requestProcessing(ctx, route[method][uri]);
                        if(response != null && config.system.requestLog)
                            logger.info(`<- ${request.method} ${request.url} ${response.time - request.time}ms`);
                    });
                }
            }
            logger.info(`Route ${config.service.urlPrefix || ""}${prefix} attached`);
        });
        this.app.use(this.router.routes());
        
        // 静态资源与错误路由拦截
        this.app.use(async (ctx: any) => {
            const request = new Request(ctx);
            const url = ctx.request.url;

            // 1. 简单的静态资源支持 (如果不匹配任何路由)
            if (ctx.method === 'GET') {
                const publicPath = path.join(process.cwd(), 'public', url.split('?')[0]);
                if (await fs.pathExists(publicPath) && (await fs.stat(publicPath)).isFile()) {
                    const content = await fs.readFile(publicPath);
                    const ext = path.extname(publicPath).toLowerCase();
                    const mimeTypes: any = {
                        '.html': 'text/html',
                        '.js': 'text/javascript',
                        '.css': 'text/css',
                        '.json': 'application/json',
                        '.png': 'image/png',
                        '.jpg': 'image/jpeg',
                        '.gif': 'image/gif',
                        '.svg': 'image/svg+xml',
                        '.ico': 'image/x-icon'
                    };
                    ctx.type = mimeTypes[ext] || 'application/octet-stream';
                    ctx.body = content;
                    return;
                }
            }

            // 2. 对于 /v1 开头的请求，但未匹配路由的，给出明确提醒
            if (url.startsWith('/v1/')) {
                const message = `[API 请求有误]: 正确请求为 POST -> /v1/chat/completions，当前请求为 ${ctx.request.method} -> ${ctx.request.url} 请查阅文档确认路径及方法。`;
                logger.warn(message);
                const failureBody = new FailureBody(new Error(message));
                const response = new Response(failureBody);
                response.injectTo(ctx);
                return;
            }

            // 3. 其他未匹配路由且不是 API 的请求，返回 404
            logger.debug(`-> ${ctx.request.method} ${ctx.request.url} 404 Not Found - ${request.remoteIP || "unknown"}`);
            ctx.status = 404;
            ctx.body = "Not Found";
            
            if(config.system.requestLog)
                logger.info(`<- ${request.method} ${request.url} 404`);
        });
    }

    /**
     * 请求处理
     * 
     * @param ctx 上下文
     * @param routeFn 路由方法
     */
    #requestProcessing(ctx: any, routeFn: Function): Promise<any> {
        return new Promise(resolve => {
            const request = new Request(ctx);
            try {
                if(config.system.requestLog) {
                    logger.info(`-> ${request.method} ${request.url}`);
                    if (!_.isEmpty(request.body)) {
                        logger.info("DATA:", sanitizeLogValue(request.body));
                    }
                }
                routeFn(request)
                .then(response => {
                    try {
                        if(!Response.isInstance(response)) {
                            const _response = new Response(response);
                            if (config.system.requestLog && _response.body) {
                                logger.info("REPLY:", sanitizeLogValue(_response.body));
                            }
                            _response.injectTo(ctx);
                            return resolve({ request, response: _response });
                        }
                        if (config.system.requestLog && response.body) {
                            logger.info("REPLY:", sanitizeLogValue(response.body));
                        }
                        response.injectTo(ctx);
                        resolve({ request, response });
                    }
                    catch(err) {
                        logger.error(err);
                        const failureBody = new FailureBody(err);
                        const response = new Response(failureBody);
                        response.injectTo(ctx);
                        resolve({ request, response });
                    }
                })
                .catch(err => {
                    try {
                        logger.error(err);
                        const failureBody = new FailureBody(err);
                        const response = new Response(failureBody);
                        response.injectTo(ctx);
                        resolve({ request, response });
                    }
                    catch(err) {
                        logger.error(err);
                        const failureBody = new FailureBody(err);
                        const response = new Response(failureBody);
                        response.injectTo(ctx);
                        resolve({ request, response });
                    }
                });
            }
            catch(err) {
                logger.error(err);
                const failureBody = new FailureBody(err);
                const response = new Response(failureBody);
                response.injectTo(ctx);
                resolve({ request, response });
            }
        });
    }

    /**
     * 监听端口
     */
    async listen() {
        const host = config.service.host;
        const port = config.service.port;
        await Promise.all([
            new Promise((resolve, reject) => {
                if(host === "0.0.0.0" || host === "localhost" || host === "127.0.0.1")
                    return resolve(null);
                this.app.listen(port, "localhost", err => {
                    if(err) return reject(err);
                    resolve(null);
                });
            }),
            new Promise((resolve, reject) => {
                this.app.listen(port, host, err => {
                    if(err) return reject(err);
                    resolve(null);
                });
            })
        ]);
        logger.success(`Server listening on port ${port} (${host})`);
    }

}

export default new Server();
