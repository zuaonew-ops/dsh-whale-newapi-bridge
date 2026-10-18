// live-e2e.mjs —— 端到端取证（SPEC §8 A2/A4/A5/A6/A7 的证据脚本）。
//
// 运行方式：
//   node test/live-e2e.mjs                 # 默认：受控上游桩（完全离线、确定性），写真实注册表前先做快照
//   node test/live-e2e.mjs --no-write      # 只读演练：完全不写注册表
//   node test/live-e2e.mjs --live-upstream  # A2：真实访问中转站（凭据来自 DSH 凭据文件，一律脱敏）
//   node test/live-e2e.mjs --gui           # 额外探测运行中的 DSH GUI（127.0.0.1:19387）
//
// 安全约束：不重启 dsh、不改 profile、不修改实现文件、不打印任何凭据明文。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import {
  createRunner, assert, assertEq, assertDeepEq, assertFiniteNumber, assertNotIncludes,
  needFn, mask, readCredentialValue, sha256, readJsonIfExists, jsonResponse,
  WHALE_REGISTRY_REAL, PKG_DIR,
} from './verify-helpers.mjs'

const ARGS = new Set(process.argv.slice(2))
const NO_WRITE = ARGS.has('--no-write')
const LIVE_UPSTREAM = ARGS.has('--live-upstream')
const PROBE_GUI = ARGS.has('--gui')
const ROLLBACK_DRILL = ARGS.has('--rollback-drill')
// 安全设计：**不存在**任何会自动执行破坏性回滚的开关。`--rollback-drill` 只做只读核对
// （快照完整性 + 目标文件当前 SHA256 + 待执行命令清单），卸载/还原必须由作者手工执行。
const EXECUTE_ROLLBACK = ARGS.has('--execute-rollback')
const RELAY_BASE = process.env.DSH_VERIFY_RELAY || 'http://127.0.0.1:3000'
const GUI_BASE = process.env.DSH_WEB_URL || 'http://127.0.0.1:19387'
const CRED_REF = process.env.DSH_VERIFY_CRED_REF || 'PI_API_KEY'
const SECRET = readCredentialValue(CRED_REF) || ''
// 回滚需要涉及的 profile 侧文件（只读快照，我们不修改它们）
const PROFILE_DIR = path.join(os.homedir(), '.dsh', 'profiles', 'desktop')
const PROFILE_FILES = ['cordis.patch.yml', 'package.json']

const t = createRunner('live-e2e.mjs —— 端到端取证（A2/A4/A5/A6/A7）')
console.log(`模式: ${NO_WRITE ? '只读（不写注册表）' : '写入（含快照与保留性校验）'}` +
  `${LIVE_UPSTREAM ? ' + 真实上游' : ' + 受控上游桩'}${PROBE_GUI ? ' + GUI 探测' : ''}`)
console.log(`注册表: ${WHALE_REGISTRY_REAL}`)
console.log(`中转站: ${RELAY_BASE}`)
console.log(`凭据 ${CRED_REF}: ${mask(SECRET)}`)

// ---------- 0. 安装前快照（A5 的对比基准 + A7 的回滚材料） ----------
const snapshotDir = path.join(os.tmpdir(), 'dsh-verify-snap-' + Date.now())
fs.mkdirSync(snapshotDir, { recursive: true })
const snapshot = { dir: snapshotDir, at: new Date().toISOString(), registry: { existed: false, sha256: null, json: null }, profile: {} }
if (fs.existsSync(WHALE_REGISTRY_REAL)) {
  const bytes = fs.readFileSync(WHALE_REGISTRY_REAL)
  fs.writeFileSync(path.join(snapshotDir, '.dshw-api.json'), bytes)
  snapshot.registry = { existed: true, sha256: sha256(bytes), bytes: bytes.length, json: JSON.parse(bytes.toString('utf8')), mtimeMs: fs.statSync(WHALE_REGISTRY_REAL).mtimeMs }
  console.log(`安装前快照: sha256=${snapshot.registry.sha256} (${bytes.length} 字节) → ${snapshotDir}`)
} else {
  console.log(`安装前快照: ${WHALE_REGISTRY_REAL} 不存在（视为空注册表）→ ${snapshotDir}`)
}
// profile 侧文件快照（只读复制 + SHA256，供回滚核对；我们不会修改这些文件）
for (const name of PROFILE_FILES) {
  const src = path.join(PROFILE_DIR, name)
  if (!fs.existsSync(src)) { snapshot.profile[name] = { existed: false }; continue }
  const bytes = fs.readFileSync(src)
  fs.writeFileSync(path.join(snapshotDir, 'profile-' + name), bytes)
  snapshot.profile[name] = { existed: true, sha256: sha256(bytes), bytes: bytes.length, mtimeMs: fs.statSync(src).mtimeMs }
  console.log(`profile 快照: ${name} sha256=${snapshot.profile[name].sha256} (${bytes.length} 字节)`)
}

// ---------- 上游取数：真实或受控 ----------
// ⚠️ 必须捕获**真实** fetch（在覆盖 globalThis.fetch 之前），否则 upstreamFetch 里的 `fetch(...)`
// 在运行时解析到我们自己的包装 → 无限递归（实测报 "Maximum call stack size exceeded"）。
const REAL_FETCH = globalThis.fetch
const upstreamCalls = []
async function upstreamFetch(url, init) {
  const u = String(url)
  const auth = (init && init.headers && (init.headers.Authorization || init.headers.authorization)) || ''
  upstreamCalls.push({ url: u, auth, stubbed: false })
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 15000)
  try {
    const res = await REAL_FETCH(u, { ...init, signal: ctl.signal })
    const text = await res.text()
    let parsed = null
    try { parsed = JSON.parse(text) } catch { /* 保留原文用于非 JSON 判定 */ }
    return {
      ok: res.ok, status: res.status,
      headers: new Map([...res.headers.entries()]),
      async json() { if (parsed === null) throw new SyntaxError('非 JSON 响应'); return parsed },
      async text() { return text },
    }
  } finally { clearTimeout(timer) }
}
function stubFetch(url, init) {
  const u = String(url)
  const auth = (init && init.headers && (init.headers.Authorization || init.headers.authorization)) || ''
  upstreamCalls.push({ url: u, auth, stubbed: true })
  if (u.includes('/api/status')) {
    return Promise.resolve(jsonResponse({ data: { version: 'v1.0.0-rc.40', system_name: 'New API', quota_per_unit: 500000, usd_exchange_rate: 7.3, display_in_currency: true, quota_display_type: 'CUSTOM', custom_currency_symbol: 'credits', custom_currency_exchange_rate: 1 } }))
  }
  if (u.includes('/v1/dashboard/billing/subscription')) {
    return Promise.resolve(jsonResponse({ object: 'billing_subscription', hard_limit_usd: 100000000, soft_limit_usd: 100000000, system_hard_limit_usd: 100000000 }))
  }
  if (u.includes('/v1/dashboard/billing/usage')) {
    return Promise.resolve(jsonResponse({ object: 'list', total_usage: 1834.5636 }))
  }
  if (u.includes('/api/user/self')) {
    return Promise.resolve(jsonResponse({ success: false, message: '无权进行此操作' }, 401))
  }
  if (u.includes('/dsh-whale-newapi/health')) {
    return Promise.resolve(jsonResponse({ ok: true, name: 'dsh-whale-newapi-bridge', version: '0.1.0', enabled: true }))
  }
  return Promise.reject(new TypeError('stub: 未预期请求 ' + u))
}
const FETCH_IMPL = LIVE_UPSTREAM ? upstreamFetch : stubFetch

// ---------- 假 ctx 桩 ----------
function makeStubCtx(credentialValue) {
  const routes = []
  const effects = []
  const ctx = {
    _routes: routes, _effects: effects,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    inject(names, fn) { return fn(ctx) },
    get(name) {
      if (name === 'credentials') return credentials
      if (name === 'webServer') return webServer
      if (name === 'connection') return { on() { return () => {} } }
      return undefined
    },
    effect(fn) { const d = fn(); if (typeof d === 'function') effects.push(d); return () => {} },
    on() { return () => {} },
  }
  const webServer = { register(spec) { routes.push(spec); return () => {} } }
  const credentials = {
    async resolve(ref) { return credentialValue ? { value: credentialValue, ref } : null },
    async set() { return true },
  }
  // 与 verify-security.mjs 同理：真实 Cordis 里服务既在 ctx.get(name)，也直接挂在 ctx 上。
  ctx.webServer = webServer
  ctx.credentials = credentials
  ctx.connection = { on() { return () => {} } }
  return ctx
}

async function serve(routes) {
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://127.0.0.1').pathname
    const route = routes.find((r) => r && typeof r.path === 'string' && r.path === p) ||
      routes.find((r) => r && r.kind === 'prefix' && typeof r.path === 'string' && p.startsWith(r.path))
    if (!route) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"no-route"}'); return }
    try {
      const out = route.handler(req, res)
      if (out && typeof out.then === 'function') out.catch((e) => { if (!res.headersSent) { res.writeHead(500); res.end(String(e && e.message)) } })
    } catch (e) { if (!res.headersSent) { res.writeHead(500); res.end(String(e && e.message)) } }
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { server, port: server.address().port }
}
function req(port, { method = 'GET', url = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: url, headers: { host: `127.0.0.1:${port}`, ...headers }, setHost: false }, (res) => {
      const c = []
      res.on('data', (d) => c.push(d))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString('utf8') }))
    })
    r.on('error', reject)
    r.setTimeout(20000, () => r.destroy(new Error('请求超时')))
    if (body) r.write(body)
    r.end()
  })
}

// ---------- 1. A2：上游连通性 ----------
await t.group('A2 上游连通性（/api/status 公开端点，不带凭据）', () => {
  t.test(`探测 ${RELAY_BASE}/api/status`, async () => {
    if (!LIVE_UPSTREAM) { console.log('      [无法验证] 未加 --live-upstream（受控桩模式不联网）'); return }
    const r = await upstreamFetch(RELAY_BASE + '/api/status', { method: 'GET' })
    assertEq(r.ok, true, `HTTP 状态 ${r.status}`)
    const j = await r.json()
    const inner = j && j.data ? j.data : j
    assertEq(inner.quota_per_unit, 500000, 'quota_per_unit')
    console.log(`      HTTP ${r.status} quota_per_unit=${inner.quota_per_unit} usd_exchange_rate=${inner.usd_exchange_rate} display_in_currency=${inner.display_in_currency} custom_currency_symbol=${inner.custom_currency_symbol}`)
  })
})

// ---------- 2. 挂载插件（真实 apply 逻辑）+ 真实同步 ----------
let serverHandle = null
let pluginCtx = null
let statusAfter = null
let entryAfter = null
let registryPath = WHALE_REGISTRY_REAL
const realFetch = REAL_FETCH

// ---------- 只读模式（--no-write）的真隔离 ----------
// 关键事实：插件的 runInitialSync() 在 apply() 时就会跑；config.enabled=false 时 doSync 走
// removeOurEntry()，**照样写文件**。所以「不写」不能靠配置实现，只能靠把 $DSH_HOME 指到临时目录。
// 做法：把真实注册表的**字节副本**放进临时 home，让插件在一个等价但隔离的环境里跑；
// 真实文件全程只读，并在末尾用 sha256 守卫断言其未变。
const ISOLATED_HOME = NO_WRITE ? fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-verify-e2e-home-')) : null
const ORIGINAL_DSH_HOME = process.env.DSH_HOME
const REAL_GUARD = fs.existsSync(WHALE_REGISTRY_REAL)
  ? { sha256: sha256(fs.readFileSync(WHALE_REGISTRY_REAL)), mtimeMs: fs.statSync(WHALE_REGISTRY_REAL).mtimeMs }
  : null
let ISOLATED_REGISTRY = null
if (NO_WRITE) {
  ISOLATED_REGISTRY = path.join(ISOLATED_HOME, '.dshw-api.json')
  if (fs.existsSync(WHALE_REGISTRY_REAL)) fs.copyFileSync(WHALE_REGISTRY_REAL, ISOLATED_REGISTRY)
  process.env.DSH_HOME = ISOLATED_HOME
  console.log(`只读隔离: $DSH_HOME → ${ISOLATED_HOME}（真实注册表字节副本=${fs.existsSync(ISOLATED_REGISTRY)}）`)
}

await t.group('A4 插件挂载与 /status 自检', () => {
  t.test('apply(ctx, { 默认配置 }) 不抛异常，等同步落定', async () => {
    const mod = await import('file://' + path.join(PKG_DIR, 'lib', 'index.js').replace(/\\/g, '/'))
    const apply = needFn(mod, 'apply', 'index')
    pluginCtx = makeStubCtx(SECRET)
    globalThis.fetch = FETCH_IMPL
    let applyErr = null
    try { apply(pluginCtx, {}) } catch (e) { applyErr = e }
    assertEq(applyErr, null, `apply 抛异常: ${applyErr && applyErr.message}`)
    serverHandle = await serve(pluginCtx._routes)
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      const r = await req(serverHandle.port, { url: '/dsh-whale-newapi/status' })
      if (r.status === 200) statusAfter = JSON.parse(r.body)
      // 同步落定判据：lastSyncAt 有值，或 balance 已解析，或 whale.entry 已产出
      if (statusAfter && statusAfter.whale &&
        (statusAfter.whale.lastSyncAt || (statusAfter.whale.entry && statusAfter.whale.entry.id) || (statusAfter.balance && statusAfter.balance.ok))) break
      await new Promise((r2) => setTimeout(r2, 400))
    }
    assert(statusAfter, '未能从 /status 取得状态')
    assertEq(statusAfter.ok, true, 'status.ok')
    registryPath = statusAfter.whale.registryFile || WHALE_REGISTRY_REAL
    entryAfter = statusAfter.whale.entry
    console.log(`      /status HTTP 200`)
    console.log(`      whale.mode=${statusAfter.whale.mode}  registryFile=${statusAfter.whale.registryFile}`)
    console.log(`      whale.registryOk=${statusAfter.whale.registryOk} changed=${statusAfter.whale.changed} backupPath=${statusAfter.whale.backupPath}`)
    console.log(`      whale.lastSyncAt=${statusAfter.whale.lastSyncAt} lastSyncResult=${JSON.stringify(statusAfter.whale.lastSyncResult)}`)
    console.log(`      balance.source=${statusAfter.balance && statusAfter.balance.source} remaining=${statusAfter.balance && statusAfter.balance.remaining} unlimited=${statusAfter.balance && statusAfter.balance.unlimited} currency=${statusAfter.balance && statusAfter.balance.currency}`)
    console.log(`      balance.detail=${JSON.stringify(statusAfter.balance && statusAfter.balance.detail)}`)
    console.log(`      credential=${JSON.stringify(statusAfter.credential)}`)
    console.log(`      bridge=${JSON.stringify(statusAfter.bridge)}`)
    console.log(`      warnings=${JSON.stringify(statusAfter.warnings)}`)
    console.log(`      whale.entry=${JSON.stringify(entryAfter)}`)
  })
  t.test('A4：/health 200 且 /status 显示 whale.entry 与 registryFile', async () => {
    const h = await req(serverHandle.port, { url: '/dsh-whale-newapi/health' })
    assertEq(h.status, 200, `health HTTP 状态（body=${h.body.slice(0, 200)}）`)
    const hj = JSON.parse(h.body)
    assertEq(hj.ok, true, 'health.ok')
    assert(entryAfter, 'whale.entry 必须存在')
    assert(typeof statusAfter.whale.registryFile === 'string' && statusAfter.whale.registryFile.length > 0, 'whale.registryFile 必须是路径字符串')
    if (NO_WRITE) {
      // 只读模式下 registryFile 必须落在隔离 home 内（证明没有指向真实文件）
      assertEq(path.dirname(path.resolve(statusAfter.whale.registryFile)), path.resolve(ISOLATED_HOME), 'no-write 下 registryFile 必须在隔离 home 内')
      assertEq(path.basename(statusAfter.whale.registryFile), '.dshw-api.json', 'registryFile 文件名')
      console.log(`      只读模式：registryFile=${statusAfter.whale.registryFile}（安装目标真实路径为 ${WHALE_REGISTRY_REAL}，本模式下只读）`)
    } else {
      assertEq(path.resolve(statusAfter.whale.registryFile), path.resolve(WHALE_REGISTRY_REAL), 'registryFile 应指向 $DSH_HOME/.dshw-api.json')
    }
  })
  t.test('A4：bridge.selfCheck 明确报告探测结果（SPEC §6 不许假装成功）', () => {
    const sc = statusAfter.bridge && statusAfter.bridge.selfCheck
    assert(sc && typeof sc === 'object', 'bridge.selfCheck 必须是对象')
    for (const k of ['ok', 'httpStatus', 'error', 'at']) assert(k in sc, `selfCheck 缺少 ${k}`)
    console.log(`      selfCheck.ok=${sc.ok} httpStatus=${sc.httpStatus} error=${sc.error} at=${sc.at}`)
  })
  t.test('A4：/balance 带正确 Bearer 的返回语义（数值 remaining 或显式 UNLIMITED）', async () => {
    if (!SECRET) { console.log('      [无法验证] 读不到真实凭据'); return }
    const r = await req(serverHandle.port, { url: '/dsh-whale-newapi/balance', headers: { authorization: 'Bearer ' + SECRET } })
    console.log(`      HTTP ${r.status} body=${r.body.slice(0, 400)}`)
    if (r.status === 200) {
      const j = JSON.parse(r.body)
      if (j.ok) assert(typeof j.remaining === 'number' && Number.isFinite(j.remaining), `remaining 必须是有限数值，实际 ${JSON.stringify(j.remaining)}`)
      else assertEq(j.code, 'UNLIMITED', `失败码应为 UNLIMITED，实际 ${j.code}（body=${r.body.slice(0, 300)}）`)
    } else {
      assertEq(r.status, 401, `应为 200 或 401，实际 ${r.status}`)
      assertEq(statusAfter.whale.mode, 'events', '若 /balance 给不出数值，条目必须切成 events 模式（SPEC §6.1）')
    }
  })
})

// ---------- 3. A5：注册表保留性 ----------
// 注意：--no-write 模式下 registryPath 是「真实注册表的字节副本」，因此保留性同样可被真实验证
// （对比基准 = 安装前真实文件的内容），只是落点被隔离，真实文件零改动。
await t.group('A5 注册表接入与保留性（deep compare）', () => {
  t.test('磁盘上出现我们的 id，且条目与 /status 的 whale.entry 一致', () => {
    const reg = readJsonIfExists(registryPath)
    assert(reg, `注册表应为合法 JSON: ${registryPath}`)
    assert(Array.isArray(reg.models), 'models 必须是数组')
    const ourId = entryAfter && entryAfter.id
    const ours = reg.models.find((m) => m && m.id === ourId)
    assert(ours, `注册表里应有 id=${ourId} 的条目（实际: ${reg.models.map((m) => m && m.id).join(',')}）`)
    assertDeepEq(ours, entryAfter, '磁盘条目应与 /status whale.entry 逐字段一致')
    console.log(`      我们的条目: ${JSON.stringify(ours)}`)
    if (NO_WRITE) console.log(`      （只读模式：该写入落在隔离副本 ${registryPath}，真实文件未动）`)
  })
  t.test('安装前快照的其它条目、usage 与未知顶层键逐字段保留', () => {
    if (!snapshot.registry.existed) { console.log('      [说明] 安装前注册表不存在 → 无“保留”对比基准；已写出快照目录供人工核对'); return }
    const before = snapshot.registry.json
    const after = readJsonIfExists(registryPath)
    const ourId = entryAfter && entryAfter.id
    assertDeepEq(after.usage, before.usage, 'usage 必须逐字段保留（SPEC §5.3 硬性要求）')
    const beforeOthers = (before.models || []).filter((m) => m && m.id !== ourId)
    const afterOthers = (after.models || []).filter((m) => m && m.id !== ourId)
    assertDeepEq(afterOthers, beforeOthers, '其它模型条目必须逐字段、逐顺序保留')
    for (const k of Object.keys(before)) {
      if (k === 'models' || k === 'usage') continue
      assertDeepEq(after[k], before[k], `顶层键 ${k} 必须保留`)
    }
    assertEq((after.models || []).length - beforeOthers.length, 1, '应只新增 1 条')
    console.log(`      其它条目 ${beforeOthers.length} 个逐字段保留；usage 键 ${Object.keys(before.usage || {}).length} 个逐字段保留；新增 1 条`)
  })
  t.test('备份文件 <file>.bak-newapi-bridge 内容核对', () => {
    const bak = registryPath + '.bak-newapi-bridge'
    if (!fs.existsSync(bak)) {
      console.log(`      [注意] 备份不存在: ${bak}（安装前若无原文件、或已被更早的写入备份过，实现约定“已存在则不覆盖”）`)
      return
    }
    const bakHash = sha256(fs.readFileSync(bak))
    console.log(`      备份 sha256=${bakHash}；安装前快照 sha256=${snapshot.registry.sha256}；一致=${bakHash === snapshot.registry.sha256}`)
  })
})

// ---------- 4. A6：小鲸鱼视角 ----------
await t.group('A6 小鲸鱼侧可见性（能取证就取证，取不到就等价离线证明）', () => {
  t.test(`GET ${GUI_BASE}/dsh-whale/api-models.json（无会话的直连探测）`, async () => {
    if (!PROBE_GUI) { console.log('      [无法验证] 未加 --gui'); return }
    const port = Number(new URL(GUI_BASE).port || 80)
    try {
      const r = await req(port, { url: '/dsh-whale/api-models.json' })
      console.log(`      HTTP ${r.status}（body 长度 ${r.body.length}）`)
      if (r.status === 200) {
        const arr = JSON.parse(r.body)
        const list = Array.isArray(arr) ? arr : (arr.models || [])
        const ours = list.find((m) => m && m.id === (entryAfter && entryAfter.id))
        console.log(ours ? `      小鲸鱼视角条目: ${JSON.stringify(ours)}` : '      [注意] 200 但未找到我们的条目')
      } else {
        console.log('      [无法验证] 本机无会话时取不到小鲸鱼视角（SPEC §8 A6 允许等价离线断言替代）')
      }
    } catch (err) {
      console.log(`      [无法验证] 请求失败: ${String(err && err.message)}`)
    }
  })
  t.test('等价离线证明：复刻 fetchModelBalance 判定链，喂真实条目 + bridge 真实响应 → 数值 remaining', () => {
    if (!entryAfter) throw new Error('前置失败：没有条目')
    // —— 以下为 dsh-whale-widget/lib/index.js 对应逻辑的复刻（行号见 verify-contract.mjs 源码锚点）——
    const pickJsonPath = (obj, p) => { try { const parts = String(p || '').replace(/\[(\d+)\]/g, '.$1').split('.').filter((x) => x.length > 0); let c = obj; for (const k of parts) { if (c == null) return undefined; c = c[k] } return c } catch { return undefined } }
    const apiNum = (v, s) => { const n = Number(v); if (!isFinite(n)) return null; return n * (isFinite(Number(s)) && Number(s) > 0 ? Number(s) : 1) }
    const mergeNonEmpty = (b, o) => { const out = Object.assign({}, b || {}); const oo = o && typeof o === 'object' ? o : {}; for (const k of Object.keys(oo)) { const v = oo[k]; if (v === undefined || v === null || v === '') continue; if (v && typeof v === 'object' && !Array.isArray(v)) { out[k] = mergeNonEmpty(out[k], v); continue } out[k] = v } return out }
    const originOf = (u) => { try { const p = new URL(String(u)); return (p.protocol === 'http:' || p.protocol === 'https:') ? p.origin.toLowerCase() : '' } catch { return '' } }
    const credentialMayGoTo = (model, tpl, url) => {
      const o = originOf(url); if (!o) return false
      const s = new Set(); const b = tpl && tpl.balance
      if (b && b.url && String(b.url).indexOf('{base}') < 0) { const x = originOf(String(b.url)); if (x) s.add(x) }
      if (s.has(o)) return true
      return !!(model && model.allowCustomHost === true)
    }
    const CUSTOM_TPL = { balance: { url: '', auth: 'Bearer {key}', json: { remaining: '' } } }
    const bal = statusAfter.balance || {}
    if (!(typeof bal.remaining === 'number')) {
      console.log(`      [说明] /status balance.remaining=${JSON.stringify(bal.remaining)}（unlimited=${bal.unlimited}）`)
      assertEq(entryAfter.balance && String(entryAfter.balance.url || '').trim(), '', 'remaining 非数值时条目必须是 events 模式（无 balance.url），否则小鲸鱼会报 SHAPE')
      console.log('      结论: events 模式 → 小鲸鱼显示「余额 —」，不报 SHAPE 错误（符合 SPEC §5.2）')
      return
    }
    const bridgeBody = { ok: true, remaining: bal.remaining, currency: bal.currency, total: bal.total, used: bal.used, unlimited: bal.unlimited, source: bal.source }
    const b = mergeNonEmpty(CUSTOM_TPL.balance, entryAfter.balance)
    const url = String(b.url || '').replace('{base}', String(entryAfter.baseUrl || '').replace(/\/+$/, ''))
    assert(String(url).length > 0, 'balance 模式下必须有可用 balance.url')
    assert(credentialMayGoTo(entryAfter, CUSTOM_TPL, url), 'allowCustomHost 必须放行，否则小鲸鱼拒绝发凭据（DEST_NOT_ALLOWED）')
    assertEq(b.json.remaining, 'remaining', "balance.json.remaining 必须是 'remaining'")
    let remaining = null
    if (b.json && b.json.remaining) { const v = apiNum(pickJsonPath(bridgeBody, b.json.remaining), b.json.scale); if (v !== null) remaining = v }
    assertFiniteNumber(remaining, '判定链结果')
    assertEq(remaining, bal.remaining, '判定链结果应与 bridge 返回一致')
    console.log(`      判定链: mergeNonEmpty → url=${url} → credentialMayGoTo=true → pickJsonPath('${b.json.remaining}') → remaining=${remaining}`)
    console.log(`      结论: 小鲸鱼将显示「余额·${entryAfter.name}」= ${remaining} ${entryAfter.currency}`)
  })
})

// ---------- 5. A7：回滚可执行性（只读演练；破坏性动作永不自动执行） ----------
await t.group('A7 回滚材料与步骤（本脚本不自动执行回滚）', () => {
  t.test('回滚材料齐备（快照 + 备份 + 步骤说明）', () => {
    const bak = registryPath + '.bak-newapi-bridge'
    console.log(`      安装前快照: ${snapshotDir}${snapshot.registry.existed ? '\\.dshw-api.json' : '（原本无文件）'}`)
    console.log(`      插件备份:   ${bak}（存在=${fs.existsSync(bak)}）`)
    console.log('      回滚步骤（需作者明确批准）：')
    console.log('        1) plugin_manager remove_bundle dsh-whale-newapi-bridge')
    console.log(`        2) 用快照恢复 ${registryPath}（或仅删除我们的 id 条目）`)
    console.log('        3) 恢复 profile 的 cordis.patch.yml / package.json 并核对 SHA256')
    console.log('      [注意] 本脚本未执行任何回滚动作（SPEC 要求由作者决定）。')
  })
  t.test('安装前快照 SHA256 已记录，可用于回滚后核对', () => {
    if (snapshot.registry.existed) assertEq(typeof snapshot.registry.sha256, 'string', '快照 sha256')
    assert(fs.existsSync(snapshotDir), '快照目录存在')
  })
  t.test('【只读演练】快照完整性核对：快照副本的 SHA256 与记录的 SHA256 一致', () => {
    if (!ROLLBACK_DRILL) { console.log('      [跳过] 未加 --rollback-drill（本项只读，加参数即可运行）'); return }
    const checks = []
    if (snapshot.registry.existed) {
      const snapCopy = path.join(snapshotDir, '.dshw-api.json')
      checks.push(['注册表快照副本', sha256(fs.readFileSync(snapCopy)) === snapshot.registry.sha256])
    }
    for (const name of PROFILE_FILES) {
      const rec = snapshot.profile[name]
      if (!rec || !rec.existed) continue
      const snapCopy = path.join(snapshotDir, 'profile-' + name)
      checks.push([`profile/${name} 快照副本`, sha256(fs.readFileSync(snapCopy)) === rec.sha256])
    }
    for (const [label, ok] of checks) console.log(`      ${ok ? '✓' : '✗'} ${label} 快照完整性=${ok}`)
    assert(checks.length > 0, '至少应有一项快照可核对')
    for (const [label, ok] of checks) assert(ok, `${label} 快照副本必须完好`)
  })
  t.test('【只读演练】目标文件当前 SHA256 与安装前对比（判断"是否需要回滚"）', () => {
    if (!ROLLBACK_DRILL) { console.log('      [跳过] 未加 --rollback-drill'); return }
    if (snapshot.registry.existed) {
      const now = fs.existsSync(WHALE_REGISTRY_REAL) ? sha256(fs.readFileSync(WHALE_REGISTRY_REAL)) : null
      console.log(`      注册表 ${WHALE_REGISTRY_REAL}`)
      console.log(`        安装前 sha256=${snapshot.registry.sha256}`)
      console.log(`        当前   sha256=${now}  一致=${now === snapshot.registry.sha256}`)
      console.log('        （回滚后应恢复到安装前的 sha256；若不一致说明回滚未完成）')
    }
    for (const name of PROFILE_FILES) {
      const rec = snapshot.profile[name]
      const src = path.join(PROFILE_DIR, name)
      if (!rec || !rec.existed) { console.log(`      profile/${name}: 安装前不存在`); continue }
      const now = fs.existsSync(src) ? sha256(fs.readFileSync(src)) : null
      console.log(`      profile/${name}: 安装前=${rec.sha256.slice(0, 16)}…  当前=${now ? now.slice(0, 16) + '…' : '缺失'}  一致=${now === rec.sha256}`)
    }
    // 回滚目标产物（我们的条目）是否存在 —— 存在则说明"回滚尚未执行"
    const reg = fs.existsSync(WHALE_REGISTRY_REAL) ? readJsonIfExists(WHALE_REGISTRY_REAL) : null
    const ours = reg && Array.isArray(reg.models) ? reg.models.filter((m) => m && m.id === (entryAfter && entryAfter.id)) : []
    console.log(`      回滚待清理的条目数=${ours.length}（>0 表示我们的条目仍在注册表里，回滚尚未执行）`)
  })
  t.test('破坏性动作边界：--execute-rollback 不存在，回滚只能由作者手工执行', () => {
    assertEq(EXECUTE_ROLLBACK, false, '本脚本不提供自动回滚开关（安全设计）')
    console.log('      实测: --execute-rollback 未启用 → 脚本全程只读；卸载/还原需作者手工执行并逐个核对 SHA256。')
  })
})

// ---------- 6. 脱敏审计 ----------
await t.group('凭据脱敏审计（SPEC §7.1）', () => {
  t.test('上游请求轨迹中不出现凭据明文（打印均脱敏）', () => {
    console.log(`      上游请求 ${upstreamCalls.length} 次：`)
    for (const c of upstreamCalls.slice(0, 12)) {
      const authShow = c.auth ? 'Bearer ' + mask(String(c.auth).replace(/^Bearer\s+/i, '')) : '(无)'
      console.log(`        ${c.stubbed ? '[stub]' : '[live]'} ${c.url.replace(/([?&](?:token|key)=)[^&]*/gi, '$1***')}  Authorization=${authShow}`)
    }
    if (SECRET) {
      for (const c of upstreamCalls) assertNotIncludes(c.url, SECRET, '请求 URL 不得含凭据明文')
    }
  })
  t.test('/status、entry 与快照文本均不含凭据明文', () => {
    if (!SECRET) { console.log('      [无法验证] 读不到真实凭据'); return }
    assertNotIncludes(JSON.stringify(statusAfter || {}), SECRET, '/status 不得含凭据明文')
    assertNotIncludes(JSON.stringify(entryAfter || {}), SECRET, 'entry 不得含凭据明文')
    const regText = fs.existsSync(registryPath) ? fs.readFileSync(registryPath, 'utf8') : ''
    assertNotIncludes(regText, SECRET, '.dshw-api.json 不得含凭据明文')
  })
})

// ---------- 清理 ----------
try {
  globalThis.fetch = realFetch
  if (serverHandle) await new Promise((r) => serverHandle.server.close(r))
  for (const d of (pluginCtx && pluginCtx._effects) || []) { try { d() } catch { /* 忽略清理异常 */ } }
} catch (err) {
  console.log(`[清理阶段异常] ${String(err && err.message)}`)
}

// ---------- 真实文件守卫 + 隔离清理 ----------
try {
  await t.group('真实文件守卫（本脚本对真实注册表的改动范围）', () => {
    t.test('真实注册表未被本脚本改动（只读模式必须严格成立）', () => {
      if (!REAL_GUARD) { console.log('      [说明] 真实注册表原本不存在'); return }
      const now = sha256(fs.readFileSync(WHALE_REGISTRY_REAL))
      console.log(`      真实注册表 ${WHALE_REGISTRY_REAL}`)
      console.log(`      运行前 sha256=${REAL_GUARD.sha256}`)
      console.log(`      运行后 sha256=${now}  一致=${now === REAL_GUARD.sha256}`)
      if (NO_WRITE) {
        assertEq(now, REAL_GUARD.sha256, '--no-write 模式真实注册表 sha256 必须完全不变')
      } else {
        console.log('      （写入模式：真实文件应由插件写入我们的条目；保留性由 A5 组验证）')
      }
    })
    t.test('隔离 home 清理', () => {
      if (!NO_WRITE) { console.log('      [说明] 写入模式无隔离 home'); return }
      console.log(`      隔离 home: ${ISOLATED_HOME}（保留供人工核对，脚本不递归删除）`)
    })
  })
} finally {
  if (ORIGINAL_DSH_HOME === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = ORIGINAL_DSH_HOME
}

await t.finish()
await t.finish()
