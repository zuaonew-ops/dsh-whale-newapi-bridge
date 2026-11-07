// verify-settings.mjs —— 设置页后端（设置文件持久化 + /settings 路由 + 热生效）验证。
//
// 方法：假 Cordis ctx 桩收集 webServer.register 的路由，再用真实 http 请求打这些 handler，
// 每个场景独立 apply 一份实例（可指定 yml 配置），用受控的 $DSH_HOME 临时目录观察设置文件读写。
// 上游 fetch 全部替换为桩：本套件完全离线、确定性、不触碰真实中转站与真实凭据。
//
// 隔离纪律（重要）：本套件把 process.env.DSH_HOME 指向临时目录（mkdtemp），
// 因此 apply / 设置文件 / 周期同步只会写临时目录；末尾用 sha256 守卫真实
// %USERPROFILE%\.dsh\.dshw-api.json 与本插件的真实设置文件全程未被改动。
import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import {
  createRunner, assert, assertEq, assertDeepEq, assertIncludes, assertNotIncludes,
  need, needFn, mask, jsonResponse, PKG_DIR, DSH_HOME_REAL, WHALE_REGISTRY_REAL, sha256,
} from './verify-helpers.mjs'

const fileUrl = (p) => 'file://' + p.replace(/\\/g, '/')

// —— 隔离：把 $DSH_HOME 换到临时目录 ——
const ISOLATED_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-verify-settings-home-'))
const ORIGINAL_DSH_HOME = process.env.DSH_HOME
process.env.DSH_HOME = ISOLATED_HOME

const SETTINGS_FILE_NAME = 'whale-newapi-bridge-settings.json'
const SETTINGS_PATH = path.join(ISOLATED_HOME, SETTINGS_FILE_NAME)
const REAL_SETTINGS_PATH = path.join(DSH_HOME_REAL, SETTINGS_FILE_NAME)

function baselineOf(file) {
  if (!fs.existsSync(file)) return null
  const stat = fs.statSync(file)
  return { hash: sha256(fs.readFileSync(file)), mtimeMs: stat.mtimeMs, bytes: stat.size }
}
const REAL_REGISTRY_BASELINE = baselineOf(WHALE_REGISTRY_REAL)
const REAL_SETTINGS_BASELINE = baselineOf(REAL_SETTINGS_PATH)

const MOD = path.join(PKG_DIR, 'lib', 'index.js')
const SETTINGS_MOD = path.join(PKG_DIR, 'lib', 'settings.mjs')
const CONFIG_MOD = path.join(PKG_DIR, 'lib', 'config.mjs')
const CLIENT_FILE = path.join(PKG_DIR, 'client.js')
const t = createRunner('verify-settings.mjs —— 设置页后端（设置文件 + /settings + 热生效）')

const SECRET = 'sk-VERIFY-SETTINGS-SECRET-0123456789abcdef'

let mod = null
let settingsMod = null
let configMod = null
let loadError = null
try {
  mod = await import(fileUrl(MOD))
  settingsMod = await import(fileUrl(SETTINGS_MOD))
  configMod = await import(fileUrl(CONFIG_MOD))
} catch (err) {
  loadError = err
}

console.log('模块: ' + MOD)
console.log('隔离 $DSH_HOME: ' + ISOLATED_HOME)
console.log('真实注册表基线: ' + (REAL_REGISTRY_BASELINE ? REAL_REGISTRY_BASELINE.hash.slice(0, 16) + '…' : '不存在') + '；真实设置文件基线: ' + (REAL_SETTINGS_BASELINE ? REAL_SETTINGS_BASELINE.hash.slice(0, 16) + '…' : '不存在'))
console.log('受控凭据: ' + mask(SECRET))

// ——— 上游 fetch 桩：任何插件内部上游请求都被拦截，保证离线 ———
const upstream = {
  status: { data: { version: 'v1.0.0-rc.40', system_name: 'New API', quota_per_unit: 500000, usd_exchange_rate: 7.3, display_in_currency: true, quota_display_type: 'CUSTOM', custom_currency_symbol: 'credits', custom_currency_exchange_rate: 1 } },
  subscription: { object: 'billing_subscription', hard_limit_usd: 20, soft_limit_usd: 20, system_hard_limit_usd: 20 },
  usage: { object: 'list', total_usage: 1834.5636 },
  models: { object: 'list', data: [{ id: 'deepseek-v4.1-flash', object: 'model' }, { id: 'gpt-4o-mini', object: 'model' }] },
}
const fetchCalls = []
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  const u = String(url)
  fetchCalls.push({ url: u, method: (init && init.method) || 'GET' })
  if (u.includes('/api/status')) return jsonResponse(upstream.status)
  if (u.includes('/v1/dashboard/billing/subscription')) return jsonResponse(upstream.subscription)
  if (u.includes('/v1/dashboard/billing/usage')) return jsonResponse(upstream.usage)
  if (u.includes('/v1/models')) return jsonResponse(upstream.models)
  if (u.includes('/dsh-whale-newapi/health')) return jsonResponse({ ok: true, name: 'dsh-whale-newapi-bridge' })
  throw new TypeError('fetch stub: 未预期请求 ' + u)
}

/** 假 ctx 桩：收集路由 + effect 清理 + 受控 credentials（与 verify-security 同构）。 */
function makeStubCtx({ credentialValue = SECRET } = {}) {
  const routes = []
  const effects = []
  const resolveCalls = []
  const ctx = {
    _routes: routes,
    _effects: effects,
    _resolveCalls: resolveCalls,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    inject(names, fn) { return fn(ctx) },
    get(name) {
      if (name === 'credentials') return credentials
      if (name === 'connection') return { on() { return () => {} } }
      if (name === 'webServer') return webServer
      return undefined
    },
    effect(fn) {
      const d = fn()
      if (typeof d === 'function') effects.push(d)
      return () => {}
    },
    on() { return () => {} },
    setInterval,
    clearInterval,
  }
  const webServer = {
    register(spec) {
      routes.push(spec)
      return () => {
        const i = routes.indexOf(spec)
        if (i >= 0) routes.splice(i, 1)
      }
    },
  }
  const credentials = {
    async resolve(ref) {
      resolveCalls.push(ref)
      if (!credentialValue) return null
      return { value: credentialValue, ref }
    },
    async set() { return true },
  }
  ctx.webServer = webServer
  ctx.credentials = credentials
  ctx.connection = { on() { return () => {} } }
  return ctx
}

/** 统一请求器：直连本机 HTTP 服务，Host 头可显式伪造。 */
async function request(port, { method = 'GET', url = '/', headers = {}, body = null, timeoutMs = 8000 } = {}) {
  return await new Promise((resolve, reject) => {
    const started = Date.now()
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers, setHost: false }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), ms: Date.now() - started }))
    })
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('请求超时(' + timeoutMs + 'ms)')) })
    if (body !== null) req.write(body)
    req.end()
  })
}

function findRoute(routes, pathname) {
  for (const r of routes) {
    if (!r || typeof r.path !== 'string') continue
    if (r.kind === 'exact' && r.path === pathname) return r
    if (r.kind === 'prefix' && pathname.startsWith(r.path)) return r
    if (!r.kind && r.path === pathname) return r
  }
  return null
}

/** 把收集到的路由挂到真实 http 服务上；未注册路径返回 404（区分没注册与被拒绝）。 */
async function serve(routes) {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname
    const route = findRoute(routes, pathname)
    if (!route) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"error":"no-route"}')
      return
    }
    try {
      const out = route.handler(req, res)
      if (out && typeof out.then === 'function') out.catch((err) => {
        if (!res.headersSent) { res.writeHead(500); res.end(JSON.stringify({ error: String(err && err.message) })) }
      })
    } catch (err) {
      if (!res.headersSent) { res.writeHead(500); res.end(JSON.stringify({ error: String(err && err.message) })) }
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port }
}

// ——— 每个场景独立一份实例，结束后统一收尾 ———
const sessions = []

async function startSession(config = {}) {
  const ctx = makeStubCtx()
  let applyError = null
  try {
    mod.apply(ctx, config)
  } catch (err) {
    applyError = err
  }
  const mounted = await serve(ctx._routes)
  const session = { ctx, server: mounted.server, port: mounted.port, applyError, closed: false }
  sessions.push(session)
  return session
}

const hostOf = (port) => '127.0.0.1:' + port

async function getJson(port, url, headers = {}) {
  const r = await request(port, { url, headers: { host: hostOf(port), ...headers } })
  let json = null
  try { json = JSON.parse(r.body) } catch { /* 非 JSON 由断言报错 */ }
  return { r, json }
}

async function postJson(port, url, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  const r = await request(port, {
    method: 'POST',
    url,
    headers: { host: hostOf(port), 'content-type': 'application/json', ...headers },
    body: text,
  })
  let json = null
  try { json = JSON.parse(r.body) } catch { /* 非 JSON 由断言报错 */ }
  return { r, json }
}

/** 等一次同步落地（runInitialSync / runSync('settings') 都是 fire-and-forget）。 */
async function settle(port, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    try {
      const { r, json } = await getJson(port, '/dsh-whale-newapi/status')
      if (r.status === 200 && json && json.ok === true) {
        last = json
        if (json.internal && json.internal.lastSyncTrigger !== null) return json
      }
    } catch { /* 服务尚未就绪，重试 */ }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return last
}

async function closeSession(session) {
  if (!session || session.closed) return
  session.closed = true
  try { await settle(session.port, 1500) } catch { /* 收尾失败不影响结论 */ }
  try { await new Promise((resolve) => session.server.close(resolve)) } catch { /* ignore */ }
  for (const dispose of session.ctx._effects) {
    try { dispose() } catch { /* ignore */ }
  }
  const i = sessions.indexOf(session)
  if (i >= 0) sessions.splice(i, 1)
}

async function closeAll() {
  for (const session of [...sessions]) await closeSession(session)
}

/** 便捷包装：开一个实例跑用例，无论成败都收尾。 */
async function withSession(config, fn) {
  const session = await startSession(config)
  try {
    return await fn(session)
  } finally {
    await closeSession(session)
  }
}

function resetSettingsFile() {
  try { fs.rmSync(SETTINGS_PATH, { force: true }) } catch { /* ignore */ }
}
function writeSettingsFile(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n'
  fs.writeFileSync(SETTINGS_PATH, text, 'utf8')
}
function readSettingsValue() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) } catch { return null }
}
function settingsFileHash() {
  try { return sha256(fs.readFileSync(SETTINGS_PATH)) } catch { return null }
}

const SETTINGS_ROUTE = '/dsh-whale-newapi/settings'
const RESET_ROUTE = '/dsh-whale-newapi/settings/reset'
const STATUS_ROUTE = '/dsh-whale-newapi/status'
const HEALTH_ROUTE = '/dsh-whale-newapi/health'
const ALL_ROUTE_PATHS = [
  '/dsh-whale-newapi/balance',
  '/dsh-whale-newapi/health',
  '/dsh-whale-newapi/settings',
  '/dsh-whale-newapi/settings/reset',
  '/dsh-whale-newapi/status',
  '/dsh-whale-newapi/sync',
]


if (loadError) {
  console.log('\n!! 无法加载模块，设置页验证无法执行：\n' + (loadError.stack || loadError))
  console.log('SUMMARY: BLOCKED（lib/index.js / lib/settings.mjs / lib/config.mjs 缺失或不可加载）')
  process.exitCode = 2
} else {
  try {
    const name = need(mod, 'name', 'index')
    const inject = need(mod, 'inject', 'index')
    const apply = needFn(mod, 'apply', 'index')

    /**
     * 每个场景独立 apply 一份实例（yml 配置可定制），组内用例**同步登记**、串行执行。
     * 注意：createRunner 的 t.test() 必须在 t.group(...) 同步上下文中登记，
     * 因此这里先完成异步 setup（起服务），再进同步 group 回调登记用例。
     */
    async function scenarioGroup(label, config, register) {
      const session = await startSession(config)
      try {
        await t.group(label, () => register(session))
      } finally {
        await closeSession(session)
      }
    }

    /** 带预置设置文件的场景。 */
    async function fileScenarioGroup(label, fileValue, config, register) {
      resetSettingsFile()
      writeSettingsFile(fileValue)
      try {
        await scenarioGroup(label, config, register)
      } finally {
        resetSettingsFile()
      }
    }

    /** 等同步触发源变成期望值（设置保存后的 runSync('settings') 是 fire-and-forget）。 */
    async function waitForTrigger(port, trigger, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        try {
          const { r, json } = await getJson(port, STATUS_ROUTE)
          if (r.status === 200 && json && json.ok === true && json.internal && json.internal.lastSyncTrigger === trigger) return json
        } catch { /* 服务尚未就绪，重试 */ }
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      return null
    }

    // ---------- 模块形状 / 版本 / 持久化层导出 ----------
    await t.group('模块形状、版本与持久化层导出（SPEC §3 / §4.7）', () => {
      t.test("name === 'dsh-whale-newapi-bridge'", () => assertEq(name, 'dsh-whale-newapi-bridge', 'name'))
      t.test("inject 含 'webServer'", () => {
        assert(Array.isArray(inject) && inject.includes('webServer'), 'inject 必须含 webServer，实际 ' + JSON.stringify(inject))
      })
      t.test('apply 是函数', () => assertEq(typeof apply, 'function', 'apply'))
      t.test('lib/settings.mjs 导出 SETTINGS_FILE', () => {
        assertEq(need(settingsMod, 'SETTINGS_FILE', 'settings'), SETTINGS_FILE_NAME, 'SETTINGS_FILE')
      })
      t.test('PERSISTED_KEYS 是 16 个固定顺序的配置键', () => {
        const keys = need(settingsMod, 'PERSISTED_KEYS', 'settings')
        assertEq(keys.length, 16, 'PERSISTED_KEYS 长度')
        assertDeepEq([...keys], [
          'baseUrl', 'credentialRef', 'credentialCandidates', 'authMode', 'userId',
          'modelId', 'modelName', 'currency', 'usdToCny', 'quotaPerUnit', 'fallbackTotal',
          'bridgeBaseUrl', 'autoSync', 'syncIntervalSeconds', 'requestTimeoutMs', 'enabled',
        ], 'PERSISTED_KEYS 顺序必须与 DEFAULT_CONFIG 一致')
      })
      t.test('resolveSettingsPath() 读取 $DSH_HOME', () => {
        const fn = needFn(settingsMod, 'resolveSettingsPath', 'settings')
        assertEq(fn(), SETTINGS_PATH, '默认解析结果')
        assertEq(fn('/tmp/another-home'), path.join('/tmp/another-home', SETTINGS_FILE_NAME), '显式 dshHome 优先')
      })
      t.test("PLUGIN_VERSION === '0.2.0'", () => {
        assertEq(need(configMod, 'PLUGIN_VERSION', 'config'), '0.2.0', 'PLUGIN_VERSION')
      })
      t.test('package.json version=0.2.0、exports[./client]、files 含 client.js、dsh.client', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8'))
        assertEq(pkg.version, '0.2.0', 'package.json version')
        assertEq(pkg.exports['./client'], './client.js', 'exports 的 ./client')
        assert((pkg.files || []).includes('client.js'), 'files 必须含 client.js，实际 ' + JSON.stringify(pkg.files))
        assert(pkg.dsh && pkg.dsh.client, 'package.json 必须有 dsh.client（设置页浏览器模块）')
        assertEq(pkg.dsh.client.platform, 'web', 'dsh.client.platform')
        assertEq(pkg.dsh.client.immediately, true, 'dsh.client.immediately')
        assert(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0, '不得新增运行时依赖')
      })
      t.test('client.js 存在且是 __ModuleLoader__ 浏览器模块（settings.section）', () => {
        assert(fs.existsSync(CLIENT_FILE), 'client.js 必须存在')
        const text = fs.readFileSync(CLIENT_FILE, 'utf8')
        assertIncludes(text, '__ModuleLoader__', 'client.js 必须走 __ModuleLoader__.load')
        assertIncludes(text, 'dsh-whale-newapi-bridge', 'client.js 的模块 id')
        assertIncludes(text, "'settings.section'", 'client.js 必须注入 settings.section')
        assertIncludes(text, 'var(--dsw-alias-', 'client.js 必须只用 --dsw-alias-* 设计变量')
      })
    })

    // ---------- apply 挂载：6 条路由 ----------
    resetSettingsFile()
    await scenarioGroup('apply 挂载：注册 6 条路由（balance/status/sync/health/settings/settings-reset）', { syncIntervalSeconds: 120, userId: 'u_settings_1', modelName: 'yml 站名' }, (session) => {
      t.test('apply(ctx, {...}) 不抛异常', () => assertEq(session.applyError, null, 'apply 抛了: ' + (session.applyError && session.applyError.message)))
      t.test('恰好注册 6 条精确路由（含 settings / settings/reset）', () => {
        const paths = session.ctx._routes.map((r) => r.path)
        console.log('      实际注册: ' + JSON.stringify(paths))
        assertDeepEq([...paths].sort(), [...ALL_ROUTE_PATHS].sort(), '路由清单必须与 SPEC §6 一致')
        for (const r of session.ctx._routes) assertEq(r.kind, 'exact', r.path + ' 的 kind')
      })
      t.test('每条路由都是函数 handler', () => {
        for (const r of session.ctx._routes) assertEq(typeof r.handler, 'function', r.path + ' 的 handler')
      })
      t.test('/health 返回 version 0.2.0', async () => {
        const { r, json } = await getJson(session.port, HEALTH_ROUTE)
        assertEq(r.status, 200, '/health 状态')
        assertEq(json.ok, true, 'health ok')
        assertEq(json.version, '0.2.0', 'health version')
      })
      t.test('/status 新增 settings.file，persistedKeys 为空数组', async () => {
        const { r, json } = await getJson(session.port, STATUS_ROUTE)
        assertEq(r.status, 200, '/status 状态')
        assertEq(json.ok, true, '/status ok')
        assert(json.settings && typeof json.settings === 'object', '/status 必须含 settings 对象')
        assertEq(json.settings.file, SETTINGS_PATH, 'status.settings.file')
        assertDeepEq(json.settings.persistedKeys, [], 'status.settings.persistedKeys')
      })
    })

    // ---------- a) GET /settings（无设置文件） ----------
    resetSettingsFile()
    await scenarioGroup('a) GET /settings：无设置文件时返回默认/yml 配置', { syncIntervalSeconds: 120, userId: 'u_settings_1', modelName: 'yml 站名' }, (session) => {
      let first = null
      t.test('GET /settings → 200 JSON（扁平 ok:true，不是 {ok,value} 信封）', async () => {
        const { r, json } = await getJson(session.port, SETTINGS_ROUTE)
        assertEq(r.status, 200, 'HTTP 状态（body=' + r.body.slice(0, 200) + '）')
        assertIncludes(String(r.headers['content-type']), 'application/json', 'content-type')
        assert(json !== null, '响应必须是 JSON')
        assertEq(json.ok, true, 'ok')
        assert(!('value' in json), '设置接口是扁平响应，不应出现 value 信封')
        first = json
      })
      t.test('config 覆盖全部 16 个可编辑配置键且取 yml 值', () => {
        assert(first && first.config, '缺少 config')
        assertEq(Object.keys(first.config).length, 16, 'config 键数')
        assertEq(first.config.syncIntervalSeconds, 120, 'config.syncIntervalSeconds')
        assertEq(first.config.modelName, 'yml 站名', 'config.modelName')
        assertEq(first.config.userId, 'u_settings_1', '设置页必须能回填真实 userId（仅回环可用）')
        assertEq(first.config.credentialRef, 'NEWAPI_RELAY_TOKEN', 'config.credentialRef')
        assertDeepEq(first.config.credentialCandidates, ['NEWAPI_RELAY_TOKEN', 'NEWAPI_API_KEY', 'PI_API_KEY'], 'config.credentialCandidates')
      })
      t.test('persisted 为空对象、settingsPath 指向 $DSH_HOME 下的设置文件', () => {
        assertDeepEq(first.persisted, {}, 'persisted')
        assertEq(first.settingsPath, SETTINGS_PATH, 'settingsPath')
        assertEq(first.version, '0.2.0', 'version')
      })
      t.test('sync 摘要字段齐全', () => {
        assert(first.sync && 'lastSyncAt' in first.sync && 'lastSyncResult' in first.sync && 'lastSyncTrigger' in first.sync, 'sync 摘要字段')
      })
      t.test('warnings 是数组并含 authMode=auto 提示', () => {
        assert(Array.isArray(first.warnings), 'warnings 必须是数组')
        assertIncludes(first.warnings.join('\n'), 'authMode=auto', 'warnings 应含 authMode 提示')
      })
      t.test('凭据摘要可解析且响应不含凭据明文', async () => {
        await settle(session.port, 3000)
        const { r, json } = await getJson(session.port, SETTINGS_ROUTE)
        assert(json.credential && json.credential.ref === 'NEWAPI_RELAY_TOKEN', 'credential.ref')
        assertEq(json.credential.present, true, 'credential.present（受控凭据可解析）')
        assertNotIncludes(r.body, SECRET, 'GET /settings 响应不得含凭据明文')
      })
      t.test('/status 对公网形态只暴露 userId=<set>，设置页接口回填真实值', async () => {
        const { json } = await getJson(session.port, STATUS_ROUTE)
        assertEq(json.config.userId, '<set>', '/status.config.userId 必须脱敏')
      })
    })

    // ---------- b) 信任栅栏 ----------
    resetSettingsFile()
    await scenarioGroup('b) 信任栅栏：设置路由同样只允许回环同源（SPEC §6 → 403）', {}, (session) => {
      const fenceCases = [
        ['GET /settings + 伪造 Host: evil.com', 'GET', SETTINGS_ROUTE, { host: 'evil.com' }],
        ['GET /settings + Host 缺失（HTTP/1.0 无 Host）', 'GET', SETTINGS_ROUTE, { host: '' }],
        ['GET /settings + Host 不可解析', 'GET', SETTINGS_ROUTE, { host: 'not a host' }],
        ['GET /settings + Sec-Fetch-Site: cross-site', 'GET', SETTINGS_ROUTE, { host: hostOf(session.port), 'sec-fetch-site': 'cross-site' }],
        ['GET /settings + Origin http://evil.com', 'GET', SETTINGS_ROUTE, { host: hostOf(session.port), origin: 'http://evil.com' }],
        ['POST /settings + 伪造 Host', 'POST', SETTINGS_ROUTE, { host: 'evil.com' }],
        ['POST /settings/reset + 伪造 Host', 'POST', RESET_ROUTE, { host: 'evil.com' }],
        ['GET /settings/reset + 伪造 Host', 'GET', RESET_ROUTE, { host: 'evil.com' }],
      ]
      for (const [label, method, url, headers] of fenceCases) {
        t.test(label + ' → 403', async () => {
          const r = method === 'POST'
            ? await request(session.port, { method, url, headers, body: '{}' })
            : await request(session.port, { url, headers })
          assertEq(r.status, 403, 'HTTP 状态（body=' + r.body.slice(0, 160) + '）')
          assertNotIncludes(r.body, SECRET, '403 响应体不得含凭据')
        })
      }
      t.test('回环 + 同源 Origin 放行 GET', async () => {
        const { r } = await getJson(session.port, SETTINGS_ROUTE, { origin: 'http://127.0.0.1:' + session.port })
        assertEq(r.status, 200, 'HTTP 状态')
      })
      t.test('回环 + 同源 Origin 放行 POST 保存', async () => {
        const { r } = await postJson(session.port, SETTINGS_ROUTE, { modelName: '同源保存' }, { origin: 'http://127.0.0.1:' + session.port })
        assertEq(r.status, 200, 'HTTP 状态（body=' + r.body.slice(0, 200) + '）')
      })
    })
    resetSettingsFile()

    // ---------- c) POST 保存 + 热生效 ----------
    resetSettingsFile()
    await scenarioGroup('c) POST /settings：校验 → 原子写 → 热生效 → /status 反映', { syncIntervalSeconds: 120, modelName: 'yml 站名' }, (session) => {
      t.test('POST 合法 patch → 200 且 applied 列出生效键', async () => {
        const { r, json } = await postJson(session.port, SETTINGS_ROUTE, { syncIntervalSeconds: 45, modelName: ' 测试中转站 ' })
        assertEq(r.status, 200, 'HTTP 状态（body=' + r.body.slice(0, 300) + '）')
        assertEq(json.ok, true, 'ok')
        assertDeepEq(json.applied, ['syncIntervalSeconds', 'modelName'], 'applied')
        assertEq(json.config.syncIntervalSeconds, 45, 'config 热生效')
        assertEq(json.config.modelName, '测试中转站', 'modelName 去除首尾空白')
        assertDeepEq(json.persisted, { syncIntervalSeconds: 45, modelName: '测试中转站' }, 'persisted')
      })
      t.test('设置文件已原子写入且内容只含覆盖键', () => {
        assert(fs.existsSync(SETTINGS_PATH), '设置文件必须存在')
        assertDeepEq(readSettingsValue(), { syncIntervalSeconds: 45, modelName: '测试中转站' }, '设置文件内容')
        const text = fs.readFileSync(SETTINGS_PATH, 'utf8')
        assert(text.endsWith('\n'), '设置文件应以换行结尾')
        assertNotIncludes(text, SECRET, '设置文件不得含凭据明文')
      })
      t.test('GET /settings 反映持久化值', async () => {
        const { json } = await getJson(session.port, SETTINGS_ROUTE)
        assertDeepEq(json.persisted, { syncIntervalSeconds: 45, modelName: '测试中转站' }, 'persisted')
        assertEq(json.config.syncIntervalSeconds, 45, 'config.syncIntervalSeconds')
      })
      t.test('/status 热生效：internal.syncIntervalSeconds 与 settings.persistedKeys', async () => {
        const { json } = await getJson(session.port, STATUS_ROUTE)
        assertEq(json.internal.syncIntervalSeconds, 45, 'internal.syncIntervalSeconds')
        assertEq(json.config.syncIntervalSeconds, 45, 'publicConfig.syncIntervalSeconds')
        assertDeepEq(json.settings.persistedKeys, ['modelName', 'syncIntervalSeconds'], 'settings.persistedKeys 按固定键序')
      })
      t.test('第二次 POST 合并覆盖层（只提交变化键）', async () => {
        const { r, json } = await postJson(session.port, SETTINGS_ROUTE, { autoSync: false, credentialCandidates: ['NEWAPI_RELAY_TOKEN', 'NEWAPI_API_KEY'] })
        assertEq(r.status, 200, 'HTTP 状态（body=' + r.body.slice(0, 300) + '）')
        assertDeepEq(json.applied, ['autoSync', 'credentialCandidates'], 'applied')
        assertEq(json.config.autoSync, false, 'config.autoSync 热生效')
        assertDeepEq(readSettingsValue(), {
          syncIntervalSeconds: 45,
          modelName: '测试中转站',
          credentialCandidates: ['NEWAPI_RELAY_TOKEN', 'NEWAPI_API_KEY'],
          autoSync: false,
        }, '设置文件合并后的内容')
      })
      t.test('/status 的 internal.autoSync 反映新值', async () => {
        const { json } = await getJson(session.port, STATUS_ROUTE)
        assertEq(json.internal.autoSync, false, 'internal.autoSync')
      })
      t.test('POST 非法值失败时设置文件保持不变（不半写）', async () => {
        const before = settingsFileHash()
        const { r, json } = await postJson(session.port, SETTINGS_ROUTE, { syncIntervalSeconds: 2 })
        assertEq(r.status, 400, 'HTTP 状态')
        assertEq(json.code, 'BAD_SETTINGS', '错误码')
        assertEq(settingsFileHash(), before, '失败保存不得改动设置文件')
      })
      t.test('合法保存后 runSync(settings) 触发一次同步（lastSyncTrigger=settings）', async () => {
        const { r } = await postJson(session.port, SETTINGS_ROUTE, { modelName: '触发同步' })
        assertEq(r.status, 200, 'HTTP 状态')
        const status = await waitForTrigger(session.port, 'settings', 3000)
        assert(status !== null, '3s 内未见 lastSyncTrigger=settings')
        assertEq(status.internal.lastSyncTrigger, 'settings', 'lastSyncTrigger')
        assert(status.whale && status.whale.lastSyncAt !== null, '同步应写入 lastSyncAt：' + JSON.stringify(status.whale))
      })
    })
    resetSettingsFile()

    // ---------- d) 非法补丁 ----------
    resetSettingsFile()
    await scenarioGroup('d) POST /settings 非法补丁：400 + 字段级错误 + 不落盘', { syncIntervalSeconds: 120 }, (session) => {
      const badCases = [
        ['未知键', { notAKey: 1 }, 'notAKey'],
        ['baseUrl 非 http(s)', { baseUrl: 'ftp://relay.example.com' }, 'baseUrl'],
        ['baseUrl 带 userinfo', { baseUrl: 'http://user:pass@127.0.0.1:3000' }, 'baseUrl'],
        ['credentialRef 含非法字符', { credentialRef: 'TOKEN-A' }, 'credentialRef'],
        ['credentialCandidates 不是数组', { credentialCandidates: 'TOKEN' }, 'credentialCandidates'],
        ['credentialCandidates 元素非法', { credentialCandidates: ['OK_ONE', 'bad-ref'] }, 'credentialCandidates'],
        ['authMode 不在枚举内', { authMode: 'bearer' }, 'authMode'],
        ['modelId 含点号', { modelId: 'newapi.relay' }, 'modelId'],
        ['modelName 为空', { modelName: '   ' }, 'modelName'],
        ['modelName 超长', { modelName: 'x'.repeat(101) }, 'modelName'],
        ['currency 不支持', { currency: 'EUR' }, 'currency'],
        ['usdToCny 负数', { usdToCny: -1 }, 'usdToCny'],
        ['quotaPerUnit 非数字', { quotaPerUnit: '500000' }, 'quotaPerUnit'],
        ['fallbackTotal 非有限数', { fallbackTotal: Number.POSITIVE_INFINITY }, 'fallbackTotal'],
        ['bridgeBaseUrl 非回环', { bridgeBaseUrl: 'http://203.0.113.10:19387' }, 'bridgeBaseUrl'],
        ['syncIntervalSeconds 越界', { syncIntervalSeconds: 3 }, 'syncIntervalSeconds'],
        ['requestTimeoutMs 非整数', { requestTimeoutMs: 1500.5 }, 'requestTimeoutMs'],
        ['autoSync 非布尔', { autoSync: 'yes' }, 'autoSync'],
        ['enabled 非布尔', { enabled: 1 }, 'enabled'],
        ['userId 含控制字符', { userId: 'bad' + String.fromCharCode(7) + 'id' }, 'userId'],
      ]
      for (const [label, patch, key] of badCases) {
        t.test(label + ' → 400 BAD_SETTINGS（fields.' + key + '）', async () => {
          const { r, json } = await postJson(session.port, SETTINGS_ROUTE, patch)
          assertEq(r.status, 400, 'HTTP 状态（body=' + r.body.slice(0, 240) + '）')
          assertEq(json.ok, false, 'ok 必须为 false')
          assertEq(json.code, 'BAD_SETTINGS', '错误码')
          assert(json.fields && typeof json.fields[key] === 'string', 'fields.' + key + ' 必须给出可读原因，实际 ' + JSON.stringify(json.fields))
          assert(!fs.existsSync(SETTINGS_PATH), '校验失败不得创建设置文件')
        })
      }
      t.test('非法用例覆盖 ≥ 6 种（实际 ' + badCases.length + ' 种）', () => assert(badCases.length >= 6, '用例不足'))
      t.test('一次提交多个坏键：errors 全部收集而非首错即停', async () => {
        const { r, json } = await postJson(session.port, SETTINGS_ROUTE, { baseUrl: 'ftp://x', authMode: 'bearer', syncIntervalSeconds: 1 })
        assertEq(r.status, 400, 'HTTP 状态')
        assertDeepEq(Object.keys(json.fields || {}).sort(), ['authMode', 'baseUrl', 'syncIntervalSeconds'], '缺失多键错误收集')
      })
      t.test('已存在的设置文件在非法提交后保持逐字节不变', async () => {
        const ok = await postJson(session.port, SETTINGS_ROUTE, { modelName: '合法站名' })
        assertEq(ok.r.status, 200, '先做一次合法保存')
        const before = settingsFileHash()
        const bad = await postJson(session.port, SETTINGS_ROUTE, { modelName: '合法站名', usdToCny: -2 })
        assertEq(bad.r.status, 400, '非法提交状态')
        assertEq(settingsFileHash(), before, '设置文件必须保持原样')
        assertDeepEq(readSettingsValue(), { modelName: '合法站名' }, '文件内容保持原样')
      })
      t.test('请求体不是 JSON 对象 → 400 BAD_REQUEST', async () => {
        const array = await postJson(session.port, SETTINGS_ROUTE, [1, 2, 3])
        assertEq(array.r.status, 400, '数组 body 状态（body=' + array.r.body.slice(0, 160) + '）')
        assertEq(array.json.code, 'BAD_REQUEST', '数组 body 错误码')
        const broken = await postJson(session.port, SETTINGS_ROUTE, '{not json')
        assertEq(broken.r.status, 400, '坏 JSON body 状态')
        assertEq(broken.json.code, 'BAD_REQUEST', '坏 JSON 错误码')
      })
    })
    resetSettingsFile()

    // ---------- e) 设置文件优先于 yml ----------
    resetSettingsFile()
    await fileScenarioGroup('e) 优先级：设置文件 > yml > 默认（SPEC §4.7）', { syncIntervalSeconds: 60, modelName: '文件站名' }, { syncIntervalSeconds: 300, modelName: 'yml 站名' }, (session) => {
      t.test('/status 反映设置文件的 syncIntervalSeconds=60 而非 yml 的 300', async () => {
        const { json } = await getJson(session.port, STATUS_ROUTE)
        assertEq(json.internal.syncIntervalSeconds, 60, 'internal.syncIntervalSeconds')
        assertEq(json.config.syncIntervalSeconds, 60, 'publicConfig.syncIntervalSeconds')
        assertEq(json.config.modelName, '文件站名', 'modelName 也被设置文件覆盖')
        assertDeepEq(json.settings.persistedKeys, ['modelName', 'syncIntervalSeconds'], 'persistedKeys')
      })
      t.test('GET /settings 同时给出合并结果与持久化覆盖值', async () => {
        const { json } = await getJson(session.port, SETTINGS_ROUTE)
        assertEq(json.config.syncIntervalSeconds, 60, 'config 为合并后的生效值')
        assertDeepEq(json.persisted, { syncIntervalSeconds: 60, modelName: '文件站名' }, 'persisted 只有文件里的键')
        assertEq(json.config.baseUrl, 'http://127.0.0.1:3000', '未覆盖的键仍取默认/yml')
      })
      t.test('POST 部分更新后，未被 patch 的持久化键继续生效', async () => {
        const { r, json } = await postJson(session.port, SETTINGS_ROUTE, { modelName: '再改一次' })
        assertEq(r.status, 200, 'HTTP 状态（body=' + r.body.slice(0, 240) + '）')
        assertDeepEq(json.applied, ['modelName'], 'applied 只含提交键')
        assertEq(json.config.syncIntervalSeconds, 60, '未提交的持久化键保持生效')
        assertDeepEq(readSettingsValue(), { syncIntervalSeconds: 60, modelName: '再改一次' }, '文件内两键都在')
      })
    })

    // ---------- f) 设置文件损坏 ----------
    await fileScenarioGroup('f1) 设置文件不是合法 JSON：apply 不抛，warn 并整体回退 yml', '{ this is not json ', { syncIntervalSeconds: 240, modelName: 'yml 兜底' }, (session) => {
      t.test('坏 JSON：apply 不抛异常（宿主不受影响）', () => {
        assertEq(session.applyError, null, 'apply 抛了: ' + (session.applyError && session.applyError.message))
      })
      t.test('/status warnings 提示设置文件不是合法 JSON', async () => {
        const { json } = await getJson(session.port, STATUS_ROUTE)
        assertEq(json.ok, true, '/status ok')
        const text = (json.warnings || []).join('\n')
        assertIncludes(text, '不是合法 JSON', 'warnings 文案')
        assertIncludes(text, SETTINGS_FILE_NAME, 'warnings 应指出文件路径')
      })
      t.test('配置整体回退到 yml 值', async () => {
        const { json } = await getJson(session.port, STATUS_ROUTE)
        assertEq(json.internal.syncIntervalSeconds, 240, 'syncIntervalSeconds 回退 yml')
        assertDeepEq(json.settings.persistedKeys, [], '坏文件不产生持久化键')
      })
      t.test('损坏文件在启动时不被覆盖（只读忽略）', () => {
        assertEq(fs.readFileSync(SETTINGS_PATH, 'utf8'), '{ this is not json ', '启动不得改写损坏文件')
      })
      t.test('损坏文件下保存合法设置可以自愈', async () => {
        const { r, json } = await postJson(session.port, SETTINGS_ROUTE, { modelName: '自愈站名' })
        assertEq(r.status, 200, 'HTTP 状态（body=' + r.body.slice(0, 240) + '）')
        assertDeepEq(json.persisted, { modelName: '自愈站名' }, 'persisted')
        assertDeepEq(readSettingsValue(), { modelName: '自愈站名' }, '设置文件被重写为合法 JSON')
      })
    })

    await fileScenarioGroup('f2) 设置文件顶层是数组：warn 并忽略整个文件', [1, 2, 3], { syncIntervalSeconds: 240 }, (session) => {
      t.test('顶层是数组：apply 不抛、warn 并回退 yml', async () => {
        assertEq(session.applyError, null, 'apply 不得抛')
        const { json } = await getJson(session.port, STATUS_ROUTE)
        assertIncludes((json.warnings || []).join('\n'), '必须是 JSON 对象', 'warnings 文案')
        assertEq(json.internal.syncIntervalSeconds, 240, '回退 yml')
        assertDeepEq(json.settings.persistedKeys, [], '不产生持久化键')
      })
    })

    await fileScenarioGroup('f3) 设置文件含未知键：丢弃未知键但保留已知键', { syncIntervalSeconds: 90, totallyUnknown: 'x' }, { syncIntervalSeconds: 240 }, (session) => {
      t.test('未知键被丢弃但已知键保留', async () => {
        const { json } = await getJson(session.port, STATUS_ROUTE)
        assertEq(json.internal.syncIntervalSeconds, 90, '已知键仍生效')
        assertIncludes((json.warnings || []).join('\n'), '未知键', 'warnings 应提示未知键')
        assertDeepEq(readSettingsValue(), { syncIntervalSeconds: 90, totallyUnknown: 'x' }, '启动不清理文件内容')
      })
    })

    // ---------- g) 逐键回退 ----------
    await fileScenarioGroup('g) 设置文件里的坏键逐键回退 yml，其余键照常生效', { syncIntervalSeconds: 'abc', baseUrl: 'not-a-url', modelName: '好的站名', autoSync: false }, { syncIntervalSeconds: 240, baseUrl: 'http://127.0.0.1:3000', autoSync: true }, (session) => {
      t.test('坏键回退 yml、好键生效', async () => {
        const { json } = await getJson(session.port, STATUS_ROUTE)
        assertEq(json.internal.syncIntervalSeconds, 240, '坏键 syncIntervalSeconds 回退 yml=240')
        assertEq(json.config.baseUrl, 'http://127.0.0.1:3000', '坏键 baseUrl 回退默认')
        assertEq(json.config.modelName, '好的站名', '好键 modelName 生效')
        assertEq(json.internal.autoSync, false, '好键 autoSync 生效')
        assertDeepEq(json.settings.persistedKeys, ['modelName', 'autoSync'], '只有合法键进入持久化集合')
      })
      t.test('warnings 逐键说明回退原因', async () => {
        const { json } = await getJson(session.port, STATUS_ROUTE)
        const text = (json.warnings || []).join('\n')
        assertIncludes(text, 'syncIntervalSeconds', 'warnings 提到坏键名')
        assertIncludes(text, '已退回 yml 的值', 'warnings 解释回退语义')
        assertIncludes(text, 'baseUrl', 'warnings 提到 baseUrl')
      })
      t.test('用设置页修正坏键即可恢复（保存覆盖层写回合法值）', async () => {
        const { r, json } = await postJson(session.port, SETTINGS_ROUTE, { syncIntervalSeconds: 30 })
        assertEq(r.status, 200, 'HTTP 状态（body=' + r.body.slice(0, 240) + '）')
        assertEq(json.config.syncIntervalSeconds, 30, 'config 热生效')
        assertDeepEq(readSettingsValue(), { syncIntervalSeconds: 30, modelName: '好的站名', autoSync: false }, '文件里恢复合法键集合')
      })
    })

    // ---------- h) reset ----------
    resetSettingsFile()
    await scenarioGroup('h) POST /settings/reset：删除设置文件并回退 yml', { syncIntervalSeconds: 210, modelName: 'yml 站名' }, (session) => {
      t.test('先保存一次，确认文件存在且生效', async () => {
        const { r } = await postJson(session.port, SETTINGS_ROUTE, { syncIntervalSeconds: 30, modelName: '将被重置' })
        assertEq(r.status, 200, 'HTTP 状态')
        assert(fs.existsSync(SETTINGS_PATH), '设置文件应存在')
        const { json } = await getJson(session.port, STATUS_ROUTE)
        assertEq(json.internal.syncIntervalSeconds, 30, '重置前生效值')
      })
      t.test('reset → 200、文件删除、恢复 yml 值', async () => {
        const { r, json } = await postJson(session.port, RESET_ROUTE, {})
        assertEq(r.status, 200, 'HTTP 状态（body=' + r.body.slice(0, 240) + '）')
        assertEq(json.ok, true, 'ok')
        assertDeepEq(json.persisted, {}, 'persisted 清空')
        assertEq(json.config.syncIntervalSeconds, 210, 'config 回退 yml')
        assert(!fs.existsSync(SETTINGS_PATH), '设置文件必须被删除')
      })
      t.test('/status 的 persistedKeys 清空且值回退', async () => {
        const { json } = await getJson(session.port, STATUS_ROUTE)
        assertDeepEq(json.settings.persistedKeys, [], 'persistedKeys')
        assertEq(json.internal.syncIntervalSeconds, 210, 'internal.syncIntervalSeconds')
      })
      t.test('reset 幂等：设置文件不存在时仍返回 200', async () => {
        const { r, json } = await postJson(session.port, RESET_ROUTE, {})
        assertEq(r.status, 200, 'HTTP 状态')
        assertEq(json.ok, true, 'ok')
        assertDeepEq(json.persisted, {}, 'persisted')
      })
    })
    resetSettingsFile()

    // ---------- i) 安全：凭据不落盘、不进响应 ----------
    resetSettingsFile()
    await scenarioGroup('i) 安全边界：凭据明文永不进设置文件/响应/日志', { syncIntervalSeconds: 120 }, (session) => {
      t.test('保存全部字段后设置文件不含凭据明文', async () => {
        const { r } = await postJson(session.port, SETTINGS_ROUTE, {
          baseUrl: 'http://127.0.0.1:3000',
          credentialRef: 'NEWAPI_RELAY_TOKEN',
          credentialCandidates: ['NEWAPI_RELAY_TOKEN'],
          authMode: 'auto',
          userId: 'user-1',
          modelId: 'newapi_relay',
          currency: 'CNY',
          usdToCny: 7.3,
          quotaPerUnit: 500000,
          fallbackTotal: 100,
          bridgeBaseUrl: 'http://127.0.0.1:19387',
          autoSync: true,
          syncIntervalSeconds: 120,
          requestTimeoutMs: 15000,
          enabled: true,
        })
        assertEq(r.status, 200, 'HTTP 状态（body=' + r.body.slice(0, 300) + '）')
        const text = fs.readFileSync(SETTINGS_PATH, 'utf8')
        assertNotIncludes(text, SECRET, '设置文件不得含凭据明文')
        assertIncludes(text, 'NEWAPI_RELAY_TOKEN', '设置文件只存凭据引用名')
      })
      t.test('GET /settings 与 /status 响应都不含凭据明文', async () => {
        const a = await getJson(session.port, SETTINGS_ROUTE)
        const b = await getJson(session.port, STATUS_ROUTE)
        assertNotIncludes(a.r.body, SECRET, 'GET /settings 含凭据')
        assertNotIncludes(b.r.body, SECRET, '/status 含凭据')
        assertIncludes(a.r.body, 'NEWAPI_RELAY_TOKEN', '引用名可回填')
      })
      t.test('/settings 的 credential 摘要只给 ref/present/source', async () => {
        await settle(session.port, 3000)
        const { json } = await getJson(session.port, SETTINGS_ROUTE)
        assertDeepEq(Object.keys(json.credential).sort(), ['present', 'ref', 'source'], 'credential 摘要字段')
        assertEq(json.credential.present, true, 'present')
      })
      t.test('/sync 仍要求 Bearer 鉴权（SPEC §10.1 不变）', async () => {
        const noAuth = await postJson(session.port, '/dsh-whale-newapi/sync', {})
        assertEq(noAuth.r.status, 401, '缺 Bearer 必须 401（实际 ' + noAuth.r.status + '）')
        assertEq(noAuth.json.code, 'UNAUTHORIZED', '缺 Bearer 错误码')
        const wrong = await request(session.port, {
          method: 'POST',
          url: '/dsh-whale-newapi/sync',
          headers: { host: hostOf(session.port), authorization: 'Bearer ' + 'sk-wrong-bearer-000', 'content-type': 'application/json' },
          body: '{}',
        })
        assertEq(wrong.status, 401, '错误 Bearer 必须 401')
        assertNotIncludes(wrong.body, SECRET, '401 响应不得回显凭据')
      })
    })
    resetSettingsFile()

    // ---------- j) 405 ----------
    resetSettingsFile()
    await scenarioGroup('j) 方法约束：settings/reset 只接受 POST，settings 只接受 GET/POST', {}, (session) => {
      const h = { host: hostOf(session.port) }
      const cases = [
        ['GET /settings/reset → 405', { method: 'GET', url: RESET_ROUTE, headers: h }, 'POST'],
        ['PUT /settings → 405', { method: 'PUT', url: SETTINGS_ROUTE, headers: { ...h, 'content-type': 'application/json' }, body: '{}' }, 'GET / POST'],
        ['DELETE /settings/reset → 405', { method: 'DELETE', url: RESET_ROUTE, headers: h }, 'POST'],
        ['PATCH /settings → 405', { method: 'PATCH', url: SETTINGS_ROUTE, headers: h }, 'GET / POST'],
      ]
      for (const [label, opts, expected] of cases) {
        t.test(label, async () => {
          const r = await request(session.port, opts)
          assertEq(r.status, 405, 'HTTP 状态（body=' + r.body.slice(0, 160) + '）')
          const json = JSON.parse(r.body)
          assertEq(json.ok, false, 'ok')
          assertEq(json.code, 'METHOD', '错误码')
          assertIncludes(json.error, expected, '错误文案应说明允许的方法')
        })
      }
    })

    // ---------- 隔离守卫 ----------
    await t.group('隔离守卫：真实 ~/.dsh 未被触碰', () => {
      t.test('真实 .dshw-api.json 与真实设置文件均保持基线哈希', () => {
        if (REAL_REGISTRY_BASELINE) {
          const now = baselineOf(WHALE_REGISTRY_REAL)
          assertEq(now.hash, REAL_REGISTRY_BASELINE.hash, '真实 .dshw-api.json 内容被改动')
        }
        if (REAL_SETTINGS_BASELINE) {
          const now = baselineOf(REAL_SETTINGS_PATH)
          assertEq(now.hash, REAL_SETTINGS_BASELINE.hash, '真实 whale-newapi-bridge-settings.json 内容被改动')
        }
      })
      t.test('所有写入都发生在隔离 $DSH_HOME 内', () => {
        assertIncludes(SETTINGS_PATH, ISOLATED_HOME, '设置路径必须位于隔离目录')
        assertEq(process.env.DSH_HOME, ISOLATED_HOME, '进程 DSH_HOME')
      })
    })

    await t.finish()
  } catch (err) {
    console.error('\n!! 验证脚本自身异常（非用例失败）：\n' + (err && (err.stack || err)))
    console.log('SUMMARY: FAIL（脚本异常）')
    process.exitCode = 1
  } finally {
    try { await closeAll() } catch { /* ignore */ }
    try { fs.rmSync(ISOLATED_HOME, { recursive: true, force: true }) } catch { /* ignore */ }
    globalThis.fetch = realFetch
    if (ORIGINAL_DSH_HOME === undefined) {
      delete process.env.DSH_HOME
    } else {
      process.env.DSH_HOME = ORIGINAL_DSH_HOME
    }
  }
}
