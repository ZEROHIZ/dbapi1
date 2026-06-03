import _ from 'lodash';

import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import chat from '@/api/controllers/chat.ts';
import openaiProxy from '@/api/controllers/openai-proxy.ts';
import logger from '@/lib/logger.ts';
import AccountManager from '@/lib/account-manager.ts';
import ModelManager from '@/lib/model-manager.ts';
import APIException from '@/lib/exceptions/APIException.ts';
import FailureBody from '@/lib/response/FailureBody.ts';


export default {

    prefix: '/v1/chat',

    post: {

        '/completions': async (request: Request) => {
            request
                .validate('body.conversation_id', v => _.isUndefined(v) || _.isString(v))
                .validate('body.messages', _.isArray)
                .validate('headers.authorization', _.isString)
            
            const authHeader = request.headers.authorization || "";
            let account: any;
            let isPooled = false;

            // 如果 Authorization 为 Bearer pooled 或者没有提供有效的 sessionid，则使用账号池
            if (authHeader.includes("pooled") || authHeader.length < 20) {
                isPooled = true;
            } else {
                // refresh_token切分
                const tokens = chat.tokenSplit(authHeader);
                // 随机挑选一个refresh_token
                account = _.sample(tokens) || "";
            }

            const {model, conversation_id: convId, messages, stream, tools, auto_delete} = request.body;
            const autoDelete = _.isBoolean(auto_delete) ? auto_delete : true;

            // Bug 2 Fix: 如果是池化模式，提前验证模型是否存在，若不存在则立即返回错误，不进入排队
            if (isPooled && model) {
                const modelConfig = ModelManager.getModelConfig(model);
                if (!modelConfig) {
                    return new Response({ code: 404, msg: `模型 '${model}' 不存在，请检查模型管理配置。` }, { statusCode: 404 });
                }
            }

            // Bug 1 Fix: 解析 backendModel，如果模型有后端映射名，则用于实际API调用
            let resolvedBackendModel = model;
            if (model) {
                const modelConfig = ModelManager.getModelConfig(model);
                if (modelConfig && modelConfig.backendModel) {
                    resolvedBackendModel = modelConfig.backendModel;
                    logger.info(`[ModelRouter] 模型映射: ${model} -> ${resolvedBackendModel}`);
                }
            }

            let assistantId = resolvedBackendModel && /^[a-z0-9]{24,}$/.test(resolvedBackendModel) ? resolvedBackendModel : undefined;
            if (!assistantId && account) {
                const mapped = AccountManager.getMappedModel(account.id, resolvedBackendModel);
                if (mapped && /^[a-z0-9]{24,}$/.test(mapped)) {
                    assistantId = mapped;
                }
            }

            let matchedAccount: any = null;
            if (!isPooled && typeof account === 'string') {
                matchedAccount = AccountManager.getAccountByToken(account);
                if (matchedAccount) {
                    account = matchedAccount;
                }
            }

            const maxRetries = 3;
            let attempt = 0;
            let lastError: any;

            while (attempt < maxRetries) {
                attempt++;
                try {
                    if (isPooled) {
                        // Bug 1 Fix: 使用解析后的后端模型名称来匹配账号池中的支持列表
                        account = await AccountManager.acquireToken('chat', resolvedBackendModel);
                    } else if (matchedAccount) {
                        AccountManager.lockAccount(matchedAccount, 'chat');
                    }
                    
                    if (account && account.type === 'openai') {
                        const result = await openaiProxy.proxyChat(request.body, account); // Changed from proxyImage to proxyChat to match context
                        if (isPooled) AccountManager.releaseToken(account.token);
                        else if (matchedAccount) AccountManager.releaseToken(matchedAccount.token);
                        return result;
                    }

                    if (stream) {
                        const s = await chat.createCompletionStream(messages, account, assistantId, convId, 0, tools, autoDelete, model);
                        
                        // 如果是池化账号，在流结束时释放
                        if (isPooled) {
                            const token = account.token;
                            s.on('end', () => AccountManager.releaseToken(token));
                            s.on('error', () => AccountManager.releaseToken(token));
                        } else if (matchedAccount) {
                            const token = matchedAccount.token;
                            s.on('end', () => AccountManager.releaseToken(token));
                            s.on('error', () => AccountManager.releaseToken(token));
                        }

                        return new Response(s, {
                            type: "text/event-stream",
                            headers: {
                                "Cache-Control": "no-cache, no-transform",
                                "Connection": "keep-alive",
                                "X-Accel-Buffering": "no"
                            }
                        });
                    } else {
                        const res = await chat.createCompletion(messages, account, assistantId, convId, 0, tools, autoDelete, model);
                        if (isPooled) AccountManager.releaseToken(account.token);
                        else if (matchedAccount) AccountManager.releaseToken(matchedAccount.token);
                        return res;
                    }
                } catch (err: any) {
                    lastError = err;
                    let policyAction = 'error';
                    const statusCode = err.errcode || err.status || err.statusCode || err.response?.status;
                    
                    if (isPooled && account) {
                        if (statusCode) {
                            policyAction = AccountManager.applyResponsePolicy(account.id, statusCode);
                        }
                        AccountManager.releaseToken(account.token);
                    } else if (matchedAccount) {
                        AccountManager.releaseToken(matchedAccount.token);
                    }

                    if (err.message && err.message.includes('RETRY_GENERATION_EMPTY')) {
                        policyAction = 'retry';
                    }

                    if (err.message && (err.message.includes('RETRY_GENERATION_LIMIT') || err.message.includes('生成次数已经达到上限'))) {
                        policyAction = 'retry';
                        const targetAccount = isPooled ? account : matchedAccount;
                        if (targetAccount) {
                            targetAccount.usageChat = targetAccount.limitChat > 0 ? targetAccount.limitChat : 99999;
                            await AccountManager.saveAccounts();
                            logger.warn(`[API] 账号 [${targetAccount.name}] 达到对话生成次数上限，已更新用量并保存`);
                        }
                    }

                    if (policyAction === 'retry' && attempt < maxRetries) {
                        logger.warn(`[API] 策略触发重试 (第 ${attempt}/${maxRetries} 次): ${statusCode || err.message}`);
                        continue;
                    }
                    throw err;
                }
            }
            if (lastError instanceof APIException) {
                return new Response(new FailureBody(lastError), { statusCode: lastError.httpStatusCode });
            }
            throw lastError;
        }

    }

}