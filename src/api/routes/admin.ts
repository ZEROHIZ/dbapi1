import AccountManager from "@/lib/account-manager.ts";
import SuccessfulBody from "@/lib/response/SuccessfulBody.ts";
import fs from "fs-extra";
import Response from "@/lib/response/Response.ts";
import path from "path";
import environment from "@/lib/environment.ts";
import ResponsePolicyManager from "@/lib/response-policy.ts";
import ModelManager from "@/lib/model-manager.ts";
import TokenCounter from "@/lib/token-counter.ts";
import mediaTaskManager from "@/lib/media-task-manager.ts";
import BrowserProfileManager from "@/lib/browser-profile-manager.ts";

// 读取版本号
const getVersion = async () => {
    try {
        const packageJsonPath = path.join(process.cwd(), 'package.json');
        const packageJson = await fs.readJson(packageJsonPath);
        return packageJson.version || 'unknown';
    } catch {
        return 'unknown';
    }
};

/**
 * 验证管理权限
 * @param req 请求对象
 */
const checkAuth = (req: any) => {
    const password = environment.adminPassword;
    if (!password) return true; // 未设置密码则不验证

    const auth = req.headers['authorization'] || '';
    const token = auth.replace('Bearer ', '');
    return token === password;
};

/**
 * 认证包装器
 */
const withAuth = (fn: Function) => {
    return async (req: any) => {
        if (!checkAuth(req)) {
            return new Response({ code: 401, msg: "Unauthorized: Invalid or missing admin password" }, { statusCode: 401 });
        }
        return await fn(req);
    };
};

const getBrowserAccountOr404 = (id: string) => {
    const account = AccountManager.getBrowserAccountById(id);
    if (!account) {
        return new Response({ code: 404, msg: "Browser account not found" }, { statusCode: 404 });
    }
    return account;
};

const deleteBrowserAccountWithProfileCleanup = async (id: string) => {
    const account = getBrowserAccountOr404(id);
    if (account instanceof Response) return account;
    const cleanup = await BrowserProfileManager.deleteProfileDirectory(account);
    await AccountManager.deleteAccount(id);
    return new SuccessfulBody({ message: "Browser account deleted", cleanup });
};

export default {
    get: {
        '/admin': async () => {
            // ... (同前，不保护页面本身以便加载登录逻辑)
            let filePath = 'public/admin.html';
            if (!await fs.pathExists(filePath)) filePath = path.join(process.cwd(), 'admin.html');
            if (!await fs.pathExists(filePath)) filePath = path.join(process.cwd(), 'public', 'admin.html');

            if (await fs.pathExists(filePath)) {
                const content = await fs.readFile(filePath);
                return new Response(content, { type: 'html', headers: { 'Content-Type': 'text/html; charset=utf-8', Expires: '-1' } });
            }
            return new Response("Admin page not found.", { statusCode: 404 });
        },
        '/admin/accounts': withAuth(async () => {
            const accounts = AccountManager.getAccountsData();
            return new SuccessfulBody(accounts);
        }),
        '/admin/browser-accounts': withAuth(async () => {
            const accounts = AccountManager.getBrowserAccountsData();
            return new SuccessfulBody(accounts);
        }),
        '/admin/stats': withAuth(async () => {
            const stats = AccountManager.getStats();
            return new SuccessfulBody(stats);
        }),
        '/admin/settings': withAuth(async () => {
            const settings = AccountManager.getSettings();
            return new SuccessfulBody(settings);
        }),
        '/admin/version': async () => { // 版本号允许公开查看
            const version = await getVersion();
            return new SuccessfulBody({ version });
        },
        '/admin/policies': withAuth(async () => {
            const policies = ResponsePolicyManager.getPolicies();
            return new SuccessfulBody(policies);
        }),
        '/admin/models': withAuth(async () => {
            const models = ModelManager.getAllModels();
            return new SuccessfulBody(models);
        }),
        '/admin/stats/history': withAuth(async () => {
            const stats = TokenCounter.getStats();
            return new SuccessfulBody({
                hourly: stats.hourly,
                daily: stats.daily
            });
        }),
        '/admin/browser-accounts/:id/fingerprint': withAuth(async (req: any) => {
            const { id } = req.params;
            const account = getBrowserAccountOr404(id);
            if (account instanceof Response) return account;
            let currentAccount: any = account;

            if (!currentAccount.browserFingerprint || Object.keys(currentAccount.browserFingerprint).length === 0) {
                try {
                    const snapshot = await BrowserProfileManager.captureProfileSnapshot(currentAccount, AccountManager.getSettings(), {
                        probeUpstream: false,
                        headless: true
                    });
                    currentAccount = await AccountManager.updateAccount(id, {
                        token: snapshot.token || currentAccount.token,
                        webId: snapshot.webId || currentAccount.webId,
                        deviceId: snapshot.deviceId || currentAccount.deviceId,
                        browserExecutablePath: snapshot.browserPath,
                        browserUserDataDir: snapshot.browserUserDataDir,
                        browserFingerprint: snapshot.browserFingerprint,
                        browserCookies: snapshot.browserCookies,
                        browserStorageState: snapshot.browserStorageState,
                        lastSyncAt: Date.now(),
                        lastLoginDetectedAt: snapshot.probeResult?.isLoginLikely ? Date.now() : currentAccount.lastLoginDetectedAt,
                        sessionIdSource: snapshot.token ? "browser_profile" : currentAccount.sessionIdSource
                    });
                } catch (err: any) {
                    currentAccount = {
                        ...currentAccount,
                        lastProbeError: err.message
                    };
                }
            }

            return new SuccessfulBody(BrowserProfileManager.getStoredFingerprintDetails(currentAccount));
        })
    },
    post: {
        '/admin/login': async (req: any) => {
            const { password } = req.body;
            if (environment.adminPassword && password !== environment.adminPassword) {
                return new Response({ code: 401, msg: "Invalid password" }, { statusCode: 401 });
            }
            return new SuccessfulBody({ message: "Login successful", token: environment.adminPassword || "" });
        },
        '/admin/accounts': withAuth(async (req: any) => {
            try {
                const body = req.body;
                if (!body) throw new Error("Request body is required");
                const { token, name, limitChat, limitImage, limitVideo, limitMusic, ...extra } = body;
                const limits = { 
                    chat: parseInt(limitChat) || -1, 
                    image: parseInt(limitImage) || 60, 
                    video: parseInt(limitVideo) || 0,
                    music: parseInt(limitMusic) || 0
                };
                // 将 token 传入 addAccount，如果 type 为 openai，token 可能是空，由 extra 中的 apiKey 补充
                const newAccount = await AccountManager.addAccount(token || "", name, limits, extra);
                return new SuccessfulBody(newAccount);
            } catch (err: any) {
                return new Response({ code: 400, msg: err.message }, { statusCode: 400 });
            }
        }),
        '/admin/browser-accounts': withAuth(async (req: any) => {
            try {
                const body = req.body || {};
                const account = await AccountManager.addBrowserAccount(body);
                return new SuccessfulBody(account);
            } catch (err: any) {
                return new Response({ code: 400, msg: err.message }, { statusCode: 400 });
            }
        }),
        '/admin/accounts/:id': withAuth(async (req: any) => {
            const { id } = req.params;
            const updates = req.body;
            const updated = await AccountManager.updateAccount(id, updates);
            return new SuccessfulBody(updated);
        }),
        '/admin/browser-accounts/:id': withAuth(async (req: any) => {
            const { id } = req.params;
            const account = getBrowserAccountOr404(id);
            if (account instanceof Response) return account;
            const updated = await AccountManager.updateAccount(id, req.body || {});
            return new SuccessfulBody(updated);
        }),
        '/admin/browser-accounts/:id/open': withAuth(async (req: any) => {
            try {
                const { id } = req.params;
                const account = getBrowserAccountOr404(id);
                if (account instanceof Response) return account;
                const result = await BrowserProfileManager.openProfile(account, AccountManager.getSettings());
                await AccountManager.updateAccount(id, {
                    browserExecutablePath: result.browserPath,
                    browserUserDataDir: result.browserUserDataDir,
                    lastBrowserOpenAt: Date.now()
                });
                return new SuccessfulBody({ message: "Browser opened", ...result });
            } catch (err: any) {
                return new Response({ code: 400, msg: err.message }, { statusCode: 400 });
            }
        }),
        '/admin/browser-accounts/:id/sync-state': withAuth(async (req: any) => {
            try {
                const { id } = req.params;
                const account = getBrowserAccountOr404(id);
                if (account instanceof Response) return account;
                const snapshot = await BrowserProfileManager.captureProfileSnapshot(account, AccountManager.getSettings(), {
                    probeUpstream: false,
                    headless: true
                });
                const updated = await AccountManager.updateAccount(id, {
                    token: snapshot.token || account.token,
                    webId: snapshot.webId || account.webId,
                    deviceId: snapshot.deviceId || account.deviceId,
                    userId: snapshot.userId || account.userId,
                    browserExecutablePath: snapshot.browserPath,
                    browserUserDataDir: snapshot.browserUserDataDir,
                    browserFingerprint: snapshot.browserFingerprint,
                    browserCookies: snapshot.browserCookies,
                    browserStorageState: snapshot.browserStorageState,
                    lastSyncAt: Date.now(),
                    lastLoginDetectedAt: snapshot.probeResult?.isLoginLikely ? Date.now() : account.lastLoginDetectedAt,
                    sessionIdSource: snapshot.token ? "browser_profile" : account.sessionIdSource
                });
                return new SuccessfulBody(updated);
            } catch (err: any) {
                return new Response({ code: 400, msg: err.message }, { statusCode: 400 });
            }
        }),
        '/admin/browser-accounts/:id/probe': withAuth(async (req: any) => {
            try {
                const { id } = req.params;
                const account = getBrowserAccountOr404(id);
                if (account instanceof Response) return account;
                const warmed = await BrowserProfileManager.warmupProfile(account, AccountManager.getSettings(), {
                    headless: AccountManager.getSettings().browserProbeHeadless !== false,
                    stayMs: 8000
                });
                const warmedAccount = await AccountManager.updateAccount(id, {
                    token: warmed.token || account.token,
                    webId: warmed.webId || account.webId,
                    deviceId: warmed.deviceId || account.deviceId,
                    userId: warmed.userId || account.userId,
                    browserExecutablePath: warmed.browserPath,
                    browserUserDataDir: warmed.browserUserDataDir,
                    browserCookies: warmed.browserCookies,
                    browserStorageState: warmed.browserStorageState,
                    lastBrowserOpenAt: Date.now(),
                    lastSyncAt: Date.now(),
                    sessionIdSource: warmed.token ? "browser_profile" : account.sessionIdSource
                });
                const probeResult = await BrowserProfileManager.probeAccountViaApi(warmedAccount || account);
                const updated = await AccountManager.updateAccount(id, {
                    lastProbeAt: Date.now(),
                    lastProbeResult: probeResult,
                    lastProbeError: "",
                    lastLoginDetectedAt: probeResult?.isLoginLikely ? Date.now() : (warmedAccount || account).lastLoginDetectedAt,
                });
                return new SuccessfulBody(updated);
            } catch (err: any) {
                await AccountManager.updateAccount(req.params.id, {
                    lastProbeAt: Date.now(),
                    lastProbeError: err.message,
                    lastProbeResult: { ok: false, error: err.message }
                });
                return new Response({ code: 400, msg: err.message }, { statusCode: 400 });
            }
        }),
        '/admin/browser-accounts/:id/delete': withAuth(async (req: any) => {
            const { id } = req.params;
            return await deleteBrowserAccountWithProfileCleanup(id);
        }),
        '/admin/settings': withAuth(async (req: any) => {
            const settings = req.body;
            await AccountManager.saveSettings(settings);
            return new SuccessfulBody({ message: "Settings saved" });
        }),
        '/admin/reset-all': withAuth(async () => {
            await AccountManager.resetDailyUsage();
            return new SuccessfulBody({ message: "All daily usage reset" });
        }),
        '/admin/policies': withAuth(async (req: any) => {
            const policies = req.body;
            if (!Array.isArray(policies)) {
                return new Response({ code: 400, msg: "Body must be an array of policies" }, { statusCode: 400 });
            }
            await ResponsePolicyManager.savePolicies(policies);
            return new SuccessfulBody({ message: "Policies saved" });
        }),
        '/admin/models': withAuth(async (req: any) => {
            const model = req.body;
            const { oldId } = req.query;
            
            if (!model || !model.id) {
                return new Response({ code: 400, msg: "Model ID is required" }, { statusCode: 400 });
            }

            // 处理重命名：如果提供了原 ID 且与新 ID 不同，则删除旧 ID 记录
            if (oldId && oldId !== model.id) {
                const decodedOldId = decodeURIComponent(oldId as string);
                await ModelManager.deleteModel(decodedOldId);
            }

            await ModelManager.addOrUpdateModel(model, false);
            return new SuccessfulBody({ message: "Model saved" });
        }),
        '/admin/channels/:name/toggle': withAuth(async (req: any) => {
            const { name } = req.params;
            const { enabled } = req.body;
            const decodedName = decodeURIComponent(name);
            const updatedCount = await AccountManager.toggleChannel(decodedName, enabled);
            return new SuccessfulBody({ message: `Toggled ${updatedCount} keys for channel ${decodedName}` });
        }),
        '/admin/restart': withAuth(async () => {
            // Delay exit slightly to allow the response to return
            setTimeout(() => {
                process.exit(0);
            }, 1000);
            return new SuccessfulBody({ message: "Restarting service..." });
        }),
        '/admin/media/clear': withAuth(async () => {
            const paths = await mediaTaskManager.clearLocalMedia();
            return new SuccessfulBody({ message: "Local media files cleared", paths });
        })
    },
    delete: {
        '/admin/channels/:name': withAuth(async (req: any) => {
            const { name } = req.params;
            const decodedName = decodeURIComponent(name);
            const deletedCount = await AccountManager.deleteChannel(decodedName);
            return new SuccessfulBody({ message: `Deleted ${deletedCount} keys for channel ${decodedName}` });
        }),
        '/admin/accounts/:id': withAuth(async (req: any) => {
            const { id } = req.params;
            await AccountManager.deleteAccount(id);
            return new SuccessfulBody({ message: "Account deleted" });
        }),
        '/admin/browser-accounts/:id': withAuth(async (req: any) => {
            const { id } = req.params;
            return await deleteBrowserAccountWithProfileCleanup(id);
        }),
        '/admin/models/:id': withAuth(async (req: any) => {
            const { id } = req.params;
            ModelManager.deleteModel(id);
            return new SuccessfulBody({ message: "Model deleted" });
        })
    }
};
