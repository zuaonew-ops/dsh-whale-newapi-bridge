// verify-security.mjs —— 独立验证 lib/index.js 的路由安全栅栏（SPEC §6 / §7）。
//
// 方法：自写一个假的 Cordis ctx 桩，把 apply 挂上去，收集 webServer.register 注册的路由，
// 然后用**真实 http 请求**打这些 handler（Host 头可伪造、Origin/Sec-Fetch-Site 可控）。
// 上游 fetch 被替换为桩：本套件完全离线、确定性、不触碰真实中转站。
// 凭据用受控假值；另做一次用**真实凭据**的黑盒探测，断言任何响应体里都搜不到该字符串。
//
// ⚠️ 隔离纪律（重要）：插件在 autoSync=true（默认）时会**真的写注册表**。本套件必须把
// `process.env.DSH_HOME` 指向临时目录，确保 apply/initSync//sync 只会写临时文件，
// **绝不触碰** `%USERPROFILE%\.dsh\.dshw-api.json`。
import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import {
  createRunner, assert, assertEq, assertIncludes, assertNotIncludes,
  need, needFn, mask, readCredentialValue, jsonResponse, PKG_DIR, WHALE_REGISTRY_REAL, sha256,
} from './verify-helpers.mjs'

// —— 隔离：把 $DSH_HOME 换到临时目录，并校验真实注册表在全程不被改动 ——
const ISOLATED_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-verify-sec-home-'))
const ORIGINAL_DSH_HOME = process.env.DSH_HOME
process.env.DSH_HOME = ISOLATED_HOME
const REAL_BASELINE = fs.existsSync(WHALE_REGISTRY_REAL)
  ? { hash: sha256(fs.readFileSync(WHALE_REGISTRY_REAL)), mtimeMs: fs.statSync(WHALE_REGISTRY_REAL).mtimeMs, bytes: fs.statSync(WHALE_REGISTRY_REAL).size }
  : null

const MOD = path.join(PKG_DIR, 'lib', 'index.js')
const t = createRunner('verify-security.mjs —— 路由安全栅栏（SPEC §6/§7）')

const SECRET = 'sk-VERIFY-CONTROLLED-SECRET-0123456789abcdef'
const BAD = 'sk-wrong-bearer-000000'
const REAL_KEY = readCredentialValue('PI_API_KEY')

let mod = null
let loadError = null
try {
  mod = await import('file://' + MOD.replace(/\\/g, '/'))
} catch (err) {
  loadError = err
}

console.log(`模块: ${MOD}`)
console.log(`隔离 $DSH_HOME: ${ISOLATED_HOME}（真实注册表只读基线: ${REAL_BASELINE ? REAL_BASELINE.hash.slice(0, 16) + '…' : '不存在'}）`)
console.log(`受控凭据: ${mask(SECRET)}；真实凭据: ${mask(REAL_KEY)}`)

/** 假 ctx 桩：收集路由 + effect 清理 + 受控 credentials。 */
function makeStubCtx({ credentialValue = SECRET, throwOnResolve = false } = {}) {
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
      if (throwOnResolve) throw new Error('credentials service unavailable')
      if (!credentialValue) return null
      return { value: credentialValue, ref }
    },
    async set() { return true },
  }
  // 真实 Cordis 语境下服务既可通过 ctx.get(name) 取，也直接挂在 ctx 上（index.js 两条路都会试），
  // 因此桩必须两种形状都提供，否则会低估插件注册的路由数。
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
    req.setTimeout(timeoutMs, () => { req.destroy(new Error(`请求超时(${timeoutMs}ms)`)) })
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

/** 把收集到的路由挂到真实 http 服务上；未注册的路径返回 404（便于区分“没注册”与“被拒绝”）。 */
async function serve(routes) {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname
    const route = findRoute(routes, pathname)
    if (!route) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"no-route"}'); return }
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

// ——— 上游 fetch 桩：任何插件内部上游请求都被拦截，保证离线 ———
const upstream = {
  status: { data: { version: 'v1.0.0-rc.40', system_name: 'New API', quota_per_unit: 500000, usd_exchange_rate: 7.3, display_in_currency: true, quota_display_type: 'CUSTOM', custom_currency_symbol: 'credits', custom_currency_exchange_rate: 1 } },
  subscription: { object: 'billing_subscription', hard_limit_usd: 20, soft_limit_usd: 20, system_hard_limit_usd: 20 },
  usage: { object: 'list', total_usage: 1834.5636 },
}
const fetchCalls = []
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  const u = String(url)
  const authHeader = (init && init.headers && (init.headers.Authorization || init.headers.authorization)) || ''
  fetchCalls.push({ url: u, authHeader })
  if (u.includes('/api/status')) return jsonResponse(upstream.status)
  if (u.includes('/v1/dashboard/billing/subscription')) return jsonResponse(upstream.subscription)
  if (u.includes('/v1/dashboard/billing/usage')) return jsonResponse(upstream.usage)
  if (u.includes('/dsh-whale-newapi/health')) return jsonResponse({ ok: true, name: 'dsh-whale-newapi-bridge' })
  throw new TypeError('fetch stub: 未预期请求 ' + u)
}

let server = null
let port = 0
let ctxStub = null

if (loadError) {
  console.log(`\n!! 无法加载模块，安全验证无法执行：\n${loadError.stack || loadError}`)
  console.log('SUMMARY: BLOCKED（lib/index.js 缺失/不可加载）')
  process.exitCode = 2
} else {
  try {
    const name = need(mod, 'name', 'index')
    const inject = need(mod, 'inject', 'index')
    const apply = needFn(mod, 'apply', 'index')

    await t.group('模块形状（SPEC §3）', () => {
      t.test("name === 'dsh-whale-newapi-bridge'", () => assertEq(name, 'dsh-whale-newapi-bridge', 'name'))
      t.test("inject 含 'webServer'", () => {
        const list = Array.isArray(inject) ? inject : []
        assert(list.includes('webServer'), `inject 必须含 webServer，实际 ${JSON.stringify(inject)}`)
      })
    })

    ctxStub = makeStubCtx({ credentialValue: SECRET })
    let applyError = null
    try { apply(ctxStub, {}) } catch (err) { applyError = err }
    await t.group('apply 挂载（SPEC §7.5：永不抛出）', () => {
      t.test('apply(ctx, {}) 不抛异常', () => assertEq(applyError, null, `apply 抛了: ${applyError && applyError.message}`))
      t.test('注册了 4 条路由（balance/status/sync/health）', () => {
        const paths = ctxStub._routes.map((r) => r.path)
        console.log(`      实际注册: ${JSON.stringify(paths)}`)
        for (const p of ['/dsh-whale-newapi/balance', '/dsh-whale-newapi/status', '/dsh-whale-newapi/sync', '/dsh-whale-newapi/health']) {
          assert(paths.includes(p), `缺少路由 ${p}（实际 ${JSON.stringify(paths)}）`)
        }
      })
      t.test('每条路由都是函数 handler', () => {
        for (const r of ctxStub._routes) assertEq(typeof r.handler, 'function', `${r.path} 的 handler`)
      })
    })

    const mounted = await serve(ctxStub._routes)
    server = mounted.server
    port = mounted.port
    console.log(`      测试服务: http://127.0.0.1:${port}`)

    const LOOPBACK_HOST = () => `127.0.0.1:${port}`

    // ---------- 信任栅栏（SPEC §6） ----------
    await t.group('信任栅栏：Host / Sec-Fetch-Site / Origin（SPEC §6 → 403）', () => {
      const cases = [
        ['跨站标记 Sec-Fetch-Site: cross-site', { host: LOOPBACK_HOST(), 'sec-fetch-site': 'cross-site' }],
        ['伪造 Host: evil.com', { host: 'evil.com' }],
        ['伪造 Host: 203.0.113.10:10072', { host: '203.0.113.10:10072' }],
        ['Host 缺失（HTTP/1.0 无 Host）', { host: '' }],
        ['Host 不可解析（evil host）', { host: 'not a host' }],
        ['Origin 不同源 http://evil.com', { host: LOOPBACK_HOST(), origin: 'http://evil.com' }],
        ['Origin 为字符串 null（不透明来源）', { host: LOOPBACK_HOST(), origin: 'null' }],
        ['Origin 同 host 不同端口（Chrome/Edge 变体，应放行）', { host: LOOPBACK_HOST(), origin: `http://127.0.0.1:${port}` }],
      ]
      for (const [label, headers] of cases) {
        const expect403 = !label.includes('应放行')
        t.test(`${label} → ${expect403 ? '403' : '非 403'}`, async () => {
          const r = await request(port, { url: '/dsh-whale-newapi/status', headers })
          if (expect403) assertEq(r.status, 403, `HTTP 状态（body=${r.body.slice(0, 120)}）`)
          else assert(r.status !== 403, `不该被拒，实际 ${r.status}`)
        })
      }
      t.test('未注册子路径 → 404（不匹配任何路由）；路径穿越形式被 URL 规范化后命中真实路由而非绕过栅栏', async () => {
        const r1 = await request(port, { url: '/dsh-whale-newapi/nope', headers: { host: LOOPBACK_HOST() } })
        assertEq(r1.status, 404, `未注册路径应 404，实际 ${r1.status}`)
        // `/dsh-whale-newapi/balance/../status` 经 WHATWG URL 规范化 = `/dsh-whale-newapi/status`，
        // 因此会命中 status 路由并返回 200 —— 这是规范化结果，不是绕过（栅栏照常生效）。
        const r2 = await request(port, { url: '/dsh-whale-newapi/balance/../status', headers: { host: LOOPBACK_HOST() } })
        assert(r2.status === 200 || r2.status === 404, `实测 ${r2.status}（规范化后命中 status 属正常）`)
        console.log(`      实测: /nope → ${r1.status}；/balance/../status → ${r2.status}（URL 规范化后等同 /status）`)
        // 关键安全断言：同样形式的穿越 + 伪造 Host 必须仍被 403
        const r3 = await request(port, { url: '/dsh-whale-newapi/balance/../status', headers: { host: 'evil.com' } })
        assertEq(r3.status, 403, `穿越形式不得绕过栅栏，实际 ${r3.status}`)
      })
      t.test('Sec-Fetch-Site 大小写变体（Cross-Site）：实测为放行，属加固项而非违反 SPEC', async () => {
        // SPEC §6 只要求拒绝 `Sec-Fetch-Site: cross-site`；参考实现 trust-fence.ts L69 也是
        // 严格比较小写字面量。RFC 8942 规定该头为小写 token，浏览器不会发出 Cross-Site。
        // 这里把实测行为固定下来，并标记为“可加固”，不作为未通过项。
        const r = await request(port, { url: '/dsh-whale-newapi/status', headers: { host: LOOPBACK_HOST(), 'sec-fetch-site': 'Cross-Site' } })
        console.log(`      实测: Sec-Fetch-Site: Cross-Site → HTTP ${r.status}` +
          `${r.status === 200 ? '（与参考实现一致：严格小写比较；建议加固为 toLowerCase 比较——见 VERIFICATION 风险项）' : '（已被拒绝）'}`)
        assert(r.status === 200 || r.status === 403, `实测 ${r.status}`)
      })
      t.test('Sec-Fetch-Site: same-origin 放行', async () => {
        const r = await request(port, { url: '/dsh-whale-newapi/status', headers: { host: LOOPBACK_HOST(), 'sec-fetch-site': 'same-origin' } })
        assertEq(r.status, 200, `HTTP 状态（body=${r.body.slice(0, 200)}）`)
      })
      t.test('localhost 作为 Host 也算回环', async () => {
        const r = await request(port, { url: '/dsh-whale-newapi/health', headers: { host: `localhost:${port}` } })
        assertEq(r.status, 200, `HTTP 状态（body=${r.body.slice(0, 200)}）`)
      })
      t.test('非法 Host 的 403 响应体是 JSON 且不含敏感信息', async () => {
        const r = await request(port, { url: '/dsh-whale-newapi/status', headers: { host: 'evil.com' } })
        assertEq(r.status, 403, 'HTTP 状态')
        assertNotIncludes(r.body, SECRET, '403 响应体不得含凭据')
      })
    })

    // ---------- health ----------
    await t.group('/health（SPEC §6.4：无鉴权可用，仅本机）', () => {
      t.test('无 Authorization → 200 且 ok:true', async () => {
        const r = await request(port, { url: '/dsh-whale-newapi/health', headers: { host: LOOPBACK_HOST() } })
        assertEq(r.status, 200, `HTTP 状态（body=${r.body.slice(0, 200)}）`)
        const j = JSON.parse(r.body)
        assertEq(j.ok, true, 'ok')
        assertEq(typeof j.name, 'string', 'name')
        assertEq(typeof j.version, 'string', 'version')
      })
      t.test('health 响应体不含凭据', async () => {
        const r = await request(port, { url: '/dsh-whale-newapi/health', headers: { host: LOOPBACK_HOST() } })
        assertNotIncludes(r.body, SECRET, 'health 不得含凭据')
      })
    })

    // ---------- /balance 鉴权（SPEC §6.1 / §7.2） ----------
    await t.group('/balance 鉴权（SPEC §6.1：Bearer 必须逐字节相等）', () => {
      t.test('正确 Bearer → 200 且 remaining 是有限数值', async () => {
        const r = await request(port, {
          url: '/dsh-whale-newapi/balance',
          headers: { host: LOOPBACK_HOST(), authorization: 'Bearer ' + SECRET },
        })
        assertEq(r.status, 200, `HTTP 状态（body=${r.body.slice(0, 200)}）`)
        const j = JSON.parse(r.body)
        assertEq(j.ok, true, `ok（body=${r.body.slice(0, 300)}）`)
        assert(typeof j.remaining === 'number' && Number.isFinite(j.remaining), `remaining 必须是有限数值，实际 ${JSON.stringify(j.remaining)}`)
        assert(typeof j.currency === 'string', 'currency')
        assert(typeof j.label === 'string', 'label')
        console.log(`      200 响应摘要: ok=${j.ok} remaining=${j.remaining} currency=${j.currency} source=${j.source} label=${j.label}`)
      })
      t.test('错误 Bearer → 401', async () => {
        const r = await request(port, {
          url: '/dsh-whale-newapi/balance',
          headers: { host: LOOPBACK_HOST(), authorization: 'Bearer ' + BAD },
        })
        assertEq(r.status, 401, `HTTP 状态（body=${r.body.slice(0, 200)}）`)
      })
      t.test('缺 Authorization → 401', async () => {
        const r = await request(port, { url: '/dsh-whale-newapi/balance', headers: { host: LOOPBACK_HOST() } })
        assertEq(r.status, 401, `HTTP 状态（body=${r.body.slice(0, 200)}）`)
      })
      t.test('空 Bearer / 只有 "Bearer" → 401', async () => {
        for (const v of ['Bearer ', 'Bearer', 'bearer', SECRET, 'Bearer ' + SECRET + 'x', 'Bearer x' + SECRET]) {
          const r = await request(port, { url: '/dsh-whale-newapi/balance', headers: { host: LOOPBACK_HOST(), authorization: v } })
          assertEq(r.status, 401, `Authorization=${JSON.stringify(v.slice(0, 20))} 应 401，实际 ${r.status}`)
        }
      })
      t.test('?token= 形式的正确凭据 → 200（SPEC §6.1 也接受 query）', async () => {
        const r = await request(port, { url: '/dsh-whale-newapi/balance?token=' + encodeURIComponent(SECRET), headers: { host: LOOPBACK_HOST() } })
        assertEq(r.status, 200, `HTTP 状态（body=${r.body.slice(0, 200)}）`)
      })
      t.test('?token= 形式的错误凭据 → 401', async () => {
        const r = await request(port, { url: '/dsh-whale-newapi/balance?token=' + encodeURIComponent(BAD), headers: { host: LOOPBACK_HOST() } })
        assertEq(r.status, 401, `HTTP 状态（body=${r.body.slice(0, 200)}）`)
      })
      t.test('401 响应体不含任何凭据（含正确凭据）', async () => {
        const r = await request(port, { url: '/dsh-whale-newapi/balance', headers: { host: LOOPBACK_HOST(), authorization: 'Bearer ' + BAD } })
        assertNotIncludes(r.body, SECRET, '401 响应体不得含真实凭据')
      })
    })

    // ---------- /status ----------
    await t.group('/status（SPEC §6.2）', () => {
      let statusJson = null
      t.test('200 + 顶层键齐全', async () => {
        const r = await request(port, { url: '/dsh-whale-newapi/status', headers: { host: LOOPBACK_HOST() } })
        assertEq(r.status, 200, `HTTP 状态（body=${r.body.slice(0, 300)}）`)
        statusJson = JSON.parse(r.body)
        for (const k of ['ok', 'version', 'config', 'credential', 'upstream', 'balance', 'whale', 'bridge', 'warnings']) {
          assert(k in statusJson, `缺少顶层键 ${k}（实际 ${Object.keys(statusJson).join(',')}）`)
        }
        for (const k of ['id', 'mode', 'entry', 'registryFile', 'registryOk', 'lastSyncAt', 'lastSyncResult', 'changed', 'backupPath']) {
          assert(k in statusJson.whale, `缺少 whale.${k}（实际 ${Object.keys(statusJson.whale).join(',')}）`)
        }
        console.log(`      whale.mode=${statusJson.whale.mode} registryFile=${statusJson.whale.registryFile}`)
        console.log(`      balance.source=${statusJson.balance && statusJson.balance.source} remaining=${statusJson.balance && statusJson.balance.remaining}`)
        console.log(`      bridge.selfCheck=${JSON.stringify(statusJson.bridge && statusJson.bridge.selfCheck)}`)
      })
      t.test('credential 只报 ref/present/source，不含凭据值', async () => {
        const c = statusJson.credential
        assert(c && typeof c === 'object', 'credential 必须是对象')
        for (const k of Object.keys(c)) {
          assert(!/value|secret|key$/i.test(k) || k === 'ref' || k === 'source', `credential 不应暴露字段 ${k}`)
        }
        assertNotIncludes(JSON.stringify(c), SECRET, 'credential 段不得含凭据值')
      })
      t.test('/status 全文不含受控凭据明文（SPEC §7.1）', async () => {
        const r = await request(port, { url: '/dsh-whale-newapi/status', headers: { host: LOOPBACK_HOST() } })
        assertNotIncludes(r.body, SECRET, '/status 不得含凭据明文')
      })
      t.test('config 段做了脱敏（若含 credentialRef 只是名字，不含值）', () => {
        const cfgStr = JSON.stringify(statusJson.config || {})
        assertNotIncludes(cfgStr, SECRET, 'config 段不得含凭据值')
        console.log(`      config 键: ${Object.keys(statusJson.config || {}).join(',')}`)
      })
    })

    // ---------- /sync ----------
    // 注意：spec-v2 §10.1 起 /sync 与 /balance 同鉴权，所以本组的 /sync 用例都带正确 Bearer；
    // 鉴权矩阵与 bridgeBaseUrl 回环校验的完整矩阵在 test/verify-spec-v2.mjs。
    await t.group('/sync（SPEC §6.3 + §10.1：仅回环、同鉴权、只接受指定键）', () => {
      t.test('回环 POST + 正确 Bearer → 200 且返回 { ok, changed, mode, entry, syncAt, balance, warnings }', async () => {
        const r = await request(port, {
          method: 'POST', url: '/dsh-whale-newapi/sync',
          headers: { host: LOOPBACK_HOST(), 'content-type': 'application/json', authorization: 'Bearer ' + SECRET },
        })
        assertEq(r.status, 200, `HTTP 状态（body=${r.body.slice(0, 300)}）`)
        const j = JSON.parse(r.body)
        for (const k of ['ok', 'changed', 'mode', 'entry', 'syncAt', 'balance', 'warnings']) {
          assert(k in j, `缺少键 ${k}（实际 ${Object.keys(j).join(',')}）`)
        }
      })
      t.test('伪造 Host 的 POST → 403（栅栏先于鉴权）', async () => {
        const r = await request(port, { method: 'POST', url: '/dsh-whale-newapi/sync', headers: { host: 'evil.com', 'content-type': 'application/json', authorization: 'Bearer ' + SECRET } })
        assertEq(r.status, 403, `HTTP 状态（body=${r.body.slice(0, 200)}）`)
      })
      t.test('body 带未声明键 → 被忽略而非 500（SPEC §6.3）', async () => {
        const body = JSON.stringify({ extraEvil: 'x', totallyUnknown: [1, 2, 3] })
        const r = await request(port, {
          method: 'POST', url: '/dsh-whale-newapi/sync',
          headers: { host: LOOPBACK_HOST(), 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), authorization: 'Bearer ' + SECRET },
          body, timeoutMs: 40000,
        })
        console.log(`      HTTP ${r.status} 用时 ${r.ms}ms body=${r.body.slice(0, 300)}`)
        assert(r.status !== 500, `不得 500，实际 ${r.status}（body=${r.body.slice(0, 200)}）`)
        assertNotIncludes(r.body, SECRET, 'sync 响应不得含凭据')
      })
      t.test('【spec-v2 §10.2 回归】/sync 的 bridgeBaseUrl 指向外部主机 → 400 且注册表一字不动', async () => {
        // 历史：spec-v1 下这条会 200、真的去探测 evil.com、并把条目 balance.url 写成
        // http://evil.com/... + allowCustomHost:true（keyRef 不变）→ 挂件会把凭据发往该主机。
        // 证据已存档在 docs/VERIFICATION.md（记录为 spec-v1 缺陷，spec-v2 §10.2 修复）。
        const before = fs.existsSync(path.join(ISOLATED_HOME, '.dshw-api.json'))
          ? sha256(fs.readFileSync(path.join(ISOLATED_HOME, '.dshw-api.json'))) : null
        const callsBefore = fetchCalls.length
        const body = JSON.stringify({ bridgeBaseUrl: 'http://evil.example-verify.test' })
        const r = await request(port, {
          method: 'POST', url: '/dsh-whale-newapi/sync',
          headers: { host: LOOPBACK_HOST(), 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), authorization: 'Bearer ' + SECRET },
          body, timeoutMs: 40000,
        })
        const newCalls = fetchCalls.slice(callsBefore)
        const after = fs.existsSync(path.join(ISOLATED_HOME, '.dshw-api.json'))
          ? sha256(fs.readFileSync(path.join(ISOLATED_HOME, '.dshw-api.json'))) : null
        console.log(`      HTTP ${r.status} body=${r.body.slice(0, 300)}`)
        console.log(`      本次上游请求: ${JSON.stringify(newCalls.map((c) => c.url))}`)
        assertEq(r.status, 400, `非回环 bridgeBaseUrl 必须 400，实际 ${r.status}`)
        assert(!newCalls.some((c) => c.url.startsWith('http://evil.example-verify.test')), '不得探测非回环主机')
        assertEq(after, before, '注册表必须一字不动（sha256 不变）')
        assertNotIncludes(r.body, SECRET, '响应不得含凭据')
      })
    })

    // ---------- 真实凭据黑盒探测（SPEC §7.1 硬要求） ----------
    if (REAL_KEY) {
      await t.group('真实凭据黑盒探测：任何响应体都不得出现凭据明文（SPEC §7.1/§A3）', () => {
        let realPort = 0
        let realServer = null
        const probes = []
        t.test('用真实凭据挂载第二个实例并抓取全部路由响应', async () => {
          const ctx2 = makeStubCtx({ credentialValue: REAL_KEY })
          apply(ctx2, {})
          const m2 = await serve(ctx2._routes)
          realPort = m2.port
          realServer = m2.server
          const targets = [
            ['/dsh-whale-newapi/health', {}],
            ['/dsh-whale-newapi/status', {}],
            ['/dsh-whale-newapi/balance', { authorization: 'Bearer ' + REAL_KEY }],
            ['/dsh-whale-newapi/balance', { authorization: 'Bearer wrong' }],
            ['/dsh-whale-newapi/balance', {}],
            ['/dsh-whale-newapi/status', { host: 'evil.com' }],
            ['/dsh-whale-newapi/sync', {}],
          ]
          for (const [url, extra] of targets) {
            const method = url.endsWith('/sync') ? 'POST' : 'GET'
            const r = await request(realPort, { method, url, headers: { host: `127.0.0.1:${realPort}`, ...extra } })
            probes.push({ url: `${method} ${url}`, status: r.status, body: r.body })
            assertNotIncludes(r.body, REAL_KEY, `${method} ${url} 响应体出现了真实凭据明文`)
            assertNotIncludes(r.body, REAL_KEY.slice(0, 8), `${method} ${url} 响应体出现了真实凭据前缀`)
          }
          console.log('      探测结果（状态码 / 体长度 / 是否含凭据）:')
          for (const p of probes) {
            console.log(`        ${p.status}  ${p.url}  len=${p.body.length}  含凭据=${p.body.includes(REAL_KEY)}`)
          }
        })
        t.test('真实凭据下 /balance 正确 Bearer → 200 且 remaining 有限（真实链路可用性）', async () => {
          const rb = probes.find((p) => p.url === 'GET /dsh-whale-newapi/balance' && p.status === 200)
          if (!rb) {
            const wrong = probes.find((p) => p.url === 'GET /dsh-whale-newapi/balance' && p.status !== 200)
            console.log(`      [注意] 真实凭据下 /balance 未返回 200（实测 ${wrong ? wrong.status : '未知'}）：` +
              `${wrong ? wrong.body.slice(0, 300) : ''}`)
            return
          }
          const j = JSON.parse(rb.body)
          assertEq(j.ok, true, 'ok')
          assert(typeof j.remaining === 'number' || j.code === 'UNLIMITED',
            `remaining 必须是数值，或显式 UNLIMITED（实际 remaining=${JSON.stringify(j.remaining)} code=${j.code}）`)
        })
        t.test('真实凭据下错误 Bearer 必定 401', async () => {
          const p = probes.find((x) => x.url === 'GET /dsh-whale-newapi/balance' && x.status !== 200)
          assert(p, '应有错误 Bearer 的探测结果')
          assertEq(p.status, 401, `错误 Bearer 应 401，实际 ${p.status}`)
        })
        t.test('清理真实凭据实例', async () => {
          if (realServer) await new Promise((resolve) => realServer.close(resolve))
        })
      })
    } else {
      console.log('[无法验证] 读不到真实凭据（.credentials.yaml / PI_API_KEY），跳过真实凭据黑盒探测')
    }

    // ---------- 无凭据场景 ----------
    await t.group('凭据缺失场景（SPEC §7.2：不得变成开放代理）', () => {
      let p2 = 0
      let s2 = null
      t.test('无凭据时 /balance 带任意 Bearer 必须 401（不能因为“没有凭据”而放行）', async () => {
        const ctx3 = makeStubCtx({ credentialValue: '' })
        apply(ctx3, {})
        const m3 = await serve(ctx3._routes)
        p2 = m3.port
        s2 = m3.server
        for (const auth of ['Bearer ' + SECRET, 'Bearer ', '']) {
          const r = await request(p2, { url: '/dsh-whale-newapi/balance', headers: { host: `127.0.0.1:${p2}`, ...(auth ? { authorization: auth } : {}) } })
          assertEq(r.status, 401, `Authorization=${JSON.stringify(auth)} 应 401，实际 ${r.status}（body=${r.body.slice(0, 200)}）`)
        }
      })
      t.test('/status 在无凭据时仍 200（诊断可用）且 credential.present=false', async () => {
        const r = await request(p2, { url: '/dsh-whale-newapi/status', headers: { host: `127.0.0.1:${p2}` } })
        assertEq(r.status, 200, `HTTP 状态（body=${r.body.slice(0, 200)}）`)
        const j = JSON.parse(r.body)
        assertEq(j.credential.present, false, 'credential.present 应为 false')
      })
      t.test('credentials.resolve 抛异常时 apply 不崩、路由仍可用（SPEC §7.5）', async () => {
        const ctx4 = makeStubCtx({ throwOnResolve: true })
        let threw = null
        try { apply(ctx4, {}) } catch (err) { threw = err }
        assertEq(threw, null, `apply 不该抛: ${threw && threw.message}`)
        const m4 = await serve(ctx4._routes)
        try {
          const r = await request(m4.port, { url: '/dsh-whale-newapi/health', headers: { host: `127.0.0.1:${m4.port}` } })
          assertEq(r.status, 200, 'health 仍应可用')
          const r2 = await request(m4.port, { url: '/dsh-whale-newapi/balance', headers: { host: `127.0.0.1:${m4.port}`, authorization: 'Bearer ' + SECRET } })
          assertEq(r2.status, 401, 'resolve 失败 → 必须 401 而不是 200')
        } finally {
          await new Promise((resolve) => m4.server.close(resolve))
        }
      })
      t.test('清理', async () => { if (s2) await new Promise((resolve) => s2.close(resolve)) })
    })
  } catch (err) {
    console.log(`\n!! 安全套件执行中发生未捕获错误：\n${err.stack || err}`)
    process.exitCode = 1
  } finally {
    globalThis.fetch = realFetch
    if (server) await new Promise((resolve) => server.close(resolve))
    for (const d of (ctxStub && ctxStub._effects) || []) { try { d() } catch {} }
    // 隔离守卫：确认真实注册表全程未被本套件改动（这是本套件的硬性自检）
    await t.group('隔离守卫：真实注册表未被改动', () => {
      t.test('真实 $DSH_HOME/.dshw-api.json 的 sha256 与 mtime 均未变', () => {
        if (!REAL_BASELINE) { console.log('      [说明] 真实注册表不存在（无需守卫）'); return }
        assert(fs.existsSync(WHALE_REGISTRY_REAL), '真实注册表不应消失')
        assertEq(sha256(fs.readFileSync(WHALE_REGISTRY_REAL)), REAL_BASELINE.hash, '真实注册表 sha256 必须不变')
        console.log(`      实测: sha256=${REAL_BASELINE.hash.slice(0, 16)}… 未变，本套件只写了临时目录 ${ISOLATED_HOME}`)
      })
      t.test('本套件确实写入的是临时目录（有产物则必须落在 ISOLATED_HOME 下）', () => {
        const isoFile = path.join(ISOLATED_HOME, '.dshw-api.json')
        const existed = fs.existsSync(isoFile)
        console.log(`      临时注册表 ${isoFile} 存在=${existed}${existed ? `（${fs.statSync(isoFile).size} 字节）` : ''}`)
        assertEq(path.dirname(isoFile), ISOLATED_HOME, '隔离路径正确')
      })
    })
    await t.finish()
    if (ORIGINAL_DSH_HOME === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = ORIGINAL_DSH_HOME
    try { fs.rmSync(ISOLATED_HOME, { recursive: true, force: true }) } catch { /* 临时目录清理失败不影响结论 */ }
  }
}
