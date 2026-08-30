// ============================================
// 文件名: ratelimit.js
// 功能: IP限速管理模块
// ============================================

// 默认配置
let 限速配置 = {
    启用: false,
    模式: '黑名单', // 黑名单/白名单
    默认速率: '1M',
    IP规则: {} // { '1.2.3.4': '500K', '192.168.1.0/24': '2M' }
};

// ========== 工具函数 ==========

// 速率转字节
function 速率转字节(速率字符串) {
    const 单位映射 = { 'K': 1024, 'M': 1024*1024, 'G': 1024*1024*1024 };
    const 匹配 = String(速率字符串 || '').match(/^(\d+)([KMG])?$/i);
    if (!匹配) return 1024 * 1024;
    const 数值 = parseInt(匹配[1]);
    const 单位 = (匹配[2] || 'M').toUpperCase();
    return 数值 * (单位映射[单位] || 1024*1024);
}

// IP在CIDR内检查
function IP在CIDR内(IP地址, 网络IP, 前缀长度) {
    const IP转数字 = (ip) => ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet), 0);
    const IP掩码 = ~0 >>> (32 - 前缀长度);
    const IP数值 = IP转数字(IP地址);
    const 网络数值 = IP转数字(网络IP);
    return (IP数值 & IP掩码) === (网络数值 & IP掩码);
}

// IP匹配函数
function IP是否匹配(IP地址, IP规则) {
    for (const [规则IP, 速率] of Object.entries(IP规则)) {
        if (规则IP.includes('/')) {
            const [网络IP, 前缀长度] = 规则IP.split('/');
            if (IP在CIDR内(IP地址, 网络IP, parseInt(前缀长度))) {
                return 速率;
            }
        } else if (IP地址 === 规则IP) {
            return 速率;
        }
    }
    return null;
}

// ========== 核心函数 ==========

// 加载配置
async function 加载限速配置(env) {
    if (!env.KV) return;
    try {
        const 配置KV = await env.KV.get('ratelimit_config');
        if (配置KV) {
            限速配置 = JSON.parse(配置KV);
        }
    } catch (e) {
        console.error('加载限速配置失败:', e);
    }
}

// 检查限速
function 检查限速(访问IP) {
    if (!限速配置.启用) return null;
    
    let 限速速率 = null;
    
    // 检查具体IP
    if (限速配置.IP规则[访问IP]) {
        限速速率 = 限速配置.IP规则[访问IP];
    } else {
        // 检查CIDR规则
        限速速率 = IP是否匹配(访问IP, 限速配置.IP规则);
    }
    
    // 黑名单模式
    if (限速配置.模式 === '黑名单') {
        return 限速速率 ? 速率转字节(限速速率) : null;
    }
    
    // 白名单模式
    if (限速配置.模式 === '白名单') {
        return 限速速率 ? null : 速率转字节(限速配置.默认速率 || '1M');
    }
    
    return null;
}

// 限速响应包装器
function 限速响应包装器(响应, 限速字节数) {
    if (!限速字节数) return 响应;
    
    const 内容长度 = 响应.headers.get('content-length');
    if (!内容长度 || parseInt(内容长度) < 限速字节数) return 响应;
    
    // 简单的限速流
    const { readable, writable } = new TransformStream({
        async transform(chunk, controller) {
            let offset = 0;
            const 块大小 = 1024; // 每次1KB
            const 延迟时间 = 1000 / (限速字节数 / 块大小);
            
            while (offset < chunk.length) {
                const 本次发送 = Math.min(块大小, chunk.length - offset);
                controller.enqueue(chunk.slice(offset, offset + 本次发送));
                offset += 本次发送;
                if (offset < chunk.length) {
                    await new Promise(resolve => setTimeout(resolve, 延迟时间));
                }
            }
        }
    });
    
    return new Response(响应.body.pipeThrough({ readable, writable }), {
        status: 响应.status,
        statusText: 响应.statusText,
        headers: 响应.headers
    });
}

// ========== API处理器 ==========

// 处理 /admin/ratelimit 请求
async function 处理限速API(request, env) {
    const url = new URL(request.url);
    
    // GET: 获取配置
    if (request.method === 'GET') {
        return new Response(JSON.stringify(限速配置, null, 2), {
            status: 200,
            headers: { 'Content-Type': 'application/json;charset=utf-8' }
        });
    }
    
    // POST: 更新配置
    if (request.method === 'POST') {
        try {
            const 新配置 = await request.json();
            
            // 验证
            if (typeof 新配置.启用 !== 'boolean') {
                throw new Error('启用状态必须为布尔值');
            }
            if (!['黑名单', '白名单'].includes(新配置.模式)) {
                throw new Error('模式必须为"黑名单"或"白名单"');
            }
            
            // 保存到KV
            await env.KV.put('ratelimit_config', JSON.stringify(新配置));
            限速配置 = 新配置;
            
            return new Response(JSON.stringify({ 
                success: true, 
                message: '限速配置已更新',
                data: 限速配置
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json;charset=utf-8' }
            });
        } catch (error) {
            return new Response(JSON.stringify({ 
                success: false, 
                error: error.message 
            }), {
                status: 400,
                headers: { 'Content-Type': 'application/json;charset=utf-8' }
            });
        }
    }
    
    return new Response('Method Not Allowed', { status: 405 });
}

// ========== 导出 ==========
export {
    限速配置,
    加载限速配置,
    检查限速,
    限速响应包装器,
    处理限速API
};