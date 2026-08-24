/*
  文件职责：后台管理系统 SPA 核心控制器 (admin.js)
  核心职责：
    1. 预加载所有 HTML 模板片段并将其注入主 DOM 中；
    2. 合并所有分页 (Accounts, Browser Accounts, Models, Jimeng Models, Usage, Settings) 的 Vue 3 响应式状态、计算属性及 API 请求方法；
    3. 控制单页面路由切换（通过 URL hash 侦听）与 0ms 零延迟无缝切换体验。
*/

const { createApp, ref, computed, onMounted, nextTick, watch } = Vue;

// 模板加载清单
async function preloadTemplates() {
    const modules = ['accounts', 'browser-accounts', 'models', 'jimeng-models', 'usage', 'settings', 'request-logs', 'playground'];
    await Promise.all(modules.map(async (mod) => {
        try {
            const html = await fetch(`templates/${mod}.html`).then(r => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return r.text();
            });
            const el = document.getElementById(`${mod}-placeholder`);
            if (el) {
                el.outerHTML = html;
            }
        } catch (e) {
            console.error(`加载模块 ${mod} 模板失败:`, e);
        }
    }));
}

// 启动 Vue 应用
preloadTemplates().then(() => {
    createApp({
        setup() {
            // --- 全局及导航状态 ---
            const activePage = ref('dashboard');
            const isDark = ref(document.documentElement.classList.contains('dark'));
            const loading = ref(false);
            const version = ref('V2.1.0-PREMIUM');
            const authorized = ref(false);
            const loginPass = ref('');
            const loginError = ref(null);
            const toasts = ref([]);

            const navItems = [
                { id: 'dashboard', name: '仪表盘', icon: 'layout-dashboard' },
                { id: 'accounts', name: '渠道管理', icon: 'users' },
                { id: 'browser-accounts', name: '浏览器账号', icon: 'monitor' },
                { id: 'models', name: '模型管理', icon: 'box' },
                { id: 'jimeng-models', name: '即梦模型', icon: 'image' },
                { id: 'request-logs', name: '请求日志', icon: 'file-text' },
                { id: 'playground', name: '测试页面', icon: 'play-circle' },
                { id: 'usage', name: '统计分析', icon: 'line-chart' },
                { id: 'settings', name: '系统设置', icon: 'settings' },
            ];

            const currentPageTitle = computed(() => navItems.find(i => i.id === activePage.value)?.name);
            const currentPageDesc = computed(() => {
                const descMap = {
                    dashboard: '系统核心数据看板。',
                    accounts: '实时监控与渠道调度管理。',
                    'browser-accounts': '管理手动登录的浏览器档案与指纹状态。',
                    models: '管理可用的模型版本与上游映射。',
                    'jimeng-models': '管理即梦模型及其 CN/US/ASIA 区域后端映射。',
                    'request-logs': '查看 Flow2API 风格结构化 API 请求 Payload、响应与状态。',
                    playground: '在 Flow2API 风格模型测试广场中可视化调试生成效果。',
                    usage: '多维分析接口消耗趋势。',
                    settings: '全局参数定义与行为约束。'
                };
                return descMap[activePage.value] || '系统管理后台';
            });

            const refreshIcons = (delay = 50) => {
                setTimeout(() => {
                    try {
                        if (window.lucide && typeof window.lucide.createIcons === 'function') {
                            window.lucide.createIcons();
                        }
                    } catch (e) {
                        // 隔离第三方 Lucide 原生 DOM 替换对 Vue 渲染树的干扰
                    }
                }, delay);
            };

            const showToast = (title, msg, type = 'success') => {
                const id = Date.now();
                toasts.value.push({ id, title, msg, type });
                setTimeout(() => {
                    toasts.value = toasts.value.filter(t => t.id !== id);
                    refreshIcons();
                }, 3000);
                refreshIcons();
            };

            const toggleTheme = () => {
                isDark.value = !isDark.value;
                document.documentElement.classList.toggle('dark');
                localStorage.setItem('theme', isDark.value ? 'dark' : 'light');
                refreshIcons();
            };

            const formatNumber = (num) => {
                if (num >= 1000) return (num / 1000).toFixed(1) + 'k';
                return num;
            };

            // --- 鉴权相关 ---
            const getHeaders = () => {
                return {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${localStorage.getItem('admin_pass') || ''}`
                };
            };

            const login = async () => {
                const pass = loginPass.value;
                if (!pass) return;
                try {
                    const res = await fetch('/admin/login', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ password: pass })
                    });
                    const data = await res.json();
                    if (data.code === 0) {
                        localStorage.setItem('admin_pass', pass);
                        authorized.value = true;
                        fetchData();
                    } else {
                        loginError.value = "密码错误，请重试。";
                    }
                } catch (e) {
                    loginError.value = "系统连接异常。";
                }
            };

            const logout = () => {
                localStorage.removeItem('admin_pass');
                authorized.value = false;
                loginPass.value = '';
            };

            // --- 数据源状态 ---
            const stats = ref({
                totalAccounts: 0, enabledAccounts: 0,
                statusCounts: { idle: 0, busy: 0, cooldown: 0 },
                queue: 0, totalTokens: 0, storageUsed: 42
            });
            const accounts = ref([]);
            const models = ref([]);
            const browserAccounts = ref([]);
            const jimengModels = ref([]);
            const settings = ref({
                cooldownTime: 10000,
                defaultModel: 'doubao',
                opendoubaoModel: 'doubao-image',
                videoTimeout: 180000,
                imageGenerationDelayMs: 3000,
                browserProbeIntervalMinutes: 720,
                browserProbeHeadless: true,
                browserExecutablePath: ''
            });
            const policies = ref([]);

            // --- 统计分析与图表相关 ---
            const chartView = ref('day');
            const tokenChartData = ref([]);
            const usageChartData = ref([]);
            const usageChartLabels = ref(['周一', '周二', '周三', '周四', '周五', '周六', '周日']);

            const requestMix = computed(() => {
                const u = stats.value.usage || { chat: 0, image: 0, video: 0, music: 0 };
                const total = u.chat + u.image + u.video + (u.music || 0);
                if (total === 0) return [
                    { name: '对话 (Chat)', value: 0, color: 'bg-indigo-500' },
                    { name: '绘画 (Image)', value: 0, color: 'bg-emerald-500' },
                    { name: '视频 (Video)', value: 0, color: 'bg-orange-500' },
                    { name: '音乐 (Music)', value: 0, color: 'bg-pink-500' },
                ];
                return [
                    { name: '对话 (Chat)', value: Math.round((u.chat / total) * 100), color: 'bg-indigo-500' },
                    { name: '绘画 (Image)', value: Math.round((u.image / total) * 100), color: 'bg-emerald-500' },
                    { name: '视频 (Video)', value: Math.round((u.video / total) * 100), color: 'bg-orange-500' },
                    { name: '音乐 (Music)', value: Math.round(((u.music || 0) / total) * 100), color: 'bg-pink-500' },
                ];
            });

            const resourceEfficiency = computed(() => {
                const total = stats.value.totalAccounts || 0;
                const enabled = stats.value.enabledAccounts || 0;
                const efficiency = total > 0 ? Math.round((enabled / total) * 100) : 0;
                return [
                    { label: '渠道启用率', value: efficiency },
                    { label: '系统稳定性', value: 100 },
                    { label: '服务可用性', value: stats.value.enabledAccounts > 0 ? 100 : 0 }
                ];
            });

            const generateTrendData = async () => {
                try {
                    const res = await fetch('/admin/stats/history', { headers: getHeaders() }).then(r => r.json());
                    const history = res.data || { hourly: {}, daily: {} };

                    if (chartView.value === 'day') {
                        const labels = [];
                        const data = [];
                        const now = new Date();
                        for (let i = 23; i >= 0; i--) {
                            const d = new Date(now.getTime() - i * 3600 * 1000);
                            const hStr = `${d.toISOString().split('T')[0]} ${d.getHours().toString().padStart(2, '0')}:00`;
                            labels.push(`${d.getHours()}:00`);
                            data.push(Math.round((history.hourly[hStr] || 0) / 1000));
                        }
                        usageChartLabels.value = labels;
                        tokenChartData.value = data;
                    } else {
                        const labels = [];
                        const data = [];
                        const now = new Date();
                        const weekDays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
                        for (let i = 6; i >= 0; i--) {
                            const d = new Date(now.getTime() - i * 24 * 3600 * 1000);
                            const dStr = d.toISOString().split('T')[0];
                            labels.push(weekDays[d.getDay()]);
                            data.push(Math.round((history.daily[dStr] || 0) / 1000));
                        }
                        usageChartLabels.value = labels;
                        tokenChartData.value = data;
                    }
                    usageChartData.value = tokenChartData.value.map(v => Math.floor(v * 0.8));
                } catch (e) {
                    console.error("加载趋势数据失败:", e);
                }
            };

            const toggleChartView = (view) => {
                chartView.value = view;
                generateTrendData();
                refreshIcons();
            };

            // --- 渠道管理 (Accounts) 逻辑 ---
            const searchQuery = ref('');
            const channelFilter = ref('all');
            const editingId = ref(null);
            const modal = ref({ show: false, titleCn: '', descCn: '' });
            const newAcc = ref({
                type: 'doubao', name: '', token: '', remark: '',
                apiKey: '', baseUrl: '', weight: 1,
                webId: '', deviceId: '', userId: '',
                limitImage: 60, limitVideo: 0, limitMusic: 0,
                isChat: true, isImage: true, isVideo: false, isMusic: false,
                skipHealthCheck: false,
                models: '', mergePolicy: 'merge'
            });

            const channelNames = computed(() => {
                const names = accounts.value.map(a => a.name).filter(Boolean);
                return [...new Set(names)].sort();
            });

            const filteredAccounts = computed(() => {
                return accounts.value.filter(a => {
                    const matchesSearch = !searchQuery.value ||
                        a.name?.toLowerCase().includes(searchQuery.value.toLowerCase()) ||
                        a.id?.toLowerCase().includes(searchQuery.value.toLowerCase());
                    const matchesChannel = channelFilter.value === 'all' || a.name === channelFilter.value;
                    return matchesSearch && matchesChannel;
                });
            });

            const openModal = (mode, acc = null) => {
                if (mode === 'add') {
                    editingId.value = null;
                    newAcc.value = {
                        type: 'doubao', name: '', token: '', remark: '', apiKey: '', baseUrl: '', weight: 1,
                        webId: '', deviceId: '', userId: '', limitImage: 60, limitVideo: 0, limitMusic: 0,
                        isChat: true, isImage: true, isVideo: false, isMusic: false, skipHealthCheck: false,
                        models: '', mergePolicy: 'merge'
                    };
                    modal.value = {
                        show: true, titleCn: '添加渠道',
                        descCn: '安全地将新的原生或代理渠道加入调度池。'
                    };
                } else {
                    editingId.value = acc.id;
                    newAcc.value = { ...acc };
                    newAcc.value.webId = acc.webId || '';
                    newAcc.value.deviceId = acc.deviceId || '';
                    newAcc.value.userId = acc.userId || '';
                    newAcc.value.mergePolicy = acc.mergePolicy || 'merge';
                    modal.value = {
                        show: true, titleCn: '编辑渠道',
                        descCn: '调整渠道权重分配、额度限制及运行参数。'
                    };
                }
                refreshIcons();
            };

            const closeModal = () => { modal.value.show = false; };

            const submitAccount = async () => {
                if (newAcc.value.type === 'doubao' && !String(newAcc.value.token || '').trim()) {
                    showToast('操作失败', '请先填写 sessionid。', 'error');
                    return;
                }
                if (newAcc.value.type === 'openai' && !String(newAcc.value.apiKey || '').trim()) {
                    showToast('操作失败', '请先填写 API Key。', 'error');
                    return;
                }
                loading.value = true;
                try {
                    let url = '/admin/accounts';
                    if (editingId.value) url = `/admin/accounts/${editingId.value}`;

                    const res = await fetch(url, {
                        method: 'POST',
                        headers: getHeaders(),
                        body: JSON.stringify(newAcc.value)
                    });
                    const data = await res.json();
                    if (!res.ok) throw new Error(data.msg || "操作失败");

                    closeModal();
                    await fetchData();
                    showToast('成功', editingId.value ? '已成功更新渠道配置。' : '渠道已加入调度池。', 'success');
                } catch (e) {
                    showToast('操作异常', e.message, 'error');
                } finally {
                    loading.value = false;
                }
            };

            const toggleAccount = async (acc) => {
                loading.value = true;
                try {
                    const res = await fetch(`/admin/accounts/${acc.id}`, {
                        method: 'POST',
                        headers: getHeaders(),
                        body: JSON.stringify({ enabled: !acc.enabled })
                    });
                    if (!res.ok) throw new Error("Toggle failed");
                    await fetchData();
                    showToast('状态更新', `已${!acc.enabled ? '启动' : '暂停'}渠道。`, 'success');
                } catch (e) {
                    showToast('操作失败', e.message, 'error');
                } finally {
                    loading.value = false;
                }
            };

            const resetAccount = async (id) => {
                loading.value = true;
                try {
                    const res = await fetch(`/admin/accounts/${id}`, {
                        method: 'POST',
                        headers: getHeaders(),
                        body: JSON.stringify({ usageChat: 0, usageImage: 0, usageVideo: 0, usageMusic: 0, totalTokens: 0 })
                    });
                    if (!res.ok) throw new Error("Reset failed");
                    await fetchData();
                    showToast('计数重置', '该渠道今日消耗数据已清空。', 'success');
                } catch (e) {
                    showToast('操作失败', e.message, 'error');
                } finally {
                    loading.value = false;
                }
            };

            const deleteAccount = async (id) => {
                if (!confirm("确定要移除该账号吗？")) return;
                loading.value = true;
                try {
                    const res = await fetch(`/admin/accounts/${id}`, { method: 'DELETE', headers: getHeaders() });
                    const data = await res.json();
                    if (!res.ok) throw new Error(data.msg || '删除失败');
                    await fetchData();
                    showToast('移除成功', '账号已从系统中彻底删除。', 'success');
                } catch (e) {
                    showToast('删除失败', e.message, 'error');
                } finally {
                    loading.value = false;
                }
            };

            const toggleChannelGroup = async (name, enabled) => {
                if (!confirm(`确定要批量${enabled ? '启动' : '暂停'}【${name}】下的所有 API Key 吗？`)) return;
                loading.value = true;
                try {
                    const res = await fetch(`/admin/channels/${encodeURIComponent(name)}/toggle`, {
                        method: 'POST',
                        headers: getHeaders(),
                        body: JSON.stringify({ enabled })
                    });
                    if (!res.ok) throw new Error("Toggle group failed");
                    await fetchData();
                    showToast('批量操作完成', `已${enabled ? '启动' : '暂停'}渠道【${name}】。`, 'success');
                } catch (e) {
                    showToast('操作失败', e.message, 'error');
                } finally {
                    loading.value = false;
                }
            };

            const deleteChannelGroup = async (name) => {
                if (!confirm(`⚠️ 危险操作：确实要彻底注销【${name}】渠道及其下的所有 API Key 吗？此操作不可逆！`)) return;
                loading.value = true;
                try {
                    const res = await fetch(`/admin/channels/${encodeURIComponent(name)}`, {
                        method: 'DELETE',
                        headers: getHeaders()
                    });
                    if (!res.ok) throw new Error("Delete group failed");
                    channelFilter.value = 'all';
                    await fetchData();
                    showToast('批量移除成功', `渠道【${name}】已整体移除。`, 'success');
                } catch (e) {
                    showToast('操作失败', e.message, 'error');
                } finally {
                    loading.value = false;
                }
            };

            const statusStyle = (status) => {
                switch (status) {
                    case 'idle': return 'bg-accent/10 text-accent';
                    case 'busy': return 'bg-primary/10 text-primary';
                    case 'cooldown': return 'bg-warning/10 text-warning';
                    default: return 'bg-slate-500/10 text-slate-500';
                }
            };

            const getStatusCn = (status) => {
                const dict = { idle: '空闲', busy: '繁忙', cooldown: '冷却中' };
                return dict[status] || '未知';
            };

            // --- 浏览器账号 (Browser Accounts) 逻辑 ---
            const browserSearchQuery = ref('');
            const probingAccountIds = ref([]);
            const isProbing = (acc) => probingAccountIds.value.includes(acc.id);

            const filteredBrowserAccounts = computed(() => {
                return browserAccounts.value.filter(a => {
                    const keyword = (browserSearchQuery.value || '').toLowerCase();
                    if (!keyword) return true;
                    return [a.name, a.remark, a.browserProfileId, a.browserUserDataDir, a.id]
                        .filter(Boolean)
                        .some(value => String(value).toLowerCase().includes(keyword));
                });
            });

            const browserEnabledCount = computed(() => browserAccounts.value.filter(acc => acc.enabled).length);
            const browserLoginLikelyCount = computed(() => browserAccounts.value.filter(acc => acc.lastProbeResult?.isLoginLikely).length);

            const editingBrowserId = ref(null);
            const defaultBrowserAccountForm = () => ({
                name: '', remark: '', browserType: 'chromium',
                browserExecutablePath: '', browserUserDataDir: '', enabled: false
            });
            const browserAccountForm = ref(defaultBrowserAccountForm());
            const browserModal = ref({ show: false, titleCn: '', descCn: '' });
            const browserFingerprintModal = ref({
                show: false, title: '', sessionid: '', seed: '', webId: '', deviceId: '', profileDir: '', browserPath: '',
                cookieSummaries: { ttwid: '', sidGuard: '', uidTt: '' }, localStorageKeys: [], sessionStorageKeys: [], items: []
            });

            const openBrowserModal = (mode, acc = null) => {
                if (mode === 'add') {
                    editingBrowserId.value = null;
                    browserAccountForm.value = defaultBrowserAccountForm();
                    browserModal.value = {
                        show: true, titleCn: '新增浏览器账号',
                        descCn: '创建一个持久化 userDataDir，后续用真实浏览器手动登录豆包。'
                    };
                } else {
                    editingBrowserId.value = acc.id;
                    browserAccountForm.value = {
                        name: acc.name || '', remark: acc.remark || '', browserType: acc.browserType || 'chromium',
                        browserExecutablePath: acc.browserExecutablePath || '', browserUserDataDir: acc.browserUserDataDir || '',
                        enabled: !!acc.enabled
                    };
                    browserModal.value = {
                        show: true, titleCn: '编辑浏览器账号', descCn: '调整档案目录、浏览器路径和启用状态。'
                    };
                }
                refreshIcons();
            };

            const closeBrowserModal = () => { browserModal.value.show = false; };

            const submitBrowserAccount = async () => {
                if (!browserAccountForm.value.name || !String(browserAccountForm.value.name).trim()) {
                    showToast('保存失败', '请先填写账号名称。', 'error');
                    return;
                }
                loading.value = true;
                try {
                    let url = '/admin/browser-accounts';
                    if (editingBrowserId.value) url = `/admin/browser-accounts/${editingBrowserId.value}`;
                    const res = await fetch(url, {
                        method: 'POST',
                        headers: getHeaders(),
                        body: JSON.stringify(browserAccountForm.value)
                    });
                    const data = await res.json();
                    if (!res.ok) throw new Error(data.msg || '操作失败');
                    closeBrowserModal();
                    await fetchData();
                    showToast('保存成功', editingBrowserId.value ? '浏览器账号已更新。' : '浏览器账号已创建。', 'success');
                } catch (e) {
                    showToast('保存失败', e.message, 'error');
                } finally {
                    loading.value = false;
                }
            };

            const openBrowserLogin = async (acc) => {
                loading.value = true;
                try {
                    const res = await fetch(`/admin/browser-accounts/${acc.id}/open`, {
                        method: 'POST',
                        headers: getHeaders()
                    });
                    const data = await res.json();
                    if (!res.ok) throw new Error(data.msg || '打开浏览器失败');
                    showToast('浏览器已打开', '请在弹出的浏览器中手动登录豆包，完成后回后台刷新状态。', 'success');
                    await fetchData();
                } catch (e) {
                    showToast('打开失败', e.message, 'error');
                } finally {
                    loading.value = false;
                }
            };

            const syncBrowserState = async (acc) => {
                loading.value = true;
                try {
                    const res = await fetch(`/admin/browser-accounts/${acc.id}/sync-state`, {
                        method: 'POST',
                        headers: getHeaders()
                    });
                    const data = await res.json();
                    if (!res.ok) throw new Error(data.msg || '刷新状态失败');
                    if (data.data) {
                        const index = browserAccounts.value.findIndex(a => a.id === acc.id);
                        if (index !== -1) {
                            browserAccounts.value[index] = data.data;
                        }
                    }
                    showToast('登录态已获取', '已手动从浏览器档案读取 sessionid、存储与指纹摘要。', 'success');
                } catch (e) {
                    showToast('同步失败', e.message, 'error');
                } finally {
                    loading.value = false;
                }
            };

            const addBrowserStateToChannel = async (acc) => {
                loading.value = true;
                try {
                    const res = await fetch(`/admin/browser-accounts/${acc.id}/fingerprint`, {
                        headers: getHeaders()
                    });
                    const data = await res.json();
                    if (!res.ok) throw new Error(data.msg || '读取浏览器登录态失败');
                    const sessionid = String(data.data?.sessionid || '').trim();
                    if (!sessionid) throw new Error('当前浏览器账号还没有可用的 sessionid，请先点击“获取登录态”');
                    const createRes = await fetch('/admin/accounts', {
                        method: 'POST',
                        headers: getHeaders(),
                        body: JSON.stringify({
                            type: 'doubao',
                            name: acc.name || '',
                            token: sessionid,
                            remark: acc.remark || '',
                            weight: 1,
                            webId: String(data.data?.webId || acc.webId || '').trim(),
                            deviceId: String(data.data?.deviceId || acc.deviceId || '').trim(),
                            userId: String(data.data?.userId || acc.userId || '').trim(),
                            limitImage: Number(acc.limitImage ?? 60),
                            limitVideo: Number(acc.limitVideo ?? 0),
                            limitMusic: Number(acc.limitMusic ?? 0),
                            isChat: true,
                            isImage: true,
                            isVideo: false,
                            isMusic: false,
                            skipHealthCheck: false,
                            models: '',
                            mergePolicy: 'merge'
                        })
                    });
                    const createData = await createRes.json();
                    if (!createRes.ok) throw new Error(createData.msg || 'add channel failed');
                    showToast('添加成功', `已将 ${acc.name || '浏览器账号'} 的当前 sessionid 添加到渠道`, 'success');
                } catch (e) {
                    showToast('操作失败', e.message, 'error');
                } finally {
                    loading.value = false;
                }
            };

            const probeBrowserAccount = async (acc) => {
                if (probingAccountIds.value.includes(acc.id)) return;
                probingAccountIds.value.push(acc.id);
                loading.value = true;
                try {
                    const res = await fetch(`/admin/browser-accounts/${acc.id}/probe`, {
                        method: 'POST',
                        headers: getHeaders()
                    });
                    const data = await res.json();
                    if (!res.ok) {
                        if (data.data) {
                            const index = browserAccounts.value.findIndex(a => a.id === acc.id);
                            if (index !== -1) browserAccounts.value[index] = data.data;
                        }
                        throw new Error(data.msg || '探活失败');
                    }
                    if (data.data) {
                        const index = browserAccounts.value.findIndex(a => a.id === acc.id);
                        if (index !== -1) browserAccounts.value[index] = data.data;
                    }
                    showToast('探活完成', data.data?.lastProbeResult?.responseSummary || (data.data?.lastProbeResult?.isLoginLikely ? 'chat 探活正常。' : 'chat 探活未通过，请查看结果摘要。'), 'success');
                } catch (e) {
                    showToast('探活失败', e.message, 'error');
                } finally {
                    probingAccountIds.value = probingAccountIds.value.filter(id => id !== acc.id);
                    loading.value = false;
                }
            };

            const viewBrowserFingerprint = async (acc) => {
                loading.value = true;
                try {
                    const res = await fetch(`/admin/browser-accounts/${acc.id}/fingerprint`, {
                        headers: getHeaders()
                    });
                    const data = await res.json();
                    if (!res.ok) throw new Error(data.msg || '加载指纹详情失败');
                    browserFingerprintModal.value = {
                        show: true,
                        title: `${acc.name || '浏览器账号'} 指纹详情`,
                        sessionid: data.data?.sessionid || '',
                        seed: data.data?.browserFingerprintSeed || '',
                        webId: data.data?.webId || '',
                        deviceId: data.data?.deviceId || '',
                        profileDir: data.data?.browserUserDataDir || '',
                        browserPath: data.data?.browserExecutablePath || '',
                        cookieSummaries: data.data?.cookieSummaries || { ttwid: '', sidGuard: '', uidTt: '' },
                        localStorageKeys: Array.isArray(data.data?.localStorageKeys) ? data.data.localStorageKeys : [],
                        sessionStorageKeys: Array.isArray(data.data?.sessionStorageKeys) ? data.data.sessionStorageKeys : [],
                        items: Array.isArray(data.data?.fingerprintSupport) ? data.data.fingerprintSupport : []
                    };
                } catch (e) {
                    showToast('加载失败', e.message, 'error');
                } finally {
                    loading.value = false;
                }
            };

            const closeBrowserFingerprintModal = () => {
                browserFingerprintModal.value = {
                    show: false, title: '', sessionid: '', seed: '', webId: '', deviceId: '', profileDir: '', browserPath: '',
                    cookieSummaries: { ttwid: '', sidGuard: '', uidTt: '' }, localStorageKeys: [], sessionStorageKeys: [], items: []
                };
            };

            const toggleBrowserAccount = async (acc) => {
                loading.value = true;
                try {
                    const res = await fetch(`/admin/browser-accounts/${acc.id}`, {
                        method: 'POST',
                        headers: getHeaders(),
                        body: JSON.stringify({ enabled: !acc.enabled })
                    });
                    const data = await res.json();
                    if (!res.ok) throw new Error(data.msg || '状态更新失败');
                    await fetchData();
                    showToast('状态已更新', `浏览器账号已${!acc.enabled ? '启用' : '停用'}。`, 'success');
                } catch (e) {
                    showToast('操作失败', e.message, 'error');
                } finally {
                    loading.value = false;
                }
            };

            const deleteBrowserAccount = async (id) => {
                if (!confirm('确定删除该浏览器账号及其档案目录吗？此操作不可逆。')) return;
                loading.value = true;
                try {
                    const res = await fetch(`/admin/browser-accounts/${id}/delete`, {
                        method: 'POST',
                        headers: getHeaders()
                    });
                    const data = await res.json();
                    if (!res.ok) throw new Error(data.msg || '删除失败');
                    await fetchData();
                    showToast('删除成功', '浏览器账号与档案清理请求已完成。', 'success');
                } catch (e) {
                    showToast('删除失败', e.message, 'error');
                } finally {
                    loading.value = false;
                }
            };

            const formatDateTime = (value) => {
                if (!value) return '尚未执行';
                const date = new Date(value);
                if (Number.isNaN(date.getTime())) return '尚未执行';
                return date.toLocaleString('zh-CN', { hour12: false });
            };

            const probeStatusStyle = (acc) => {
                if (probingAccountIds.value.includes(acc.id)) return 'bg-indigo-500/10 text-indigo-500 animate-pulse';
                if (acc.lastProbeError) return 'bg-danger/10 text-danger';
                if (acc.lastProbeResult?.isLoginLikely) return 'bg-accent/10 text-accent';
                if (acc.lastProbeAt) return 'bg-warning/10 text-warning';
                if (acc.lastSyncAt) return 'bg-slate-500/10 text-slate-500';
                return 'bg-slate-500/10 text-slate-500';
            };

            const probeStatusText = (acc) => {
                if (probingAccountIds.value.includes(acc.id)) return '探活中...';
                if (acc.lastProbeError) return '探活失败';
                if (acc.lastProbeResult?.isLoginLikely) return '探活正常';
                if (acc.lastProbeAt) return '探活未通过';
                if (acc.lastSyncAt) return '已同步待探活';
                return '未探活';
            };

            // --- 模型管理 (Models) 逻辑 ---
            const modelSearchQuery = ref('');
            const modelEnabledFilter = ref('all');
            const modelModal = ref({ show: false, isEdit: false });
            const currentModel = ref({ id: '', backendModel: '', type: 'chat', owned_by: 'doubao-free-api', enabled: true, object: 'model' });
            const originalModelId = ref('');

            const filteredModels = computed(() => {
                return models.value.filter(m => {
                    const matchesSearch = !modelSearchQuery.value || m.id.toLowerCase().includes(modelSearchQuery.value.toLowerCase());
                    const matchesStatus = modelEnabledFilter.value === 'all' ||
                        (modelEnabledFilter.value === 'enabled' && m.enabled) ||
                        (modelEnabledFilter.value === 'disabled' && !m.enabled);
                    return matchesSearch && matchesStatus;
                });
            });

            const openModelModal = (mode, m = null) => {
                modelModal.value.show = true;
                modelModal.value.isEdit = mode === 'edit';
                originalModelId.value = m ? m.id : '';
                if (m) currentModel.value = { ...m };
                else currentModel.value = { id: '', backendModel: '', type: 'chat', owned_by: 'doubao-free-api', enabled: true, object: 'model' };
                refreshIcons();
            };

            const saveModel = async () => {
                try {
                    const url = `/admin/models${modelModal.value.isEdit && originalModelId.value ? '?oldId=' + encodeURIComponent(originalModelId.value) : ''}`;
                    const res = await fetch(url, {
                        method: 'POST',
                        headers: getHeaders(),
                        body: JSON.stringify(currentModel.value)
                    });
                    if (res.ok) {
                        showToast('保存成功', '模型配置已更新。', 'success');
                        modelModal.value.show = false;
                        fetchData();
                    } else {
                        let errMsg = `HTTP ${res.status}`;
                        try { const errBody = await res.json(); errMsg = errBody.msg || errBody.message || errMsg; } catch { }
                        showToast('保存失败', errMsg, 'error');
                    }
                } catch (e) { showToast('保存失败', e.message, 'error'); }
            };

            const deleteModel = async (id) => {
                if (!confirm('确定删除该模型吗？')) return;
                try {
                    const res = await fetch(`/admin/models/${id}`, { method: 'DELETE', headers: getHeaders() });
                    if (res.ok) {
                        showToast('删除成功', '模型已移除。', 'success');
                        fetchData();
                    }
                } catch (e) { showToast('删除失败', e.message, 'error'); }
            };

            const toggleModelEnabled = async (m) => {
                loading.value = true;
                try {
                    const res = await fetch('/admin/models', {
                        method: 'POST',
                        headers: getHeaders(),
                        body: JSON.stringify({ ...m, enabled: !m.enabled })
                    });
                    if (res.ok) {
                        showToast('状态更新', `已${!m.enabled ? '启用' : '禁用'}模型。`, 'success');
                        fetchData();
                    }
                } catch (e) { showToast('操作失败', e.message, 'error'); }
                finally { loading.value = false; }
            };

            // --- 即梦模型 (Jimeng Models) 逻辑 ---
            const jimengModelSearchQuery = ref('');
            const jimengModelEnabledFilter = ref('all');
            const jimengModelModal = ref({ show: false, isEdit: false });
            const currentJimengModel = ref({ id: '', type: 'image', enabled: true, mappings: { cn: '', us: '', asia: '' }, description: '', object: 'model' });
            const originalJimengModelId = ref('');

            const filteredJimengModels = computed(() => {
                return jimengModels.value.filter(m => {
                    const matchesSearch = !jimengModelSearchQuery.value || m.id.toLowerCase().includes(jimengModelSearchQuery.value.toLowerCase());
                    const matchesStatus = jimengModelEnabledFilter.value === 'all' ||
                        (jimengModelEnabledFilter.value === 'enabled' && m.enabled) ||
                        (jimengModelEnabledFilter.value === 'disabled' && !m.enabled);
                    return matchesSearch && matchesStatus;
                });
            });

            const openJimengModelModal = (mode, m = null) => {
                jimengModelModal.value.show = true;
                jimengModelModal.value.isEdit = mode === 'edit';
                originalJimengModelId.value = m ? m.id : '';
                if (m) currentJimengModel.value = { ...m, mappings: m.mappings ? { ...m.mappings } : { cn: '', us: '', asia: '' } };
                else currentJimengModel.value = { id: '', type: 'image', enabled: true, mappings: { cn: '', us: '', asia: '' }, description: '', object: 'model' };
                refreshIcons();
            };

            const saveJimengModel = async () => {
                try {
                    const url = `/admin/jimeng-models${jimengModelModal.value.isEdit && originalJimengModelId.value ? '?oldId=' + encodeURIComponent(originalJimengModelId.value) : ''}`;
                    const res = await fetch(url, {
                        method: 'POST',
                        headers: getHeaders(),
                        body: JSON.stringify(currentJimengModel.value)
                    });
                    if (res.ok) {
                        showToast('保存成功', '即梦模型配置已更新。', 'success');
                        jimengModelModal.value.show = false;
                        fetchData();
                    } else {
                        let errMsg = `HTTP ${res.status}`;
                        try { const errBody = await res.json(); errMsg = errBody.msg || errBody.message || errMsg; } catch { }
                        showToast('保存失败', errMsg, 'error');
                    }
                } catch (e) { showToast('保存失败', e.message, 'error'); }
            };

            const deleteJimengModel = async (id) => {
                if (!confirm('确定删除该即梦模型吗？')) return;
                try {
                    const res = await fetch(`/admin/jimeng-models/${id}`, { method: 'DELETE', headers: getHeaders() });
                    if (res.ok) {
                        showToast('删除成功', '即梦模型已移除。', 'success');
                        fetchData();
                    }
                } catch (e) { showToast('删除失败', e.message, 'error'); }
            };

            const toggleJimengModelEnabled = async (m) => {
                loading.value = true;
                try {
                    const res = await fetch('/admin/jimeng-models', {
                        method: 'POST',
                        headers: getHeaders(),
                        body: JSON.stringify({ ...m, enabled: !m.enabled })
                    });
                    if (res.ok) {
                        showToast('状态更新', `已${!m.enabled ? '启用' : '禁用'}即梦模型。`, 'success');
                        fetchData();
                    }
                } catch (e) { showToast('操作失败', e.message, 'error'); }
                finally { loading.value = false; }
            };

            // --- 系统设置 (Settings) 逻辑 ---
            const passChange = ref('');

            const seedreamModelOptions = computed(() => {
                const seen = new Set();
                return models.value
                    .filter(m => `${m.id || ''} ${m.backendModel || ''}`.toLowerCase().includes('seedream'))
                    .map(m => String(m.backendModel || m.id || '').trim())
                    .filter(value => {
                        if (!value || seen.has(value)) return false;
                        seen.add(value);
                        return true;
                    })
                    .map(value => ({ value, label: value }));
            });

            const saveSettings = async () => {
                const payload = { ...settings.value };
                if (passChange.value) payload.adminPassword = passChange.value;
                try {
                    const res = await fetch('/admin/settings', {
                        method: 'POST',
                        headers: getHeaders(),
                        body: JSON.stringify(payload)
                    });
                    if (res.ok) {
                        if (passChange.value) {
                            localStorage.setItem('admin_pass', passChange.value);
                            passChange.value = '';
                        }
                        showToast('配置成功', '全局系统行为已更新。', 'success');
                        fetchData();
                    }
                } catch (e) {
                    showToast('更新失败', '网络错误或系统无权。', 'error');
                }
            };

            const restartService = async () => {
                if (!confirm("确定要重启服务吗？此操作会导致服务短暂断开。")) return;
                try {
                    const res = await fetch('/admin/restart', {
                        method: 'POST',
                        headers: getHeaders()
                    });
                    if (res.ok) {
                        showToast('服务重启中', '服务端进程被终止并重启，稍后将自动刷新页面。', 'success');
                        setTimeout(() => {
                            window.location.reload();
                        }, 3000);
                    } else {
                        showToast('操作失败', '服务端拒绝了请求。', 'error');
                    }
                } catch (e) {
                    showToast('操作提示', '已发起重启操作（连接断开属正常现象）。', 'warning');
                    setTimeout(() => {
                        window.location.reload();
                    }, 3000);
                }
            };

            const resetAllUsage = async () => {
                if (!confirm('确定要重置所有账号的统计数据吗？')) return;
                await fetch('/admin/reset-all', { method: 'POST', headers: getHeaders() });
                fetchData();
                showToast('全部重置', '系统内所有消耗计数已归零。', 'success');
            };

            const clearLocalMedia = async () => {
                if (!confirm('确定要删除本地保存的图片、视频和异步任务记录吗？')) return;
                try {
                    const res = await fetch('/admin/media/clear', { method: 'POST', headers: getHeaders() });
                    if (!res.ok) throw new Error('Clear local media failed');
                    showToast('清理完成', '本地图片、视频和任务记录已清理。', 'success');
                } catch (e) {
                    showToast('清理失败', e.message, 'error');
                }
            };

            const addPolicy = () => {
                policies.value.push({ statusCode: 0, action: 'retry', description: '', applyTo: 'all' });
                refreshIcons();
            };

            const removePolicy = (idx) => {
                policies.value.splice(idx, 1);
            };

            const savePolicies = async () => {
                try {
                    const res = await fetch('/admin/policies', {
                        method: 'POST',
                        headers: getHeaders(),
                        body: JSON.stringify(policies.value)
                    });
                    if (res.ok) {
                        showToast('策略已保存', '响应码处理规则已更新。', 'success');
                        fetchData();
                    } else {
                        showToast('保存失败', '服务端拒绝了请求。', 'error');
                    }
                } catch (e) {
                    showToast('保存失败', '网络错误。', 'error');
                }
            };

            // --- 数据拉取入口 ---
            const fetchData = async () => {
                if (!authorized.value) return;
                loading.value = true;
                try {
                    const [
                        statsRes,
                        verRes,
                        accRes,
                        modRes,
                        browserRes,
                        jimengRes,
                        setRes,
                        polRes
                    ] = await Promise.all([
                        fetch('/admin/stats', { headers: getHeaders() }).then(r => r.json()),
                        fetch('/admin/version', { headers: getHeaders() }).then(r => r.json()).catch(() => ({ data: { version: version.value } })),
                        fetch('/admin/accounts', { headers: getHeaders() }).then(r => r.json()),
                        fetch('/admin/models', { headers: getHeaders() }).then(r => r.json()),
                        fetch('/admin/browser-accounts', { headers: getHeaders() }).then(r => r.json()).catch(() => ({ data: [] })),
                        fetch('/admin/jimeng-models', { headers: getHeaders() }).then(r => r.json()).catch(() => ({ data: [] })),
                        fetch('/admin/settings', { headers: getHeaders() }).then(r => r.json()).catch(() => ({ data: {} })),
                        fetch('/admin/policies', { headers: getHeaders() }).then(r => r.json()).catch(() => ({ data: [] }))
                    ]);

                    stats.value = statsRes.data || stats.value;
                    version.value = (verRes.data && verRes.data.version) || version.value;
                    accounts.value = accRes.data || [];
                    models.value = modRes.data || [];
                    browserAccounts.value = browserRes.data || [];
                    jimengModels.value = jimengRes.data || [];
                    settings.value = setRes.data || settings.value;
                    policies.value = polRes.data || [];

                    await generateTrendData();
                } catch (e) {
                    showToast('同步失败', '鉴权失效或服务器离线。', 'error');
                    if (e.message?.includes('401')) logout();
                } finally {
                    loading.value = false;
                    refreshIcons();
                }
            };

            // --- 生命周期初始化 ---
            onMounted(() => {
                // 读取 Hash 初始路由
                const hash = window.location.hash.replace('#', '');
                if (hash && navItems.some(i => i.id === hash)) {
                    activePage.value = hash;
                }

                const savedPass = localStorage.getItem('admin_pass');
                if (savedPass) {
                    authorized.value = true;
                    fetchData();
                } else {
                    refreshIcons();
                }

                if (localStorage.getItem('theme') === 'dark' || (!('theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
                    document.documentElement.classList.add('dark');
                    isDark.value = true;
                } else {
                    document.documentElement.classList.remove('dark');
                    isDark.value = false;
                }
                window.addEventListener('hashchange', () => {
                    const h = window.location.hash.replace('#', '');
                    if (h && navItems.some(i => i.id === h)) {
                        activePage.value = h;
                    }
                });
                refreshIcons();
            });

                // --- 结构化请求日志 (Request Logs) 逻辑 ---
                const requestLogs = ref([]);
                const logSearchQuery = ref('');
                const logActionFilter = ref('all');
                const logStatusFilter = ref('all');
                const requestLogsPagination = ref({ page: 1, pageSize: 20, totalPages: 1, total: 0 });
                const logDetailModal = ref({ show: false, data: null });

                const fetchRequestLogs = async (page = 1) => {
                    try {
                        const params = new URLSearchParams({
                            page: String(page),
                            pageSize: '20',
                            keyword: logSearchQuery.value || '',
                            action: logActionFilter.value || 'all',
                            status: logStatusFilter.value || 'all'
                        });
                        const res = await fetch(`/admin/request-logs?${params.toString()}`, { headers: getHeaders() });
                        const data = await res.json();
                        if (data.code === 0 && data.data) {
                            requestLogs.value = data.data.items || [];
                            requestLogsPagination.value = {
                                page: data.data.page,
                                pageSize: data.data.pageSize,
                                totalPages: data.data.totalPages,
                                total: data.data.total
                            };
                        }
                    } catch (e) {
                        console.error('加载请求日志失败:', e);
                    }
                };

                const filteredRequestLogs = computed(() => requestLogs.value);

                const changeLogPage = (newPage) => {
                    if (newPage < 1 || newPage > requestLogsPagination.value.totalPages) return;
                    fetchRequestLogs(newPage);
                };

                const openLogDetailModal = (log) => {
                    logDetailModal.value = { show: true, data: log };
                    refreshIcons();
                };

                const closeLogDetailModal = () => {
                    logDetailModal.value = { show: false, data: null };
                };

                const clearRequestLogs = async () => {
                    if (!confirm('确定要清空所有已保存的结构化请求日志吗？')) return;
                    try {
                        const res = await fetch('/admin/request-logs', { method: 'DELETE', headers: getHeaders() });
                        if (res.ok) {
                            showToast('日志已清空', '所有结构化 API 请求日志已移除。', 'success');
                            fetchRequestLogs(1);
                        }
                    } catch (e) {
                        showToast('清空失败', e.message, 'error');
                    }
                };

                const isImageUrl = (url) => typeof url === 'string' && (/\.(png|jpe?g|gif|webp)(\?.*)?$/i.test(url) || url.startsWith('data:image/'));
                const isVideoUrl = (url) => typeof url === 'string' && (/\.(mp4|webm|mov)(\?.*)?$/i.test(url) || url.startsWith('data:video/'));
                const isAudioUrl = (url) => typeof url === 'string' && (/\.(mp3|wav|ogg)(\?.*)?$/i.test(url) || url.startsWith('data:audio/'));

                const extractedMediaUrls = (log) => {
                    if (!log || !log.responseData) return [];
                    const urls = [];
                    const data = log.responseData;
                    if (Array.isArray(data.data)) {
                        data.data.forEach(item => {
                            if (item?.url) urls.push(item.url);
                            if (item?.b64_json) urls.push(`data:image/png;base64,${item.b64_json}`);
                        });
                    }
                    if (Array.isArray(data.choices) && data.choices[0]?.message?.images) {
                        data.choices[0].message.images.forEach(u => urls.push(u));
                    }
                    if (data.url) urls.push(data.url);
                    return [...new Set(urls)].filter(Boolean);
                };

                // --- 模型测试 Playground 逻辑 ---
                const playgroundConfig = ref({
                    apiKey: localStorage.getItem('admin_pass') || '',
                    baseUrl: window.location.origin
                });
                const selectedTestModel = ref(null);
                const testPrompt = ref('一只可爱的橘猫趴在窗台上晒太阳，窗外是手绘野花盛开的春天');
                const uploadedImages = ref([]);
                const testStatus = ref('idle');
                const testStatusText = ref('等待中');
                const testOutputLog = ref('');
                const testResultText = ref('');
                const testResultMedia = ref([]);
                const testGenerating = ref(false);
                const testDuration = ref(0);
                const collapsedCategories = ref({});

                const availableTestModels = computed(() => {
                    const all = [];
                    models.value.forEach(m => all.push({ id: m.id, type: m.type || 'chat', backendModel: m.backendModel }));
                    jimengModels.value.forEach(m => all.push({ id: m.id, type: m.type || 'image', backendModel: 'Jimeng ' + (m.type || 'image') }));
                    if (all.length === 0) {
                        return [
                            { id: 'doubao-image', type: 'image', backendModel: 'Seedream 4.5' },
                            { id: 'doubao-pro', type: 'chat', backendModel: 'Doubao Pro' },
                            { id: 'doubao', type: 'chat', backendModel: 'Doubao Chat' }
                        ];
                    }
                    return all;
                });

                const categorisedModels = computed(() => {
                    const cats = {
                        '图片生成 (Image)': availableTestModels.value.filter(m => m.type === 'image'),
                        '对话模型 (Chat)': availableTestModels.value.filter(m => m.type === 'chat'),
                        '视频生成 (Video)': availableTestModels.value.filter(m => m.type === 'video'),
                        '音乐生成 (Music)': availableTestModels.value.filter(m => m.type === 'music'),
                    };
                    const result = {};
                    for (const [k, v] of Object.entries(cats)) {
                        if (v.length > 0) result[k] = v;
                    }
                    return result;
                });

                const toggleCategoryCollapse = (catName) => {
                    collapsedCategories.value[catName] = !collapsedCategories.value[catName];
                };

                const getModelTagStyle = (type) => {
                    switch (type) {
                        case 'image': return 'bg-emerald-500/10 text-emerald-500';
                        case 'chat': return 'bg-indigo-500/10 text-indigo-500';
                        case 'video': return 'bg-orange-500/10 text-orange-500';
                        case 'music': return 'bg-pink-500/10 text-pink-500';
                        default: return 'bg-slate-500/10 text-slate-500';
                    }
                };

                const getModelTagLabel = (type) => {
                    const map = { image: '图片', chat: '对话', video: '视频', music: '音乐' };
                    return map[type] || '其他';
                };

                const selectTestModel = (m) => {
                    selectedTestModel.value = m;
                    testStatus.value = 'idle';
                    testStatusText.value = '就绪';
                    testOutputLog.value = `已选择模型 ${m.id} (${m.type})。点击生成按钮发起测试...`;
                    testResultMedia.value = [];
                    testResultText.value = '';
                };

                const getSubmitButtonText = () => {
                    if (!selectedTestModel.value) return '请先在左侧选择模型';
                    const type = selectedTestModel.value.type;
                    if (type === 'image') return '🎨 生成图片效果';
                    if (type === 'video') return '🎬 发起视频生成';
                    if (type === 'music') return '🎵 生成音乐创作';
                    return '💬 发送对话消息';
                };

                const fileInputRef = ref(null);
                const triggerFileInput = () => {
                    if (fileInputRef.value) fileInputRef.value.click();
                };

                const handleImageFiles = (e) => {
                    const files = e.target.files;
                    if (!files) return;
                    for (let i = 0; i < files.length; i++) {
                        const file = files[i];
                        if (!file.type.startsWith('image/')) continue;
                        const reader = new FileReader();
                        reader.onload = (evt) => {
                            uploadedImages.value.push(evt.target.result);
                        };
                        reader.readAsDataURL(file);
                    }
                    e.target.value = '';
                };

                const removeUploadedImage = (idx) => {
                    uploadedImages.value.splice(idx, 1);
                };

                const startModelTest = async () => {
                    if (!selectedTestModel.value || testGenerating.value) return;

                    const apiKey = playgroundConfig.value.apiKey || localStorage.getItem('admin_pass') || '';
                    const baseUrl = playgroundConfig.value.baseUrl || window.location.origin;
                    const prompt = testPrompt.value.trim();

                    if (!prompt) {
                        showToast('提示', '请先输入提示词 Prompt。', 'error');
                        return;
                    }

                    testGenerating.value = true;
                    testStatus.value = 'running';
                    testStatusText.value = '生成中...';
                    testOutputLog.value = `[${new Date().toLocaleTimeString()}] 模型: ${selectedTestModel.value.id}\n[${new Date().toLocaleTimeString()}] 发起 API 请求中...\n`;
                    testResultMedia.value = [];
                    testResultText.value = '';

                    const startTime = Date.now();
                    try {
                        const modelType = selectedTestModel.value.type;
                        let endpoint = `${baseUrl}/v1/chat/completions`;
                        let bodyPayload = {};

                        if (modelType === 'image') {
                            endpoint = `${baseUrl}/v1/images/generations`;
                            bodyPayload = {
                                model: selectedTestModel.value.id,
                                prompt: prompt,
                                ratio: '1:1',
                                stream: false,
                                image: uploadedImages.value.length > 0 ? (uploadedImages.value.length === 1 ? uploadedImages.value[0] : uploadedImages.value) : undefined
                            };
                        } else if (modelType === 'video') {
                            endpoint = `${baseUrl}/v1/video/generations`;
                            bodyPayload = {
                                model: selectedTestModel.value.id,
                                prompt: prompt,
                                ratio: '16:9',
                                duration: 5,
                                stream: false,
                                image: uploadedImages.value.length > 0 ? (uploadedImages.value.length === 1 ? uploadedImages.value[0] : uploadedImages.value) : undefined
                            };
                        } else if (modelType === 'music') {
                            endpoint = `${baseUrl}/v1/music/generations`;
                            bodyPayload = {
                                model: selectedTestModel.value.id,
                                prompt: prompt,
                                stream: false
                            };
                        } else {
                            const messagesContent = uploadedImages.value.length > 0 ? [
                                { type: 'text', text: prompt },
                                ...uploadedImages.value.map(url => ({ type: 'image_url', image_url: { url } }))
                            ] : prompt;

                            bodyPayload = {
                                model: selectedTestModel.value.id,
                                messages: [{ role: 'user', content: messagesContent }],
                                stream: true
                            };
                        }

                        const res = await fetch(endpoint, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Authorization': `Bearer ${apiKey}`
                            },
                            body: JSON.stringify(bodyPayload)
                        });

                        if (!res.ok) {
                            const errText = await res.text();
                            throw new Error(`HTTP ${res.status}: ${errText}`);
                        }

                        if (modelType === 'image') {
                            const result = await res.json();
                            const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
                            testDuration.value = Number(elapsed);
                            testOutputLog.value += `\n[${new Date().toLocaleTimeString()}] 请求成功，耗时 ${elapsed}s\n`;
                            
                            const mediaList = [];
                            if (Array.isArray(result.data)) {
                                result.data.forEach(item => {
                                    if (item.url) mediaList.push({ type: 'image', url: item.url });
                                    if (item.b64_json) mediaList.push({ type: 'image', url: `data:image/png;base64,${item.b64_json}` });
                                });
                            } else if (result.choices?.[0]?.message?.images) {
                                result.choices[0].message.images.forEach(u => mediaList.push({ type: 'image', url: u }));
                            }
                            testResultMedia.value = mediaList;
                            testStatus.value = 'done';
                            testStatusText.value = `完成 (${elapsed}s)`;
                        } else if (modelType === 'video' || modelType === 'music') {
                            const result = await res.json();
                            const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
                            testDuration.value = Number(elapsed);
                            testOutputLog.value += `\n[${new Date().toLocaleTimeString()}] 请求成功，耗时 ${elapsed}s\n`;

                            const mediaList = [];
                            if (modelType === 'video') {
                                if (result.choices?.[0]?.message?.videos) {
                                    result.choices[0].message.videos.forEach(v => mediaList.push({ type: 'video', url: v.url, cover: v.cover }));
                                } else if (Array.isArray(result.data)) {
                                    result.data.forEach(v => mediaList.push({ type: 'video', url: v.url }));
                                }
                            } else if (modelType === 'music') {
                                if (result.choices?.[0]?.message?.music) {
                                    result.choices[0].message.music.forEach(m => mediaList.push({ type: 'audio', url: m.url }));
                                } else if (Array.isArray(result.data)) {
                                    result.data.forEach(m => mediaList.push({ type: 'audio', url: m.url }));
                                }
                            }
                            testResultMedia.value = mediaList;
                            testStatus.value = 'done';
                            testStatusText.value = `生成完成 (${elapsed}s)`;
                        } else if (bodyPayload.stream) {
                            const reader = res.body.getReader();
                            const decoder = new TextDecoder();
                            let fullText = '';
                            let buffer = '';

                            while (true) {
                                const { done, value } = await reader.read();
                                if (value) {
                                    buffer += decoder.decode(value, { stream: true });
                                    const lines = buffer.split('\n');
                                    buffer = lines.pop() || '';

                                    for (const line of lines) {
                                        const trimmed = line.trim();
                                        if (!trimmed.startsWith('data: ')) continue;
                                        const dataStr = trimmed.slice(6).trim();
                                        if (dataStr === '[DONE]') break;
                                        try {
                                            const parsed = JSON.parse(dataStr);
                                            const delta = parsed.choices?.[0]?.delta?.content || parsed.choices?.[0]?.message?.content || '';
                                            if (delta) {
                                                fullText += delta;
                                                testOutputLog.value += delta;
                                            }
                                        } catch {}
                                    }
                                }
                                if (done) break;
                            }

                            if (buffer.trim().startsWith('data: ')) {
                                const dataStr = buffer.trim().slice(6).trim();
                                if (dataStr !== '[DONE]') {
                                    try {
                                        const parsed = JSON.parse(dataStr);
                                        const delta = parsed.choices?.[0]?.delta?.content || parsed.choices?.[0]?.message?.content || '';
                                        if (delta) {
                                            fullText += delta;
                                            testOutputLog.value += delta;
                                        }
                                    } catch {}
                                }
                            }

                            const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
                            testDuration.value = Number(elapsed);
                            testResultText.value = fullText;
                            testStatus.value = 'done';
                            testStatusText.value = `打字机响应完成 (${elapsed}s)`;
                        } else {
                            const result = await res.json();
                            const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
                            testDuration.value = Number(elapsed);
                            testOutputLog.value += `\n[${new Date().toLocaleTimeString()}] 收到返回结果\n`;
                            testResultText.value = JSON.stringify(result, null, 2);
                            testStatus.value = 'done';
                            testStatusText.value = `完成 (${elapsed}s)`;
                        }

                        // 刷新日志列表
                        fetchRequestLogs(1);

                    } catch (err) {
                        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
                        testDuration.value = Number(elapsed);
                        testOutputLog.value += `\n❌ 测试报错: ${err.message}\n`;
                        testStatus.value = 'error';
                        testStatusText.value = '测试失败';
                    } finally {
                        testGenerating.value = false;
                    }
                };

                // 受控的单向页面切换方法，彻底杜绝 Watcher 与 hashchange 的递归冲突
                const switchPage = (pageId) => {
                    if (!pageId) return;
                    activePage.value = pageId;
                    try {
                        history.replaceState(null, '', `#${pageId}`);
                    } catch {}
                    refreshIcons(50);
                    if (pageId === 'request-logs') {
                        fetchRequestLogs(1);
                    }
                };

            return {
                // 全局 & UI
                activePage, switchPage, isDark, loading, version, authorized, loginPass, loginError, toasts, navItems, currentPageTitle, currentPageDesc,
                toggleTheme, login, logout, fetchData, formatNumber, showToast,

                // 仪表盘
                stats, requestMix, tokenChartData, chartView, usageChartLabels, toggleChartView,

                // 渠道管理 (Accounts)
                accounts, searchQuery, channelFilter, channelNames, filteredAccounts, newAcc, editingId, modal,
                openModal, closeModal, submitAccount, toggleAccount, resetAccount, deleteAccount, toggleChannelGroup, deleteChannelGroup,
                addSupportedModel: (e) => {
                    const val = e.target.value;
                    if (!val) return;
                    const newModels = val.split(/[,，]/).map(m => m.trim()).filter(Boolean);
                    const current = (newAcc.value.models || '').split(/[,，]/).map(m => m.trim()).filter(Boolean);
                    let updated = false;
                    for (const newMod of newModels) {
                        if (!current.includes(newMod)) {
                            current.push(newMod);
                            updated = true;
                        }
                    }
                    if (updated) {
                        newAcc.value.models = current.join(', ');
                    }
                    e.target.value = '';
                },
                removeSupportedModel: (mod) => {
                    const current = (newAcc.value.models || '').split(/[,，]/).map(m => m.trim()).filter(Boolean);
                    newAcc.value.models = current.filter(m => m !== mod).join(', ');
                },
                editAccount: (acc) => openModal('edit', acc),
                statusStyle, getStatusCn,

                // 浏览器账号 (Browser Accounts)
                browserAccounts, browserSearchQuery, filteredBrowserAccounts, browserEnabledCount, browserLoginLikelyCount,
                browserModal, browserFingerprintModal, browserAccountForm, isProbing,
                openBrowserModal, closeBrowserModal, submitBrowserAccount, openBrowserLogin, syncBrowserState,
                addBrowserStateToChannel, probeBrowserAccount, viewBrowserFingerprint, closeBrowserFingerprintModal,
                toggleBrowserAccount, deleteBrowserAccount, formatDateTime, probeStatusStyle, probeStatusText,

                // 模型管理 (Models)
                models, modelSearchQuery, modelEnabledFilter, filteredModels, modelModal, currentModel, originalModelId,
                openModelModal, saveModel, deleteModel, toggleModelEnabled,
                addProvider: (e) => {
                    const val = e.target.value;
                    if (!val) return;
                    let existing = currentModel.value.owned_by ? currentModel.value.owned_by.split(/[,，]/).map(p => p.trim()).filter(Boolean) : [];
                    if (!existing.includes(val)) {
                        existing.push(val);
                        currentModel.value.owned_by = existing.join(', ');
                    }
                    e.target.value = '';
                },
                removeProvider: (name) => {
                    let existing = currentModel.value.owned_by ? currentModel.value.owned_by.split(/[,，]/).map(p => p.trim()).filter(Boolean) : [];
                    existing = existing.filter(p => p !== name);
                    currentModel.value.owned_by = existing.join(', ');
                },

                // 即梦模型 (Jimeng Models)
                jimengModels, jimengModelSearchQuery, jimengModelEnabledFilter, filteredJimengModels,
                jimengModelModal, currentJimengModel, originalJimengModelId,
                openJimengModelModal, saveJimengModel, deleteJimengModel, toggleJimengModelEnabled,

                // 结构化请求日志 (Request Logs)
                requestLogs, logSearchQuery, logActionFilter, logStatusFilter, requestLogsPagination, logDetailModal, filteredRequestLogs,
                fetchRequestLogs, changeLogPage, openLogDetailModal, closeLogDetailModal, clearRequestLogs, extractedMediaUrls, isImageUrl, isVideoUrl, isAudioUrl,

                // 模型测试 Playground
                playgroundConfig, selectedTestModel, testPrompt, uploadedImages, testStatus, testStatusText, testOutputLog,
                testResultText, testResultMedia, testGenerating, testDuration, collapsedCategories, availableTestModels, categorisedModels,
                toggleCategoryCollapse, getModelTagStyle, getModelTagLabel, selectTestModel, getSubmitButtonText,
                fileInputRef, triggerFileInput, handleImageFiles, removeUploadedImage, startModelTest,

                // 统计分析 (Usage)
                usageChartData, resourceEfficiency,

                // 系统设置 (Settings)
                settings, policies, passChange, seedreamModelOptions,
                saveSettings, restartService, resetAllUsage, clearLocalMedia,
                addPolicy, removePolicy, savePolicies
            };
        }
    }).mount('#app');
});
