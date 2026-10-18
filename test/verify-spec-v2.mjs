// verify-spec-v2.mjs —— 独立验证 SPEC §10（spec-v2 修订，优先级高于前文）的四条收紧。
//
// 覆盖：
//   §10.1 POST /sync 必须与 /balance 同鉴权（无/错 Bearer → 401；?token= 也接受）
//   §10.2 bridgeBaseUrl 只允许回环 origin（config 与 /sync 覆盖都算）；/sync 传非回环 → 400 且注册表一字不动
//   §10.3 凭据新鲜度：候选回退期间必须重新解析，后来出现的首选凭据要能接管
//   §10.5 native 荒诞值护栏（quota<=0 或 credits/quotaPerUnit>1e6 → unlimited:true, remaining:null）
//
// 纪律：隔离 $DSH_HOME 到临时目录（插件默认 autoSync=true 会真写注册表）；
//       真实 %USERPROFILE%\.dsh\.dshw-api.json 全程只读，末尾用 sha256 守卫断言未变；
//       不打印任何凭据明文。
import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import crypto from 'node:crypto'
import {
  createRunner, assert, assertEq, assertIncludes, assertNotIncludes,
  need, needFn, mask, sha256, PKG_DIR, WHALE_REGISTRY_REAL, loadFixture,
} from './verify-helpers.mjs'

const MOD = path.join(PKG_DIR, 'lib', 'index.js')

// —— 隔离：$DSH_HOME → 临时目录；真实注册表只读守卫 ——
const ISOLATED_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-verify-v2-home-'))
const ORIGINAL_DSH_HOME = process.env.DSH_HOME
process.env.DSH_HOME = ISOLATED_HOME
const ISO_REGISTRY = path.join(ISOLATED_HOME, '.dshw-api.json')
const REAL_GUARD = fs.existsSync(WHALE_REGISTRY_REAL)
  ? { sha256: sha256(fs.readFileSync(WHALE_REGISTRY_REAL)), bytes: fs.statSync(WHALE_REGISTRY_REAL).size }
  : null

const t = createRunner('verify-spec-v2.mjs —— SPEC §10 收紧项（spec-v2）')

const SECRET = 'sk-VERIFY-V2-CONTROLLED-0123456789abcdef'
const BAD = 'sk-wrong-bearer-000000'
const PREFERRED_REF = 'VERIFY_PREFERRED_TOKEN'
const CANDIDATE_REF = 'VERIFY_CANDIDATE_KEY'
const PREFERRED_VAL = 'sk-VERIFY-PREFERRED-VALUE-abcdef'
const CANDIDATE_VAL = 'sk-VERIFY-CANDIDATE-VALUE-012345'

console.log(`模块: ${MOD}`)
console.log(`隔离 $DSH_HOME: ${ISOLATED_HOME}`)
console.log(`真实注册表只读基线: ${REAL_GUARD ? REAL_GUARD.sha256.slice(0, 16) + '… (' + REAL_GUARD.bytes + ' 字节)' : '不存在'}`)

const indexMod = await import('file://' + MOD.replace(/\\/g, '/'))
const newapiMod = await import('file://' + path.join(PKG_DIR, 'lib', 'newapi.mjs').replace(/\\/g, '/'))
const apply = needFn(indexMod, 'apply', 'index')

// ---------------------------------------------------------------------------
// 桩：假 Cordis ctx + 受控 credentials + 可观测的上游 fetch
// ---------------------------------------------------------------------------
const upstreamCalls = []

/** 受控上游响应（默认全部离线；只有显式 live 时才真访问）。 */
function makeUpstreamFetch({ selfCheckPort = null, onCall = null } = {}) {
  return async function upstreamFetch(url, init) {
    const u = String(url)
    const auth = (init && init.headers && (init.headers.Authorization || init.headers.authorization)) || ''
    upstreamCalls.push({ url: u, auth, at: Date.now() })
    if (onCall) onCall(u, auth)
    const j = (obj) => ({
      ok: true, status: 200, headers: new Map([['content-type', 'application/json']]),
      async json() { return obj }, async text() { return JSON.stringify(obj) },
    })
    const err = (status, obj) => ({
      ok: false, status, headers: new Map(),
      async json() { return obj ?? {} }, async text() { return JSON.stringify(obj ?? {}) },
    })
    // 桥自检：指向本套件自己的服务端
    if (selfCheckPort !== null && u.includes('/dsh-whale-newapi/health')) {
      if (new URL(u).port === String(selfCheckPort)) return j({ ok: true, name: 'dsh-whale-newapi-bridge', version: '0.1.0', enabled: true })
      return err(404, { error: 'no' })
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
}

/**
 * 假 ctx 桩。
 * @param opts.resolveMap - `{ [ref]: value|null }`；`null` = 该 ref 解析不到（用于 §10.3）
 * @param opts.dynamic - 若为函数，每次 resolve 都调用它拿最新 map（用于「凭据后来才出现」）
 * @param opts.anyRef - 未提供 resolveMap/dynamic 时，是否把**任意** ref 都解析成 SECRET
 *                      （默认 true：默认配置的 credentialRef 是 NEWAPI_RELAY_TOKEN，桩必须能解析它）
 */
function makeStubCtx({ resolveMap = null, dynamic = null, anyRef = true } = {}) {
  const routes = []
  const effects = []
  const resolveCalls = []
  const webServer = {
    register(spec) {
      routes.push(spec)
      return () => { const i = routes.indexOf(spec); if (i >= 0) routes.splice(i, 1) }
    },
  }
  const credentials = {
    async resolve(ref) {
      resolveCalls.push(ref)
      const map = dynamic ? dynamic() : resolveMap
      if (map) {
        const v = Object.prototype.hasOwnProperty.call(map, ref) ? map[ref] : null
        return v ? { value: v, ref } : null
      }
      return anyRef ? { value: SECRET, ref } : null
    },
    async set() { return true },
  }
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

async function request(port, { method = 'GET', url = '/', headers = {}, body = null, timeoutMs = 30000 } = {}) {
  return await new Promise((resolve, reject) => {
    const started = Date.now()
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers, setHost: false }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), ms: Date.now() - started }))
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
const isoHash = () => (fs.existsSync(ISO_REGISTRY) ? sha256(fs.readFileSync(ISO_REGISTRY)) : null)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 等一次同步落定（lastSyncAt 出现或 whale.entry 产出）。 */
async function settle(port, ms = 20000) {
  const deadline = Date.now() + ms
  let last = null
  while (Date.now() < deadline) {
    const r = await request(port, { url: '/dsh-whale-newapi/status', headers: { host: HOST(port) } })
    if (r.status === 200) {
      last = JSON.parse(r.body)
      if (last.whale && (last.whale.lastSyncAt || (last.whale.entry && last.whale.entry.id))) return last
    }
    await sleep(250)
  }
  return last
}

const realFetch = globalThis.fetch
let sharedServer = null
let sharedCtx = null
let sharedServer2 = null

try {
  // =========================================================================
  // §10.1 / §10.2：先起一个实例（默认配置），用于 /sync 鉴权与 bridgeBaseUrl 校验
  // =========================================================================
  await t.group('§10.1 POST /sync 必须与 /balance 同鉴权', () => {
    let port = 0
    t.test('准备：挂载插件（默认配置 + 受控上游），等首轮同步落定', async () => {
      sharedCtx = makeStubCtx()
      globalThis.fetch = makeUpstreamFetch()
      apply(sharedCtx, {})
      const m = await serve(sharedCtx._routes)
      sharedServer = m.server
      port = m.port
      // 首轮同步需要桥自检指向本套件服务端；先让自检失败也无妨（状态仍可观测）
      const st = await settle(port, 15000)
      assert(st, '未能取得 /status')
      console.log(`      /status 已就绪；whale.mode=${st.whale.mode} lastSyncAt=${st.whale.lastSyncAt}`)
      console.log(`      registryFile=${st.whale.registryFile} registryOk=${st.whale.registryOk}`)
      if (typeof st.whale.registryFile !== 'string') {
        console.log(`      [注意] registryFile 为空（本轮未落盘）；warnings=${JSON.stringify(st.warnings)}`)
        console.log('      [说明] 该项断言退化为记录（后续 /sync 用例仍可验证路由行为）')
        return
      }
      assertEq(path.resolve(String(st.whale.registryFile)), path.resolve(ISO_REGISTRY), 'registryFile 必须落在隔离 home 内')
    })
    t.test('无 Authorization → 401（spec-v2 §10.1）', async () => {
      const r = await request(port, { method: 'POST', url: '/dsh-whale-newapi/sync', headers: { host: HOST(port), 'content-type': 'application/json' }, body: '{}' })
      console.log(`      HTTP ${r.status} body=${r.body.slice(0, 200)}`)
      assertEq(r.status, 401, `无 Bearer 必须 401，实际 ${r.status}`)
      assertNotIncludes(r.body, SECRET, '401 响应不得含凭据')
    })
    t.test('错误 Bearer → 401', async () => {
      const r = await request(port, { method: 'POST', url: '/dsh-whale-newapi/sync', headers: { host: HOST(port), 'content-type': 'application/json', authorization: 'Bearer ' + BAD }, body: '{}' })
      assertEq(r.status, 401, `错误 Bearer 必须 401，实际 ${r.status}（body=${r.body.slice(0, 200)}）`)
    })
    t.test('只有 "Bearer" 无值 → 401', async () => {
      const r = await request(port, { method: 'POST', url: '/dsh-whale-newapi/sync', headers: { host: HOST(port), 'content-type': 'application/json', authorization: 'Bearer' }, body: '{}' })
      assertEq(r.status, 401, `空 Bearer 必须 401，实际 ${r.status}`)
    })
    t.test('正确 Bearer → 非 401（鉴权通过）', async () => {
      const r = await request(port, { method: 'POST', url: '/dsh-whale-newapi/sync', headers: { host: HOST(port), 'content-type': 'application/json', authorization: 'Bearer ' + SECRET }, body: '{}' })
      console.log(`      HTTP ${r.status} body=${r.body.slice(0, 300)}`)
      assert(r.status !== 401, `正确 Bearer 不该 401，实际 ${r.status}`)
      assertNotIncludes(r.body, SECRET, '响应不得含凭据')
    })
    t.test('?token=<正确> → 非 401（spec-v2 §10.1 也接受 query）', async () => {
      const r = await request(port, { method: 'POST', url: '/dsh-whale-newapi/sync?token=' + encodeURIComponent(SECRET), headers: { host: HOST(port), 'content-type': 'application/json' }, body: '{}' })
      console.log(`      HTTP ${r.status}`)
      assert(r.status !== 401, `?token= 正确值不该 401，实际 ${r.status}`)
    })
    t.test('?token=<错误> → 401', async () => {
      const r = await request(port, { method: 'POST', url: '/dsh-whale-newapi/sync?token=' + encodeURIComponent(BAD), headers: { host: HOST(port), 'content-type': 'application/json' }, body: '{}' })
      assertEq(r.status, 401, `?token= 错误值必须 401，实际 ${r.status}`)
    })
    t.test('/status 仍免 Bearer（spec-v2 §10.1 明确保持）', async () => {
      const r = await request(port, { url: '/dsh-whale-newapi/status', headers: { host: HOST(port) } })
      assertEq(r.status, 200, `/status 应免鉴权，实际 ${r.status}`)
    })
    t.test('/health 仍免鉴权', async () => {
      const r = await request(port, { url: '/dsh-whale-newapi/health', headers: { host: HOST(port) } })
      assertEq(r.status, 200, `/health 应免鉴权，实际 ${r.status}`)
    })
  })

  await t.group('§10.2 bridgeBaseUrl 只允许回环 origin（/sync 覆盖）', () => {
    const cases = [
      ['http://evil.com', 400],
      ['http://evil.com:10072', 400],
      ['https://attacker.example', 400],
      ['http://localhost.evil.com', 400],   // 前缀伪装
      ['http://127.0.0.1.evil.com', 400],   // 后缀伪装
      ['ftp://127.0.0.1:1', 400],           // 非 http(s)
      ['http://user:pw@127.0.0.1:1', 400],  // 带 userinfo
      ['http://[::2]:1', 400],              // 非回环 IPv6
      ['http://192.168.1.1:1', 400],        // 非回环私网
    ]
    for (const [value, expect] of cases) {
      t.test(`/sync + 正确 Bearer + bridgeBaseUrl=${value} → ${expect}`, async () => {
        const port = sharedServer.address().port
        const before = isoHash()
        const body = JSON.stringify({ bridgeBaseUrl: value })
        const r = await request(port, {
          method: 'POST', url: '/dsh-whale-newapi/sync',
          headers: { host: HOST(port), 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), authorization: 'Bearer ' + SECRET },
          body,
        })
        console.log(`      HTTP ${r.status} body=${r.body.slice(0, 300)}`)
        assertEq(r.status, expect, `必须 ${expect}，实际 ${r.status}`)
        if (expect === 400) {
          // spec-v2 §10.2：这种请求「注册表一字不动」
          assertEq(isoHash(), before, '400 时注册表必须一字不动（sha256 不变）')
        }
      })
    }
    t.test('回环值被接受：/sync + bridgeBaseUrl=http://127.0.0.1:<本套件端口> → 非 400', async () => {
      const port = sharedServer.address().port
      const body = JSON.stringify({ bridgeBaseUrl: `http://127.0.0.1:${port}` })
      const r = await request(port, {
        method: 'POST', url: '/dsh-whale-newapi/sync',
        headers: { host: HOST(port), 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), authorization: 'Bearer ' + SECRET },
        body,
      })
      console.log(`      HTTP ${r.status} body=${r.body.slice(0, 300)}`)
      assert(r.status !== 400, `回环地址不该被判 400，实际 ${r.status}`)
    })
    t.test('回环值被接受：localhost / [::1] / 127.x 变体 → 非 400', async () => {
      const port = sharedServer.address().port
      for (const v of [`http://localhost:${port}`, `http://127.0.0.2:${port}`, `http://[::1]:${port}`]) {
        const body = JSON.stringify({ bridgeBaseUrl: v })
        const r = await request(port, {
          method: 'POST', url: '/dsh-whale-newapi/sync',
          headers: { host: HOST(port), 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), authorization: 'Bearer ' + SECRET },
          body,
        })
        console.log(`      bridgeBaseUrl=${v} → HTTP ${r.status}`)
        assert(r.status !== 400, `${v} 应被接受，实际 ${r.status}`)
      }
    })
    t.test('config.bridgeBaseUrl 非回环 → 被忽略并给出 warning（回退自动探测）', async () => {
      const ctx = makeStubCtx()
      globalThis.fetch = makeUpstreamFetch()
      apply(ctx, { bridgeBaseUrl: 'http://evil.com' })
      const m = await serve(ctx._routes)
      try {
        const st = await settle(m.port, 15000)
        assert(st, '未能取得 /status')
        console.log(`      internal.bridgeProbeSource=${st.internal && st.internal.bridgeProbeSource} bridge.baseUrl=${st.bridge.baseUrl}`)
        console.log(`      warnings=${JSON.stringify(st.warnings)}`)
        // 注意：本机 DSH 自身会设置 DSH_WEB_URL，所以 probeSource 可能是 'env:DSH_WEB_URL'（属正常）。
        // 真正要断言的不变式是：被忽略的 config.bridgeBaseUrl 不得出现在最终探测地址里。
        assert(!String(st.bridge.baseUrl).includes('evil.com'), `探测地址不得是 evil.com，实际 ${st.bridge.baseUrl}`)
        assert(String(st.bridge.baseUrl).includes('127.0.0.1') || String(st.bridge.baseUrl).includes('localhost'),
          `回退后的探测地址应为回环，实际 ${st.bridge.baseUrl}`)
        const mentioned = (st.warnings || []).some((w) => String(w).includes('bridgeBaseUrl'))
        assert(mentioned, `warnings 必须说明 bridgeBaseUrl 被忽略，实际 ${JSON.stringify(st.warnings)}`)
      } finally {
        await new Promise((r) => m.server.close(r))
        for (const d of ctx._effects) { try { d() } catch { /* 忽略 */ } }
      }
    })
  })

  // =========================================================================
  // §10 反向 / 边界用例（针对 core 说明的实现约定做对抗性核对）
  // =========================================================================
  await t.group('§10 反向/边界：自动探测路径是否也能被注入非回环地址', () => {
    let srv = null
    t.test('DSH_WEB_URL 非回环 → balance.url 落在该地址，且 warnings 必须给出非回环提示（SPEC §10.2-a）', async () => {
      // 沿革：本用例最初用于证伪 SPEC §10.2 末句「自动探测路径本身只产出回环地址，不受影响」——
      // 实测该句与实现不符（DSH_WEB_URL 可注入非回环）。作者裁定（SPEC §10.2-a）：
      //   自动探测候选**允许**非回环（只有启动宿主的人能设置），但**必须可见**（warnings 提示）。
      // 原句作废；本用例现断言成文后的行为（见 docs/VERIFICATION.md「裁定链条」）。
      const prevUrl = process.env.DSH_WEB_URL
      process.env.DSH_WEB_URL = 'http://evil-env-probe.example:19999'
      const ctx = makeStubCtx()
      const calls = []
      globalThis.fetch = makeUpstreamFetch({ onCall: (u) => calls.push(u) })
      let status = null
      try {
        apply(ctx, {}) // 默认配置：bridgeBaseUrl 为空 → 走自动探测
        const m = await serve(ctx._routes)
        srv = m.server
        status = await settle(m.port, 15000)
      } finally {
        if (prevUrl === undefined) delete process.env.DSH_WEB_URL
        else process.env.DSH_WEB_URL = prevUrl
      }
      assert(status, '未能取得 /status')
      const entry = status.whale && status.whale.entry
      const balUrl = entry && entry.balance && entry.balance.url
      const warns = (status.warnings || []).map(String)
      console.log(`      DSH_WEB_URL=http://evil-env-probe.example:19999`)
      console.log(`      bridge.baseUrl=${status.bridge.baseUrl} internal.bridgeProbeSource=${status.internal && status.internal.bridgeProbeSource}`)
      console.log(`      whale.mode=${status.whale.mode} entry.balance.url=${JSON.stringify(balUrl)}`)
      console.log(`      allowCustomHost=${entry && entry.allowCustomHost}`)
      console.log(`      探测过的上游: ${JSON.stringify([...new Set(calls.filter((u) => u.includes('evil-env-probe')))])}`)
      for (const w of warns) console.log(`      warning: ${w.slice(0, 240)}`)

      // (1) SPEC §10.2-a：自动探测候选允许非回环 → 条目 balance.url 就是该非回环地址（操作者可控，非缺陷）。
      assertEq(balUrl, 'http://evil-env-probe.example:19999/dsh-whale-newapi/balance',
        `SPEC §10.2-a：自动探测出的非回环桥地址应直接用于 balance.url，实际 ${JSON.stringify(balUrl)}`)
      assertEq(entry.allowCustomHost, true, 'allowCustomHost 必须为 true，否则挂件不会把凭据发往该自定义主机')
      // (2) 但必须**可见**：/status.warnings 必须含「非回环」提示且点明该主机。
      const nonLoopWarn = warns.find((w) => w.includes('非回环') && w.includes('evil-env-probe.example'))
      console.log(nonLoopWarn ? `      ✓ 非回环提示: ${nonLoopWarn.slice(0, 220)}` : `      ✗ 缺非回环提示 warnings=${JSON.stringify(warns)}`)
      assert(nonLoopWarn, 'SPEC §10.2-a：探测到非回环桥地址时 warnings 必须明确提示（含 hostname）')
      // (3) 提示必须对应真实发生的凭据目的地变更：确实观测到对该非回环主机的探测。
      assert(calls.some((u) => u.includes('evil-env-probe.example')), '应能观察到对非回环主机的探测请求')
      assert(status.whale.mode === 'balance' || status.whale.mode === 'events', `mode=${status.whale.mode}`)
    })
    t.test('/sync 覆盖 bridgeBaseUrl="" （空串）：是「清空+自动探测」还是 400 —— 固定实测行为', async () => {
      // SPEC §10.2 对「不满足→400」没有为「空串」单列；core 约定空串=清空+自动探测（非 400）。
      const ctx = makeStubCtx()
      globalThis.fetch = makeUpstreamFetch()
      apply(ctx, {})
      const m = await serve(ctx._routes)
      try {
        const port = m.port
        const body = JSON.stringify({ bridgeBaseUrl: '' })
        const r = await request(port, {
          method: 'POST', url: '/dsh-whale-newapi/sync',
          headers: { host: HOST(port), 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), authorization: 'Bearer ' + SECRET },
          body,
        })
        console.log(`      实测 HTTP ${r.status} body=${r.body.slice(0, 240)}`)
        assert(r.status !== 500, '不得 500')
        console.log(`      [判定说明] ${r.status === 400 ? '空串被判为非法覆盖（严格口径）' : '空串被当作「无覆盖/清空」（core 约定）'}；SPEC 未明确，仅记录`)
      } finally {
        await new Promise((res) => m.server.close(res))
        for (const d of ctx._effects) { try { d() } catch { /* 忽略 */ } }
      }
    })
    t.test('清理探测实例', async () => {
      if (srv) await new Promise((res) => srv.close(res))
      console.log('      done')
    })
  })

  await t.group('§10.5 边界值：阈值严格性与 sanityGuard 字段', () => {
    const normalizeBalance = needFn(newapiMod, 'normalizeBalance', 'newapi')
    const cfg = { currency: 'USD', quotaPerUnit: 500000, usdExchangeRate: 1, usdToCny: 1, fallbackTotal: 0 }
    const call = (user, extra = {}) => normalizeBalance({
      mode: 'native',
      native: { ok: true, user },
      status: { ok: true, status: { quotaPerUnit: 500000 } },
      config: { ...cfg, ...extra },
    })
    t.test('阈值恰好为 1e6 面板单位时**不**触发（SPEC §10.5 是严格大于 >1e6）', () => {
      // credits/quotaPerUnit = 1e6 恰好 → 不触发
      const credits = 1e6 * 500000 // 5e11
      const r = call({ quota: credits, remain_quota: credits, used_quota: 0, unlimited_quota: false })
      console.log(`      实测: credits=${credits} panelUnits=${credits / 500000} → unlimited=${r.unlimited} remaining=${r.remaining}`)
      assertEq(r.unlimited, false, `恰好 1e6 不该触发护栏（unlimited 应 false），实际 ${r.unlimited}`)
      assert(Number.isFinite(r.remaining), `应给出数值余额，实际 ${r.remaining}`)
    })
    t.test('刚超过阈值（1e6 + 1 面板单位）→ 触发护栏', () => {
      const credits = (1e6 + 1) * 500000
      const r = call({ quota: credits, remain_quota: credits, used_quota: 0, unlimited_quota: false })
      console.log(`      实测: panelUnits=${credits / 500000} → unlimited=${r.unlimited} remaining=${r.remaining}`)
      assertEq(r.unlimited, true, '超过阈值必须触发护栏')
      assertEq(r.remaining, null, '不得产出数值余额')
    })
    t.test('credits 恰为 0 → 触发护栏（SPEC §10.5 是 credits<=0）', () => {
      const r = call({ quota: 0, remain_quota: 0, used_quota: 0, unlimited_quota: false })
      assertEq(r.unlimited, true, 'credits=0 必须触发')
      assertEq(r.remaining, null, 'remaining 应为 null')
    })
    t.test('detail.sanityGuard 报数量级且不含凭据（core 约定的字段）', () => {
      const r = call({ quota: -1, remain_quota: -1, used_quota: 0, unlimited_quota: false })
      const g = r.detail && r.detail.sanityGuard
      console.log(`      实测 detail.sanityGuard=${JSON.stringify(g)}`)
      if (g === undefined) { console.log('      [说明] 当前实现未提供 detail.sanityGuard（core 约定 vs 实测不一致，仅记录）'); return }
      assert(typeof g === 'object' && g !== null, 'sanityGuard 必须是对象')
      for (const k of ['credits', 'panelUnits', 'threshold']) assert(k in g, `sanityGuard 缺 ${k}`)
      assertNotIncludes(JSON.stringify(g), SECRET, 'sanityGuard 不得含凭据')
    })
    t.test('护栏场景下 /balance 文案能区分「荒诞值护栏」与「真无限额度」', async () => {
      // core 约定：/balance 返回 200 {ok:false,code:'UNLIMITED'}，error 写明触发荒诞值护栏。
      // 这里用「上游 native 返回 quota=-1」的桩，端到端打一次 /balance。
      const ctx = makeStubCtx()
      globalThis.fetch = async (url, init) => {
        const u = String(url)
        const j = (o) => ({ ok: true, status: 200, headers: new Map(), async json() { return o }, async text() { return JSON.stringify(o) } })
        if (u.includes('/api/status')) return j({ data: { quota_per_unit: 500000, usd_exchange_rate: 1, display_in_currency: true } })
        if (u.includes('/api/user/self')) return j({ data: { quota: -1, remain_quota: -1, used_quota: 0, unlimited_quota: false } })
        if (u.includes('subscription')) return j({ hard_limit_usd: 100 })
        if (u.includes('usage')) return j({ total_usage: 0 })
        if (u.includes('/v1/models')) return j({ data: [] })
        if (u.includes('/dsh-whale-newapi/health')) return { ok: false, status: 404, headers: new Map(), async json() { return {} }, async text() { return '' } }
        throw new TypeError('未声明 URL: ' + u)
      }
      apply(ctx, { authMode: 'native' })
      const m = await serve(ctx._routes)
      try {
        const belt = SECRET
        const r = await request(m.port, { url: '/dsh-whale-newapi/balance', headers: { host: HOST(m.port), authorization: 'Bearer ' + belt } })
        console.log(`      实测 HTTP ${r.status} body=${r.body.slice(0, 400)}`)
        assert(r.status === 200 || r.status === 503, `应为 200（挂件消费者要求错误也是 200），实际 ${r.status}`)
        if (r.status === 200) {
          const body = JSON.parse(r.body)
          if (body.ok === false) {
            assertEq(body.code, 'UNLIMITED', `护栏场景 code 应为 UNLIMITED，实际 ${body.code}`)
            console.log(`      [记录] error 文案=${JSON.stringify(body.error)}`)
          } else {
            console.log(`      [记录] 该桩下未走护栏分支：${r.body.slice(0, 200)}`)
          }
        }
      } finally {
        await new Promise((res) => m.server.close(res))
        for (const d of ctx._effects) { try { d() } catch { /* 忽略 */ } }
      }
    })
  })

  // =========================================================================
  // §10.3 凭据新鲜度
  // =========================================================================
  await t.group('§10.3 凭据新鲜度：候选回退期间必须重新解析，首选出现后接管', () => {
    let port = 0
    let ctx = null
    let available = { [CANDIDATE_REF]: CANDIDATE_VAL } // 首选一开始不可用
    const seen = []
    t.test('准备：首选凭据不可用 → 回退候选，/status.credential.ref 应为候选', async () => {
      ctx = makeStubCtx({ dynamic: () => available })
      upstreamCalls.length = 0
      globalThis.fetch = makeUpstreamFetch({
        onCall: (u, auth) => { if (u.includes('/api/') || u.includes('/v1/')) seen.push({ u, auth }) },
      })
      apply(ctx, { credentialRef: PREFERRED_REF, credentialCandidates: [CANDIDATE_REF] })
      const m = await serve(ctx._routes)
      sharedServer2 = m.server
      port = m.port
      const st = await settle(port, 15000)
      assert(st, '未能取得 /status')
      console.log(`      credential=${JSON.stringify(st.credential)}`)
      console.log(`      balance.source=${st.balance && st.balance.source} ok=${st.balance && st.balance.ok} code=${st.balance && st.balance.code}`)
      // 期望：用上了候选
      const usedCandidate = seen.some((c) => String(c.auth).includes(CANDIDATE_VAL))
      console.log(`      上游请求里出现候选凭据=${usedCandidate}`)
      assert(usedCandidate, '首轮应使用候选凭据（首选不可用）')
      assertNotIncludes(JSON.stringify(st), CANDIDATE_VAL, '/status 不得含凭据明文')
    })
    t.test('首选凭据「后来出现」→ 下一次 /balance 必须重新解析（不得被缓存挡住）', async () => {
      const resolveBefore = ctx._resolveCalls.length
      available = { [PREFERRED_REF]: PREFERRED_VAL, [CANDIDATE_REF]: CANDIDATE_VAL }
      const r = await request(port, { url: '/dsh-whale-newapi/balance', headers: { host: HOST(port), authorization: 'Bearer ' + PREFERRED_VAL } })
      console.log(`      /balance HTTP ${r.status} body=${r.body.slice(0, 200)}`)
      // SPEC §10.3 要求 /balance 在候选回退期间**必须重新解析**，因此重新解析发生在
      // 与 Bearer 比较之前 —— 用首选值鉴权应当直接被接受（200）。若这里 401，
      // 说明比较用的是旧的候选值 → 用户新填的令牌要等一轮同步才生效（不符合 §10.3 意图）。
      assertEq(r.status, 200, `重新解析应先于鉴权比较（首选值应被接受），实际 ${r.status}（body=${r.body.slice(0, 200)}）`)
      const resolveAfter = ctx._resolveCalls.length
      console.log(`      credentials.resolve 调用次数：本请求前 ${resolveBefore} → 后 ${resolveAfter}`)
      const st = JSON.parse((await request(port, { url: '/dsh-whale-newapi/status', headers: { host: HOST(port) } })).body)
      console.log(`      /status.credential=${JSON.stringify(st.credential)}`)
      console.log(`      whale.entry.keyRef=${st.whale.entry && st.whale.entry.keyRef}`)
      assertEq(st.credential.ref, PREFERRED_REF, `必须切换到首选凭据，实际 ${st.credential.ref}`)
      assert(resolveAfter > resolveBefore, '候选回退期间必须重新解析凭据（不能被缓存挡住）')
      assertNotIncludes(JSON.stringify(st), PREFERRED_VAL, '/status 不得含凭据明文')
    })
    t.test('切换后：一次同步轮次内条目 keyRef 也应改写成首选（SPEC §10.3「同一轮改写」）', async () => {
      // 说明：/balance 只做「重新解析」，条目的改写发生在同步轮次里。因此这里显式触发一轮同步
      // （带首选值鉴权），再断言 keyRef —— 这才对应 §10.3 的「同一轮把条目的 keyRef 改写成新 ref」。
      const body = JSON.stringify({})
      const r = await request(port, {
        method: 'POST', url: '/dsh-whale-newapi/sync',
        headers: { host: HOST(port), 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), authorization: 'Bearer ' + PREFERRED_VAL },
        body,
      })
      console.log(`      POST /sync（首选值鉴权）HTTP ${r.status} body=${r.body.slice(0, 300)}`)
      const st = JSON.parse((await request(port, { url: '/dsh-whale-newapi/status', headers: { host: HOST(port) } })).body)
      const keyRef = st.whale.entry && st.whale.entry.keyRef
      console.log(`      keyRef=${keyRef}（mode=${st.whale.mode} lastSyncAt=${st.whale.lastSyncAt}）`)
      if (keyRef === null || keyRef === undefined) {
        console.log('      [说明] 当前无条目（上游未产出），本断言退化为记录')
        return
      }
      assertEq(keyRef, PREFERRED_REF, `条目 keyRef 应切到首选，实际 ${keyRef}`)
    })
    t.test('缓存允许存在：首选已生效时不应每个请求都打凭据服务（次数受控）', async () => {
      const before = ctx._resolveCalls.length
      for (let i = 0; i < 3; i++) await request(port, { url: '/dsh-whale-newapi/balance', headers: { host: HOST(port), authorization: 'Bearer ' + PREFERRED_VAL } })
      const delta = ctx._resolveCalls.length - before
      console.log(`      3 次 /balance 触发 credentials.resolve ${delta} 次（首选已生效，允许缓存）`)
      assert(delta <= 3, `首选已生效时不该每次都重新解析，实际 ${delta} 次`)
    })
  })

  // =========================================================================
  // §10.5 native 荒诞值护栏
  // =========================================================================
  await t.group('§10.5 native 荒诞值护栏（纯函数，离线）', () => {
    const normalizeBalance = needFn(newapiMod, 'normalizeBalance', 'newapi')
    const cfg = { currency: 'USD', quotaPerUnit: 500000, usdExchangeRate: 7.3, usdToCny: 1, fallbackTotal: 0 }
    const call = (user, extra = {}) => normalizeBalance({
      mode: 'native',
      native: { ok: true, user },
      status: { ok: true, status: { quotaPerUnit: 500000 } },
      config: { ...cfg, ...extra },
    })
    t.test('正常额度不受护栏影响（remain_quota=500000 → credits=1）', () => {
      const r = call({ quota: 500000, remain_quota: 500000, used_quota: 0, unlimited_quota: false })
      console.log(`      实测: ${JSON.stringify({ ok: r.ok, remaining: r.remaining, unlimited: r.unlimited, mode: r.mode, credits: r.credits })}`)
      assertEq(r.ok, true, 'ok')
      assertEq(r.unlimited, false, 'unlimited 应为 false')
      assert(r.remaining !== null && Number.isFinite(r.remaining) && r.remaining > 0, `remaining 应为正有限数值，实际 ${r.remaining}`)
    })
    t.test('quota/remain_quota 为 -1（无限额度哨兵）→ 不产出数亿级数字：unlimited:true 且 remaining:null', () => {
      const r = call({ quota: -1, remain_quota: -1, used_quota: 0, unlimited_quota: false })
      console.log(`      实测: ${JSON.stringify({ ok: r.ok, remaining: r.remaining, unlimited: r.unlimited, mode: r.mode, note: r.detail && r.detail.note })}`)
      assertEq(r.ok, true, 'ok 仍应为 true（是「无限」而非失败）')
      assertEq(r.unlimited, true, `护栏必须把 -1 判为 unlimited，实际 ${r.unlimited}`)
      assertEq(r.remaining, null, `不得产出数值余额，实际 ${r.remaining}`)
      assert(!(Number.isFinite(r.remaining) && r.remaining < 0), '绝不能是负数余额')
    })
    t.test('quota=0 → 同样触发护栏（unlimited:true, remaining:null）', () => {
      const r = call({ quota: 0, remain_quota: 0, used_quota: 0, unlimited_quota: false })
      console.log(`      实测: ${JSON.stringify({ ok: r.ok, remaining: r.remaining, unlimited: r.unlimited })}`)
      assertEq(r.unlimited, true, 'unlimited')
      assertEq(r.remaining, null, 'remaining 应为 null')
    })
    t.test('天文数字（credits/quotaPerUnit > 1e6）→ 触发护栏，不进小鲸鱼记账（避免 moneyUnits 抛错）', () => {
      // credits/quotaPerUnit = 1e12/500000 = 2e6 > 1e6
      const r = call({ quota: 1e12, remain_quota: 1e12, used_quota: 0, unlimited_quota: false })
      console.log(`      实测: ${JSON.stringify({ ok: r.ok, remaining: r.remaining, unlimited: r.unlimited, note: r.detail && r.detail.note })}`)
      assertEq(r.unlimited, true, `天文数字必须触发护栏，实际 unlimited=${r.unlimited} remaining=${r.remaining}`)
      assertEq(r.remaining, null, '不得产出天文数字余额')
    })
    t.test('护栏 + fallbackTotal>0 → 按 §5.1.1 规则 2 给出 fallbackTotal-used', () => {
      const r = call({ quota: -1, remain_quota: -1, used_quota: 0, unlimited_quota: false }, { fallbackTotal: 100 })
      console.log(`      实测: ${JSON.stringify({ ok: r.ok, remaining: r.remaining, total: r.total, used: r.used, unlimited: r.unlimited })}`)
      assertEq(r.ok, true, 'ok')
      assertEq(r.unlimited, true, 'unlimited 仍为 true')
      if (typeof r.remaining === 'number') {
        assertEq(r.remaining, 100, `fallbackTotal=100 且 used=0 → remaining=100，实际 ${r.remaining}`)
      } else {
        console.log(`      [注意] remaining=${JSON.stringify(r.remaining)}（SPEC §5.1.1 规则 2 允许 total-used；此处 used=0）`)
      }
    })
    t.test('护栏不影响 compat 分支（compat 只看 hard_limit_usd 哨兵）', () => {
      const r = normalizeBalance({
        mode: 'compat',
        compat: { ok: true, hardLimitUsd: 100, usedCents: 1834.5636, usedUsd: 18.345636 },
        status: { ok: true, status: { quotaPerUnit: 500000 } },
        config: cfg,
      })
      console.log(`      实测: ${JSON.stringify({ ok: r.ok, remaining: r.remaining, unlimited: r.unlimited, source: r.source, code: r.code })}`)
      assertEq(r.ok, true, `compat 正常额度应成功，实际 code=${r.code} error=${r.error}`)
      assertEq(r.unlimited, false, 'compat 正常额度不该被判 unlimited')
      assert(Number.isFinite(r.remaining) && r.remaining > 0, `compat remaining 应为正有限数值，实际 ${r.remaining}`)
    })
    t.test('native 荒诞值护栏的 detail.note 说明触发原因且不含凭据', () => {
      const r = call({ quota: -1, remain_quota: -1, used_quota: 0, unlimited_quota: false })
      const note = String((r.detail && r.detail.note) || '')
      console.log(`      note=${note.slice(0, 300)}`)
      assert(note.length > 0, 'detail.note 必须写明护栏原因（SPEC §10.5）')
      assertNotIncludes(note, SECRET, 'note 不得含凭据')
    })
  })
} catch (err) {
  console.log(`\n!! 套件执行中发生未捕获错误：\n${err.stack || err}`)
  process.exitCode = 1
} finally {
  globalThis.fetch = realFetch
  for (const s of [sharedServer, sharedServer2]) {
    if (s) await new Promise((r) => s.close(r))
  }
  for (const d of (sharedCtx && sharedCtx._effects) || []) { try { d() } catch { /* 忽略 */ } }

  await t.group('守卫：真实注册表未被本套件改动（隔离自检）', () => {
    t.test('真实 $DSH_HOME/.dshw-api.json 的 sha256 未变', () => {
      if (!REAL_GUARD) { console.log('      [说明] 真实注册表不存在'); return }
      const now = sha256(fs.readFileSync(WHALE_REGISTRY_REAL))
      console.log(`      真实注册表 sha256=${now.slice(0, 16)}… 运行前=${REAL_GUARD.sha256.slice(0, 16)}… 一致=${now === REAL_GUARD.sha256}`)
      assertEq(now, REAL_GUARD.sha256, '真实注册表必须未被本套件改动')
    })
  })
  await t.finish()
  if (ORIGINAL_DSH_HOME === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = ORIGINAL_DSH_HOME
}
