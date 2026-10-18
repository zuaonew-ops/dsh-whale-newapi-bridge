// verify-live-origin.mjs —— 独立验证 spec-v2 §10.6：
// 桥地址探测必须优先采用宿主 Web 服务的**实时** origin（`ctx.webServer.getOrigin()`）。
//
// 背景（真实故障）：桌面宿主用 `--port 0` 启动 profile，端口由系统随机分配且不落盘；
// `DSH_WEB_URL` 是 Web 服务起来之后才注入给子进程的，插件 apply/sync 时宿主自己的
// `process.env` 里没有它，`argv` 里也没有真实端口 → 旧代码一路掉到默认 19387，
// 写进 `.dshw-api.json` 的 `balance.url` 指向没人监听的端口，挂件取不到余额。
//
// 覆盖：
//   §10.6-1 getOrigin 可用 → probeSource=webServer.getOrigin()，条目 balance.url 用该 origin
//   §10.6-2 端口变化后一次 /sync 就把条目改写到新 origin（模拟应用重启后端口变了）
//   §10.6-3 DSH_WEB_URL 仍然优先于 getOrigin（不破坏 §10.2-a 的既有裁定）
//   §10.6-4 getOrigin 抛（监听尚未 bind）/ 缺失 → 退回默认 19387，不崩
//   §10.6-5 config.bridgeBaseUrl 仍然最优先
//
// 纪律：隔离 $DSH_HOME 到临时目录；真实 %USERPROFILE%\.dsh\.dshw-api.json 全程只读，
//       末尾用 sha256 守卫断言未变；不打印任何凭据明文。
import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import {
  createRunner, assert, assertEq, assertIncludes, needFn, sha256, PKG_DIR, WHALE_REGISTRY_REAL,
} from './verify-helpers.mjs'

const MOD = path.join(PKG_DIR, 'lib', 'index.js')

// —— 隔离：$DSH_HOME → 临时目录；真实注册表只读守卫 ——
const ISOLATED_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-verify-origin-home-'))
process.env.DSH_HOME = ISOLATED_HOME
const ISO_REGISTRY = path.join(ISOLATED_HOME, '.dshw-api.json')
const REAL_GUARD = fs.existsSync(WHALE_REGISTRY_REAL)
  ? { sha256: sha256(fs.readFileSync(WHALE_REGISTRY_REAL)), bytes: fs.statSync(WHALE_REGISTRY_REAL).size }
  : null

// 探测链要看的三个环境变量：本套件自己控制，末尾还原
const SAVED_ENV = {
  DSH_WEB_URL: process.env.DSH_WEB_URL,
  DSH_WEB_PORT: process.env.DSH_WEB_PORT,
  PORT: process.env.PORT,
}
delete process.env.DSH_WEB_URL
delete process.env.DSH_WEB_PORT
delete process.env.PORT

const t = createRunner('verify-live-origin.mjs —— spec-v2 §10.6 桥地址 = 宿主实时 origin')
const SECRET = 'sk-VERIFY-ORIGIN-0123456789abcdef'

console.log(`模块: ${MOD}`)
console.log(`隔离 $DSH_HOME: ${ISOLATED_HOME}`)
console.log(`真实注册表只读基线: ${REAL_GUARD ? REAL_GUARD.sha256.slice(0, 16) + '… (' + REAL_GUARD.bytes + ' 字节)' : '不存在'}`)

const indexMod = await import('file://' + MOD.replace(/\\/g, '/'))
const apply = needFn(indexMod, 'apply', 'index')

// ---------------------------------------------------------------------------
// 桩：假 Cordis ctx + 受控 credentials + 可观测的上游 fetch
// ---------------------------------------------------------------------------

/** 受控上游/自检 fetch 桩；`state.origin` 决定自检端口是否"存在"。 */
function makeFetchStub(state) {
  const calls = []
  const j = (obj) => ({
    ok: true, status: 200, headers: new Map([['content-type', 'application/json']]),
    async json() { return obj }, async text() { return JSON.stringify(obj) },
  })
  const err = (status, obj) => ({
    ok: false, status, headers: new Map(),
    async json() { return obj ?? {} }, async text() { return JSON.stringify(obj ?? {}) },
  })
  const stub = async function (url) {
    const u = String(url)
    calls.push(u)
    if (u.includes('/dsh-whale-newapi/health')) {
      // 只有指向"当前 origin 端口"的自检才算通 —— 用来证明选中的地址确实是实时端口
      const want = state.origin === null ? null : new URL(state.origin).port
      if (want !== null && new URL(u).port === want) {
        return j({ ok: true, name: 'dsh-whale-newapi-bridge', version: '0.1.1', enabled: true })
      }
      return err(404, { error: 'no-listener' })
    }
    if (u.includes('/api/status')) {
      return j({ data: { version: 'v1.0.0-rc.40', quota_per_unit: 500000, usd_exchange_rate: 7.3, display_in_currency: true, quota_display_type: 'CUSTOM', custom_currency_symbol: 'credits', custom_currency_exchange_rate: 1 } })
    }
    if (u.includes('/api/user/self')) return err(401, { message: 'unauthorized' })
    if (u.includes('/v1/dashboard/billing/subscription')) return j({ hard_limit_usd: 100, soft_limit_usd: 100, object: 'billing_subscription' })
    if (u.includes('/v1/dashboard/billing/usage')) return j({ total_usage: 1834.5636, object: 'list' })
    if (u.includes('/v1/models')) return j({ object: 'list', data: [{ id: 'deepseek-v4.1-flash' }, { id: 'tier-std' }] })
    throw new TypeError(`套件未声明的 URL（视为立即失败，避免掩盖问题）: ${u}`)
  }
  stub.calls = calls
  return stub
}

/** 假 ctx 桩；`getOrigin` 直接决定 §10.6 候选的行为（null = 该方法不存在）。 */
function makeStubCtx({ getOrigin = null } = {}) {
  const routes = []
  const effects = []
  const webServer = {
    register(spec) {
      routes.push(spec)
      return () => { const i = routes.indexOf(spec); if (i >= 0) routes.splice(i, 1) }
    },
  }
  if (getOrigin !== null) webServer.getOrigin = getOrigin
  const credentials = {
    async resolve(ref) { return { value: SECRET, ref } },
    async set() { return true },
  }
  const ctx = {
    _routes: routes,
    _effects: effects,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    inject(names, fn) { return fn(ctx) },
    get(name) {
      if (name === 'credentials') return credentials
      if (name === 'connection') return { on() { return () => {} } }
      if (name === 'webServer') return webServer
      return undefined
    },
    // 只登记 disposer，**不要**立刻调用（立刻调用会把刚注册的路由摘掉）
    effect(fn) { const d = fn(); if (typeof d === 'function') effects.push(d); return () => {} },
    on() { return () => {} },
    setInterval,
    clearInterval,
  }
  ctx.webServer = webServer
  ctx.credentials = credentials
  ctx.connection = { on() { return () => {} } }
  return ctx
}

function request(port, { method = 'GET', url = '/', headers = {}, body = null, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers, setHost: false }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => { req.destroy(new Error(`请求超时(${timeoutMs}ms)`)) })
    if (body !== null) req.write(body)
    req.end()
  })
}

function findRoute(routes, pathname) {
  for (const r of routes) {
    if (!r || typeof r.path !== 'string') continue
    if ((r.kind === 'exact' || !r.kind) && r.path === pathname) return r
    if (r.kind === 'prefix' && pathname.startsWith(r.path)) return r
  }
  return null
}

async function serve(routes) {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname
    const route = findRoute(routes, pathname)
    if (!route) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"no-route"}'); return }
    try {
      const out = route.handler(req, res)
      if (out && typeof out.then === 'function') out.catch((e) => { if (!res.headersSent) { res.writeHead(500); res.end(JSON.stringify({ error: String(e && e.message) })) } })
    } catch (e) {
      if (!res.headersSent) { res.writeHead(500); res.end(JSON.stringify({ error: String(e && e.message) })) }
    }
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { port: server.address().port, server }
}

const HOST = (p) => `127.0.0.1:${p}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const readIsoRegistry = () => JSON.parse(fs.readFileSync(ISO_REGISTRY, 'utf8'))
const ourEntry = () => (readIsoRegistry().models || []).find((m) => m && m.id === 'newapi_relay') || null

/** 探测来源在 /status 的 `internal.bridgeProbeSource`（SPEC §6.2：bridge 对象只有 baseUrl/selfCheck）。 */
const probeSourceOf = (st) => (st.internal || {}).bridgeProbeSource

async function statusOf(port) {
  const r = await request(port, { url: '/dsh-whale-newapi/status', headers: { host: HOST(port) } })
  assertEq(r.status, 200, `/status 必须 200（实际 ${r.status}）`)
  return JSON.parse(r.body)
}

/** 等首轮 autoSync 落定（lastSyncAt 出现）。 */
async function settle(port, ms = 15000) {
  const deadline = Date.now() + ms
  let last = null
  while (Date.now() < deadline) {
    const r = await request(port, { url: '/dsh-whale-newapi/status', headers: { host: HOST(port) } })
    if (r.status === 200) {
      last = JSON.parse(r.body)
      if (last.whale && last.whale.lastSyncAt) return last
    }
    await sleep(250)
  }
  return last
}

async function sync(port) {
  const r = await request(port, {
    method: 'POST', url: '/dsh-whale-newapi/sync',
    headers: { host: HOST(port), authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
    body: '{}',
  })
  assertEq(r.status, 200, `/sync 必须 200（实际 ${r.status} ${r.body.slice(0, 200)}）`)
  return JSON.parse(r.body)
}

/** 起一个插件实例（routes 挂到真实 http 服务上），返回句柄。 */
async function boot({ getOrigin = null, config = {}, state = { origin: null } } = {}) {
  const ctx = makeStubCtx({ getOrigin })
  const stub = makeFetchStub(state)
  const realFetch = globalThis.fetch
  globalThis.fetch = stub
  apply(ctx, config)
  const m = await serve(ctx._routes)
  return {
    ctx, stub, state,
    port: m.port,
    close: async () => { globalThis.fetch = realFetch; await new Promise((r) => m.server.close(r)) },
  }
}

const servers = []
const instances = []
try {
  // =========================================================================
  // §10.6-1：apply 时 getOrigin 还抛（未 bind）→ 退回默认；/sync 后必须改用实时 origin
  // =========================================================================
  await t.group('§10.6-1 getOrigin 可用 → 条目 balance.url 用宿主实时 origin', () => {
    t.test('未 bind 时退回默认并如实报告；bind 后一次 /sync 改写到实时 origin', async () => {
      const holder = { origin: null }
      const state = { origin: null }
      const inst = await boot({
        getOrigin: () => { if (holder.origin === null) throw new Error('web server is not listening yet'); return holder.origin },
        state,
      })
      instances.push(inst)
      const st = await settle(inst.port)
      assert(st, '未能取得 /status')
      assertEq(st.bridge.baseUrl, 'http://127.0.0.1:19387', `未监听时应退回默认地址（实际 ${st.bridge.baseUrl}）`)
      assertEq(probeSourceOf(st), 'default', `probeSource 应为 default（实际 ${probeSourceOf(st)}）`)
      assertEq(st.bridge.selfCheck.ok, false, '指向默认端口时自检必须如实失败（不许假装成功）')
      assertIncludes(JSON.stringify(st.warnings), '桥自检未通过', 'warnings 必须显式报告探测不到真实端口')

      holder.origin = `http://127.0.0.1:${inst.port}`
      state.origin = holder.origin
      await sync(inst.port)
      const st2 = await statusOf(inst.port)
      assertEq(st2.bridge.baseUrl, holder.origin, `getOrigin 可用后必须采用实时 origin（实际 ${st2.bridge.baseUrl}）`)
      assertEq(probeSourceOf(st2), 'webServer.getOrigin()', `probeSource 应为 webServer.getOrigin()（实际 ${probeSourceOf(st2)}）`)
      assertEq(st2.bridge.selfCheck.ok, true, `指向实时端口后自检必须通过（error=${st2.bridge.selfCheck.error}）`)
      const entry = ourEntry()
      assert(entry, '注册表里必须出现我们的条目')
      assertEq(entry.balance.url, `${holder.origin}/dsh-whale-newapi/balance`, `条目 balance.url 必须指向实时 origin（实际 ${entry.balance.url}）`)
      const h = await request(inst.port, { url: '/dsh-whale-newapi/health', headers: { host: HOST(inst.port) } })
      assertEq(h.status, 200, '选中的 origin 必须真的能应答 /health')
      console.log(`      实时 origin = ${holder.origin}；条目 balance.url = ${entry.balance.url}`)
    })
  })

  // =========================================================================
  // §10.6-2：端口变化（模拟应用重启后 --port 0 又换了一个端口）
  // =========================================================================
  await t.group('§10.6-2 端口变化后一次 /sync 就把条目改写到新 origin', () => {
    t.test('origin 换成另一个端口 → 条目 balance.url 跟着换', async () => {
      const holder = { origin: null }
      const state = { origin: null }
      const inst = await boot({ getOrigin: () => holder.origin, state })
      instances.push(inst)
      const second = await serve(inst.ctx._routes)
      servers.push(second)
      const originA = `http://127.0.0.1:${inst.port}`
      const originB = `http://127.0.0.1:${second.port}`
      holder.origin = originA
      state.origin = originA
      await sync(inst.port)
      assertEq((ourEntry() || {}).balance?.url, `${originA}/dsh-whale-newapi/balance`, '第一次同步应写 origin A')
      holder.origin = originB
      state.origin = originB
      await sync(inst.port)
      const st = await statusOf(inst.port)
      assertEq(st.bridge.baseUrl, originB, `端口变化后必须采用新 origin（实际 ${st.bridge.baseUrl}）`)
      assertEq((ourEntry() || {}).balance?.url, `${originB}/dsh-whale-newapi/balance`, '端口变化后条目必须被改写')
      assertEq(st.bridge.selfCheck.ok, true, '新 origin 上自检也应通过')
      console.log(`      origin A=${originA} → B=${originB}；条目已改写`)
    })
  })

  // =========================================================================
  // §10.6-3：DSH_WEB_URL 仍优先于 getOrigin（不破坏 §10.2-a 的既有裁定）
  // =========================================================================
  await t.group('§10.6-3 DSH_WEB_URL 仍优先于 getOrigin', () => {
    t.test('env 候选在前 → probeSource=env:DSH_WEB_URL', async () => {
      const holder = { origin: null }
      const state = { origin: null }
      const inst = await boot({ getOrigin: () => holder.origin, state })
      instances.push(inst)
      const envServer = await serve(inst.ctx._routes)
      servers.push(envServer)
      const envUrl = `http://127.0.0.1:${envServer.port}`
      try {
        process.env.DSH_WEB_URL = envUrl
        holder.origin = `http://127.0.0.1:${inst.port}`
        state.origin = envUrl
        await sync(inst.port)
        const st = await statusOf(inst.port)
        assertEq(probeSourceOf(st), 'env:DSH_WEB_URL', `env 候选必须先于 getOrigin（实际 ${probeSourceOf(st)}）`)
        assertEq(st.bridge.baseUrl, envUrl, 'DSH_WEB_URL 胜出时地址应是它')
        console.log(`      env 候选 ${envUrl} 胜出 getOrigin ${holder.origin}`)
      } finally {
        delete process.env.DSH_WEB_URL
      }
    })
  })

  // =========================================================================
  // §10.6-4：getOrigin 缺失（老宿主/桩没有这个方法）→ 行为与改动前一致
  // =========================================================================
  await t.group('§10.6-4 getOrigin 缺失 → 退回默认，不崩', () => {
    t.test('webServer 没有 getOrigin → default 19387', async () => {
      const inst = await boot({ getOrigin: null })
      instances.push(inst)
      const st = await settle(inst.port)
      assert(st, '未能取得 /status')
      assertEq(st.bridge.baseUrl, 'http://127.0.0.1:19387', '没有 getOrigin 时应退回默认地址')
      assertEq(probeSourceOf(st), 'default', 'probeSource 应为 default')
    })
  })

  // =========================================================================
  // §10.6-5：config.bridgeBaseUrl 仍然最优先
  // =========================================================================
  await t.group('§10.6-5 config.bridgeBaseUrl 仍然最优先', () => {
    t.test('显式配置胜出', async () => {
      const inst = await boot({
        getOrigin: () => 'http://127.0.0.1:49844',
        config: { bridgeBaseUrl: 'http://127.0.0.1:3099' },
      })
      instances.push(inst)
      const st = await settle(inst.port)
      assert(st, '未能取得 /status')
      assertEq(probeSourceOf(st), 'config.bridgeBaseUrl', `显式配置必须最优先（实际 ${probeSourceOf(st)}）`)
      assertEq(st.bridge.baseUrl, 'http://127.0.0.1:3099', '显式配置胜出时地址应是它')
    })
  })

  // =========================================================================
  // 守卫：真实注册表一字未动
  // =========================================================================
  await t.group('隔离守卫', () => {
    t.test('真实 .dshw-api.json 未被本套件触碰', () => {
      if (!REAL_GUARD) { console.log('      真实注册表不存在 → 跳过（无法断言）'); return }
      const now = sha256(fs.readFileSync(WHALE_REGISTRY_REAL))
      assertEq(now, REAL_GUARD.sha256, '真实注册表 sha256 必须与基线一致')
      console.log(`      真实注册表 sha256 = ${now.slice(0, 16)}… (${REAL_GUARD.bytes} 字节) 未变`)
    })
  })
} finally {
  for (const inst of instances) { try { await inst.close() } catch { /* 已关闭 */ } }
  for (const s of servers) { try { await new Promise((r) => s.server.close(r)) } catch { /* 已关闭 */ } }
  if (SAVED_ENV.DSH_WEB_URL === undefined) delete process.env.DSH_WEB_URL; else process.env.DSH_WEB_URL = SAVED_ENV.DSH_WEB_URL
  if (SAVED_ENV.DSH_WEB_PORT === undefined) delete process.env.DSH_WEB_PORT; else process.env.DSH_WEB_PORT = SAVED_ENV.DSH_WEB_PORT
  if (SAVED_ENV.PORT === undefined) delete process.env.PORT; else process.env.PORT = SAVED_ENV.PORT
}

await t.finish()
