import { accountIndex, constantTimeEqual, decryptWqId, sha256Hex } from './crypto.js';
import { jsonResponse } from './registration.js';

const ACCOUNT_HASH_PATTERN = /^[0-9a-f]{64}$/;

export async function requireAdmin(request, env) {
    const authorization = request.headers.get('Authorization') || '';
    if (!authorization.startsWith('Basic ') || !env.ADMIN_AUTH_DIGEST) return false;

    let credentials;
    try {
        credentials = atob(authorization.slice(6));
    } catch {
        return false;
    }
    const receivedDigest = await sha256Hex(credentials);
    return constantTimeEqual(receivedDigest, String(env.ADMIN_AUTH_DIGEST).toLowerCase());
}

export function unauthorizedResponse() {
    return new Response('Authentication required.', {
        status: 401,
        headers: {
            'WWW-Authenticate': 'Basic realm="WebDataScope private statistics", charset="UTF-8"',
            'Cache-Control': 'no-store',
            'X-Robots-Tag': 'noindex, nofollow, noarchive',
        },
    });
}

export function adminPage() {
    const nonceBytes = crypto.getRandomValues(new Uint8Array(18));
    const nonce = btoa(String.fromCharCode(...nonceBytes));
    return new Response(renderAdminHtml(nonce), {
        headers: adminHeaders({
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Security-Policy': [
                "default-src 'none'",
                `script-src 'nonce-${nonce}'`,
                "style-src 'unsafe-inline'",
                "connect-src 'self'",
                "frame-ancestors 'none'",
                "base-uri 'none'",
                "form-action 'none'",
            ].join('; '),
        }),
    });
}

export async function adminSummary(env) {
    const statements = [
        env.DB.prepare(`
            SELECT
                (SELECT COUNT(*) FROM accounts) AS account_count,
                (SELECT COUNT(*) FROM installations) AS installation_count,
                COALESCE((
                    SELECT SUM(extra_count) FROM (
                        SELECT MAX(COUNT(DISTINCT installation_id) - 1, 0) AS extra_count
                        FROM installations
                        GROUP BY account_hash
                    )
                ), 0) AS reinstall_count
        `),
        env.DB.prepare(`
            SELECT country, COUNT(*) AS count
            FROM accounts
            GROUP BY country
            ORDER BY count DESC, country ASC
        `),
        env.DB.prepare(`
            SELECT latest_version AS version, COUNT(*) AS count
            FROM accounts
            GROUP BY latest_version
            ORDER BY latest_version_rank DESC
        `),
        env.DB.prepare(`
            SELECT day, count FROM (
                SELECT SUBSTR(first_reported_at, 1, 10) AS day, COUNT(*) AS count
                FROM version_registrations
                GROUP BY day
                ORDER BY day DESC
                LIMIT 180
            ) ORDER BY day ASC
        `),
        env.DB.prepare(`
            SELECT previous_version, version, COUNT(*) AS count
            FROM version_registrations
            WHERE previous_version IS NOT NULL AND previous_version <> ''
            GROUP BY previous_version, version
            ORDER BY count DESC, previous_version DESC, version DESC
            LIMIT 100
        `),
    ];
    const results = await env.DB.batch(statements);
    const totals = results[0]?.results?.[0] || {};
    return adminJson({
        totals: {
            accounts: Number(totals.account_count || 0),
            installations: Number(totals.installation_count || 0),
            reinstalls: Number(totals.reinstall_count || 0),
        },
        countries: normalizeCountRows(results[1]?.results, 'country'),
        versions: normalizeCountRows(results[2]?.results, 'version'),
        daily: normalizeCountRows(results[3]?.results, 'day'),
        upgrades: (results[4]?.results || []).map((row) => ({
            previousVersion: String(row.previous_version),
            version: String(row.version),
            count: Number(row.count || 0),
        })),
    });
}

export async function adminUsers(url, env) {
    const page = clampInteger(url.searchParams.get('page'), 1, 1, 1_000_000);
    const pageSize = clampInteger(url.searchParams.get('pageSize'), 25, 1, 100);
    const offset = (page - 1) * pageSize;
    const [countRow, userResult] = await Promise.all([
        env.DB.prepare('SELECT COUNT(*) AS count FROM accounts').first(),
        env.DB.prepare(`
            SELECT
                a.account_hash,
                a.encrypted_wq_id,
                a.encryption_iv,
                a.key_version,
                a.country,
                a.latest_version,
                a.first_seen_at,
                a.last_seen_at,
                COUNT(DISTINCT i.installation_id) AS installation_count,
                (
                    SELECT GROUP_CONCAT(ordered.version, ' → ')
                    FROM (
                        SELECT vr.version
                        FROM version_registrations vr
                        WHERE vr.account_hash = a.account_hash
                        GROUP BY vr.version
                        ORDER BY MIN(vr.first_reported_at) ASC
                    ) AS ordered
                ) AS version_history
            FROM accounts a
            LEFT JOIN installations i ON i.account_hash = a.account_hash
            GROUP BY a.account_hash
            ORDER BY a.last_seen_at DESC
            LIMIT ? OFFSET ?
        `).bind(pageSize, offset).all(),
    ]);

    const users = [];
    for (const row of userResult.results || []) {
        let wqId = '[解密失败]';
        try {
            wqId = await decryptWqId(row.encrypted_wq_id, row.encryption_iv, Number(row.key_version), env);
        } catch {
            // Never log ciphertext, plaintext or account identifiers.
        }
        users.push({
            accountHash: String(row.account_hash),
            wqId,
            country: String(row.country),
            latestVersion: String(row.latest_version),
            firstSeenAt: String(row.first_seen_at),
            lastSeenAt: String(row.last_seen_at),
            installationCount: Number(row.installation_count || 0),
            versionHistory: row.version_history ? String(row.version_history) : '',
        });
    }

    const total = Number(countRow?.count || 0);
    return adminJson({ page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)), users });
}

export async function deleteAdminUser(request, url, env) {
    const pathMatch = url.pathname.match(/^\/api\/admin\/users\/([0-9a-f]{64})$/);
    let accountHash;
    if (pathMatch) {
        accountHash = pathMatch[1];
    } else if (url.pathname === '/api/admin/users') {
        const body = await readSmallJson(request, 512);
        if (!body || Object.keys(body).length !== 1 || typeof body.wqId !== 'string') {
            return adminJson({ ok: false, error: 'Body must contain only wqId.' }, 400);
        }
        const wqId = body.wqId.trim();
        if (!wqId || wqId.length > 128 || wqId !== body.wqId) {
            return adminJson({ ok: false, error: 'Invalid wqId.' }, 400);
        }
        accountHash = await accountIndex(wqId, env);
    } else {
        return adminJson({ ok: false, error: 'Not found.' }, 404);
    }

    if (!ACCOUNT_HASH_PATTERN.test(accountHash)) {
        return adminJson({ ok: false, error: 'Invalid account index.' }, 400);
    }

    const results = await env.DB.batch([
        env.DB.prepare('DELETE FROM version_registrations WHERE account_hash = ?').bind(accountHash),
        env.DB.prepare('DELETE FROM installations WHERE account_hash = ?').bind(accountHash),
        env.DB.prepare('DELETE FROM accounts WHERE account_hash = ?').bind(accountHash),
    ]);
    return adminJson({ ok: true, deleted: Number(results?.[2]?.meta?.changes || 0) > 0 });
}

export function adminJson(value, status = 200) {
    const response = jsonResponse(value, status);
    const headers = new Headers(response.headers);
    headers.delete('Access-Control-Allow-Origin');
    for (const [key, val] of Object.entries(adminHeaders())) headers.set(key, val);
    return new Response(response.body, { status, headers });
}

function normalizeCountRows(rows = [], key) {
    return rows.map((row) => ({ [key]: String(row[key]), count: Number(row.count || 0) }));
}

function clampInteger(value, fallback, minimum, maximum) {
    const number = Number(value);
    return Number.isInteger(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
}

async function readSmallJson(request, limit) {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > limit) return null;
    try {
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return null;
    }
}

function adminHeaders(extra = {}) {
    return {
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
        'X-Robots-Tag': 'noindex, nofollow, noarchive',
        ...extra,
    };
}

function renderAdminHtml(nonce) {
    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow,noarchive">
  <title>WebDataScope 私有版本统计</title>
  <style>
    :root{color-scheme:light;--ink:#172033;--muted:#657089;--line:#dfe4ef;--bg:#f4f7fb;--card:#fff;--blue:#246bfd;--red:#c83232}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}.wrap{max-width:1280px;margin:auto;padding:28px}.title{display:flex;justify-content:space-between;gap:16px;align-items:end}.title h1{margin:0;font-size:26px}.muted{color:var(--muted)}.cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin:22px 0}.card,.panel{background:var(--card);border:1px solid var(--line);border-radius:14px;box-shadow:0 4px 18px #1720330a}.card{padding:18px}.card strong{display:block;font-size:28px;margin-top:4px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.panel{padding:18px;margin-bottom:14px}.panel h2{font-size:17px;margin:0 0 14px}.list{display:grid;gap:7px}.list div{display:flex;justify-content:space-between;border-bottom:1px dashed var(--line);padding:5px 0}.table-wrap{overflow:auto}table{border-collapse:collapse;width:100%;min-width:920px}th,td{text-align:left;border-bottom:1px solid var(--line);padding:10px 8px;vertical-align:top}th{font-size:12px;color:var(--muted);background:#fafbfe;position:sticky;top:0}.controls{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:0 0 14px}button,input,select{font:inherit;border:1px solid var(--line);border-radius:9px;background:#fff;padding:8px 10px}button{cursor:pointer;font-weight:650}button.primary{background:var(--blue);color:#fff;border-color:var(--blue)}button.danger{color:var(--red);border-color:#e8b4b4}.pager{display:flex;justify-content:center;align-items:center;gap:12px;margin-top:14px}.status{min-height:24px;color:var(--muted)}@media(max-width:760px){.wrap{padding:16px}.cards,.grid{grid-template-columns:1fr}.title{align-items:start;flex-direction:column}}
  </style>
</head>
<body>
  <main class="wrap">
    <div class="title"><div><h1>WebDataScope 私有版本统计</h1><div class="muted">每安装、账号与版本一次登记；不代表日活或使用频率。</div></div><button id="refresh" class="primary">刷新</button></div>
    <section class="cards"><div class="card">账号数<strong id="accounts">—</strong></div><div class="card">安装数<strong id="installations">—</strong></div><div class="card">重装次数<strong id="reinstalls">—</strong></div></section>
    <section class="grid"><article class="panel"><h2>国家/地区分布</h2><div id="countries" class="list"></div></article><article class="panel"><h2>用户最新版本</h2><div id="versions" class="list"></div></article><article class="panel"><h2>每日版本登记趋势</h2><div id="daily" class="list"></div></article><article class="panel"><h2>升级路径</h2><div id="upgrades" class="list"></div></article></section>
    <section class="panel"><h2>按 WQ ID 删除</h2><div class="controls"><input id="deleteWqId" maxlength="128" autocomplete="off" placeholder="输入完整 WQ ID"><button id="deleteById" class="danger">永久删除该账号登记</button></div><div id="deleteStatus" class="status"></div></section>
    <section class="panel"><h2>用户列表</h2><div class="controls"><label>每页 <select id="pageSize"><option>10</option><option selected>25</option><option>50</option><option>100</option></select></label></div><div class="table-wrap"><table><thead><tr><th>WQ ID</th><th>国家</th><th>最新版本</th><th>首次登记</th><th>最近登记</th><th>安装数</th><th>历史版本</th><th>操作</th></tr></thead><tbody id="users"></tbody></table></div><div class="pager"><button id="previous">上一页</button><span id="pageLabel">第 1 / 1 页</span><button id="next">下一页</button></div></section>
    <div id="status" class="status"></div>
  </main>
  <script nonce="${nonce}">
    const state={page:1,totalPages:1};
    const byId=(id)=>document.getElementById(id);
    const addCountList=(id,rows,label)=>{const root=byId(id);root.replaceChildren();for(const row of rows){const line=document.createElement('div');const name=document.createElement('span');const count=document.createElement('strong');name.textContent=label(row);count.textContent=String(row.count);line.append(name,count);root.append(line)}if(!rows.length)root.textContent='暂无数据'};
    const api=async(url,options={})=>{const response=await fetch(url,{...options,credentials:'same-origin',headers:{'Content-Type':'application/json',...(options.headers||{})}});const data=await response.json();if(!response.ok)throw new Error(data.error||('HTTP '+response.status));return data};
    async function loadSummary(){const data=await api('/api/admin/summary');byId('accounts').textContent=data.totals.accounts;byId('installations').textContent=data.totals.installations;byId('reinstalls').textContent=data.totals.reinstalls;addCountList('countries',data.countries,(r)=>r.country);addCountList('versions',data.versions,(r)=>r.version);addCountList('daily',data.daily,(r)=>r.day);addCountList('upgrades',data.upgrades,(r)=>r.previousVersion+' → '+r.version)}
    async function loadUsers(){const size=Number(byId('pageSize').value);const data=await api('/api/admin/users?page='+state.page+'&pageSize='+size);state.totalPages=data.totalPages;state.page=Math.min(state.page,state.totalPages);byId('pageLabel').textContent='第 '+state.page+' / '+state.totalPages+' 页（共 '+data.total+' 人）';byId('previous').disabled=state.page<=1;byId('next').disabled=state.page>=state.totalPages;const root=byId('users');root.replaceChildren();for(const user of data.users){const tr=document.createElement('tr');for(const value of [user.wqId,user.country,user.latestVersion,user.firstSeenAt,user.lastSeenAt,user.installationCount,user.versionHistory]){const td=document.createElement('td');td.textContent=String(value);tr.append(td)}const action=document.createElement('td');const button=document.createElement('button');button.className='danger';button.textContent='删除';button.addEventListener('click',()=>deleteHash(user.accountHash,user.wqId));action.append(button);tr.append(action);root.append(tr)}}
    async function deleteHash(hash,wqId){if(!confirm('永久删除 '+wqId+' 的全部登记？'))return;await api('/api/admin/users/'+hash,{method:'DELETE'});await refreshAll()}
    async function deleteByWqId(){const input=byId('deleteWqId');const status=byId('deleteStatus');const wqId=input.value.trim();if(!wqId){status.textContent='请输入 WQ ID。';return}if(!confirm('永久删除该 WQ ID 的全部登记？'))return;const result=await api('/api/admin/users',{method:'DELETE',body:JSON.stringify({wqId})});status.textContent=result.deleted?'已删除。':'未找到匹配账号。';input.value='';await refreshAll()}
    async function refreshAll(){byId('status').textContent='正在加载…';try{await Promise.all([loadSummary(),loadUsers()]);byId('status').textContent='最近刷新：'+new Date().toLocaleString()}catch(error){byId('status').textContent='加载失败：'+error.message}}
    byId('refresh').addEventListener('click',refreshAll);byId('pageSize').addEventListener('change',()=>{state.page=1;loadUsers()});byId('previous').addEventListener('click',()=>{if(state.page>1){state.page-=1;loadUsers()}});byId('next').addEventListener('click',()=>{if(state.page<state.totalPages){state.page+=1;loadUsers()}});byId('deleteById').addEventListener('click',deleteByWqId);refreshAll();
  </script>
</body>
</html>`;
}
