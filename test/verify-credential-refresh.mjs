// verify-credential-refresh.mjs —— task-10：独立验证「凭据值被替换后能重新解析」。
//
// 真机事故：用户把 refs.NEWAPI_RELAY_TOKEN 填成占位符 → 上游 /api/user/self 401；
// 之后用户**修正了该值也不生效**，因为 resolveCredential 命中内存缓存
// （spec-v2 §10.3 原本只在「缓存 ref ≠ config.credentialRef」时重解析）。
// 这与宿主 `credentials` 服务契约冲突：
//   `abstract resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined>` ——
//   "Resolve one reference to its current value. Resolution is per call: consumers re-resolve at
//    each operation and must not cache across operations — that per-operation read is what makes a
//    changed credential reach the next operation without a restart."
//   （原文由我从 D:\ai hook\deepseekharness\resources\app.asar 第 1014486 行 rg + 读取提取）
// core 在 task-9 实现：一次取数**整体因鉴权失败**（所有 authMode 都是 401/403）时作废凭据缓存。
//
// 本套件：
//   a. 值被替换能生效：A → 上游 401 → 缓存作废 → 换成 B → 下一次操作**必须**用 B；
//   b. 成功路径仍缓存：上游 200 时连续操作 → resolve 0 次（必须保持绿）；
//   c. internal 有可观察的作废痕迹（core 实现字段：
//      credentialResolveCalls / credentialCacheHits / credentialInvalidations / credentialCacheInvalidatedAt）；
//   d. 对抗性边界（core 建议）：native 单模式 401 / 401+403 混合 / 部分失败不得作废 / NO_CREDENTIAL 不得误判 /
//      作废后**同一次**后续操作就得用上新值。
//
// 纪律：隔离 $DSH_HOME 到临时目录；真实 .dshw-api.json 全程只读 + sha256 守卫；不打印凭据明文（本套件用的是自造假值）。
import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import {
  createRunner, assert, assertEq, assertNotIncludes,
  needFn, sha256, PKG_DIR, WHALE_REGISTRY_REAL,
} from './verify-helpers.mjs'

const MOD = path.join(PKG_DIR, 'lib', 'index.js')
const ISOLATED_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-verify-credhome-'))
process.env.DSH_HOME = ISOLATED_HOME
const ISO_REGISTRY = path.join(ISOLATED_HOME, '.dshw-api.json')
const REAL_GUARD = fs.existsSync(WHALE_REGISTRY_REAL)
  ? { sha256: sha256(fs.readFileSync(WHALE_REGISTRY_REAL)), bytes: fs.statSync(WHALE_REGISTRY_REAL).size }
  : null

const t = createRunner('verify-credential-refresh.mjs —— 凭据值替换后必须重新解析（host credentials 契约）')

const REF = 'NEWAPI_RELAY_TOKEN'
const VALUE_A = 'VERIFY-PLACEHOLDER-TOKEN-A-0001'
const VALUE_B = 'VERIFY-CORRECTED-TOKEN-B-0002'
const VALUE_SK = 'sk-VERIFY-COMPAT-FIRST-0003'

console.log(`模块: ${MOD}`)
console.log(`lib/index.js sha256=${sha256(fs.readFileSync(MOD)).slice(0, 16)}…`)
console.log(`隔离 $DSH_HOME: ${ISOLATED_HOME}`)
console.log(`真实注册表只读基线: ${REAL_GUARD ? REAL_GUARD.sha256.slice(0, 16) + '… (' + REAL_GUARD.bytes + ' 字节)' : '不存在'}`)
console.log(`凭据 ref=${REF}；A/B/sk 均为套件自造假值（不涉及用户真实凭据）`)

const apply = needFn(await import('file://' + MOD.replace(/\\/g, '/')), 'apply', 'index')

const HOST = (p) => `127.0.0.1:${p}`
const AUTH401 = { code: 'AUTH_UNAUTHORIZED', message: 'Unauthorized, invalid access token', success: false }

async function request(port, { method = 'GET', url = '/', headers = {}, body = null, timeoutMs = 30000 } = {}) {
  return await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers, setHost: false }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
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

/**
 * 一次独立的插件实例。
 * @param opts.credentialValue - 桩 credentials 当前返回的值（null = 解析不到）
 * @param opts.plan            - 每个上游端点的状态码：`{ userSelf, billing }`
 * @param opts.config          - 覆盖 apply 的配置
 */
function makeHarness(opts = {}) {
  const state = {
    credentialValue: 'credentialValue' in opts ? opts.credentialValue : VALUE_A,
    plan: opts.plan || { userSelf: 401, billing: 401 },
    upstreamCalls: [], resolveCalls: [], routes: [], effects: [],
  }
  const webServer = {
    register(spec) { state.routes.push(spec); return () => { const i = state.routes.indexOf(spec); if (i >= 0) state.routes.splice(i, 1) } },
  }
  const credentials = {
    async resolve(ref) {
      state.resolveCalls.push(ref)
      if (ref !== REF) return null
      return state.credentialValue ? { value: state.credentialValue, ref } : null
    },
    async describe(ref) { return { ref, present: state.credentialValue !== null, source: 'test' } },
    async set() { return true },
  }
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    inject(names, fn) { return fn(ctx) },
    get(name) {
      if (name === 'credentials') return credentials
      if (name === 'connection') return { on() { return () => {} } }
      if (name === 'webServer') return webServer
      return undefined
    },
    effect(fn) { const d = fn(); if (typeof d === 'function') state.effects.push(d); return () => {} },
    on() { return () => {} },
    setInterval, clearInterval,
  }
  ctx.webServer = webServer
  ctx.credentials = credentials
  ctx.connection = { on() { return () => {} } }

  const j = (obj) => ({ ok: true, status: 200, headers: new Map([['content-type', 'application/json']]), async json() { return obj }, async text() { return JSON.stringify(obj) } })
  const err = (status, obj) => ({ ok: false, status, headers: new Map([['content-type', 'application/json']]), async json() { return obj ?? {} }, async text() { return JSON.stringify(obj ?? {}) } })

  const fetchImpl = async (url, init) => {
    const u = String(url)
    const auth = (init && init.headers && (init.headers.Authorization || init.headers.authorization)) || ''
    state.upstreamCalls.push({ url: u, auth })
    if (u.includes('/dsh-whale-newapi/health')) return err(404, { error: 'no' }) // 自检不打真实 GUI
    if (u.includes('/api/status')) {
      return j({ data: { version: 'v1.0.0-rc.40', quota_per_unit: 500000, usd_exchange_rate: 1, display_in_currency: true } })
    }
    if (u.includes('/api/user/self')) {
      return state.plan.userSelf === 200 ? j({ data: { quota: 5000000, used_quota: 1000000, remain_quota: 4000000, unlimited_quota: false } }) : err(state.plan.userSelf, AUTH401)
    }
    if (u.includes('/v1/dashboard/billing/subscription')) {
      return state.plan.billing === 200 ? j({ hard_limit_usd: 100, soft_limit_usd: 100, object: 'billing_subscription' }) : err(state.plan.billing, AUTH401)
    }
    if (u.includes('/v1/dashboard/billing/usage')) {
      return state.plan.billing === 200 ? j({ total_usage: 1834.5636, object: 'list' }) : err(state.plan.billing, AUTH401)
    }
    if (u.includes('/v1/models')) return j({ object: 'list', data: [{ id: 'deepseek-v4.1-flash' }, { id: 'tier-std' }] })
    throw new TypeError(`套件未声明的 URL（视为立即失败，避免掩盖问题）: ${u}`)
  }
  return { state, ctx, fetchImpl }
}

const realFetch = globalThis.fetch
const servers = []
let eHarness = null
let eServer = null
async function start(h, config = {}) {
  globalThis.fetch = h.fetchImpl
  apply(h.ctx, { autoSync: false, authMode: 'auto', credentialRef: REF, ...config })
  const m = await serve(h.state.routes)
  servers.push(m)
  return m
}
async function stop(h, m) {
  await new Promise((r) => m.server.close(r))
  for (const d of h.state.effects) { try { d() } catch { /* 忽略 */ } }
}
async function statusOf(port) {
  const r = await request(port, { url: '/dsh-whale-newapi/status', headers: { host: HOST(port) } })
  return r.status === 200 ? JSON.parse(r.body) : null
}
async function syncWith(port, bearer, body = '{}') {
  return await request(port, {
    method: 'POST', url: '/dsh-whale-newapi/sync',
    headers: { host: HOST(port), authorization: 'Bearer ' + bearer, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    body,
  })
}
async function balanceWith(port, bearer) {
  return await request(port, { url: '/dsh-whale-newapi/balance', headers: { host: HOST(port), authorization: 'Bearer ' + bearer } })
}
const authCalls = (h) => h.state.upstreamCalls.filter((c) => c.url.includes('/api/user/self') || c.url.includes('billing'))
const bearerValues = (calls) => [...new Set(calls.map((c) => c.auth).filter((a) => a !== ''))]

console.log(`真实 fetch 已保存并在套件内替换为上游桩: ${typeof realFetch === 'function'}`)

// ===========================================================================
// b（先跑，建立"成功路径缓存"基线）
// ===========================================================================
await t.group('b 成功路径仍缓存：上游 200 时连续操作 → resolve 不再增加（必须保持绿）', () => {
  let h = null; let m = null
  t.test('b1  上游 200：首次操作后凭据只被解析一次', async () => {
    h = makeHarness({ plan: { userSelf: 200, billing: 200 }, credentialValue: VALUE_A })
    m = await start(h)
    const r = await syncWith(m.port, VALUE_A)
    const st = await statusOf(m.port)
    console.log(`      /sync HTTP ${r.status}；桩 resolve 调用=${h.state.resolveCalls.length}；internal.credentialResolveCalls=${st.internal.credentialResolveCalls}`)
    assertEq(r.status, 200, `/sync 应 200，实际 ${r.status}`)
    assertEq(st.internal.credentialResolveCalls, 1, '凭据应只被解析 1 次（apply 预热或首次操作，二者合计 1）')
  })
  t.test('b2  连续 3 次 /sync（每次都打上游）→ resolve 0 次且都用同一凭据', async () => {
    const before = h.state.resolveCalls.length
    const mark = h.state.upstreamCalls.length
    for (let i = 0; i < 3; i++) {
      const r = await syncWith(m.port, VALUE_A)
      assertEq(r.status, 200, `第 ${i + 1} 次 /sync 应 200，实际 ${r.status}`)
    }
    const delta = h.state.resolveCalls.length - before
    const newAuth = authCalls(h).slice(0, authCalls(h).length)
    const newCalls = h.state.upstreamCalls.slice(mark)
    console.log(`      3 次 /sync：resolve 增量=${delta}（期望 0）；上游请求 ${newCalls.length} 次；凭据集合=${JSON.stringify(bearerValues(newCalls))}`)
    assert(newCalls.length > 0, '3 次 /sync 必须真的打了上游（否则"resolve 0 次"无意义）')
    assertEq(delta, 0, '成功路径上连续操作不得重复 resolve（缓存必须生效）')
    assert(bearerValues(newCalls).every((a) => a === 'Bearer ' + VALUE_A), '成功路径必须一直用同一凭据')
    void newAuth
  })
  t.test('b3  连续 3 次 /balance → resolve 同样 0 次', async () => {
    const before = h.state.resolveCalls.length
    for (let i = 0; i < 3; i++) {
      const r = await balanceWith(m.port, VALUE_A)
      assertEq(r.status, 200, `第 ${i + 1} 次 /balance 应 200，实际 ${r.status}`)
    }
    const st = await statusOf(m.port)
    console.log(`      resolve 增量=${h.state.resolveCalls.length - before}（期望 0）；internal.credentialResolveCalls=${st.internal.credentialResolveCalls} credentialCacheHits=${st.internal.credentialCacheHits}`)
    assertEq(h.state.resolveCalls.length - before, 0, '成功路径上 /balance 不得重复 resolve')
  })
  t.test('清理 b', async () => { await stop(h, m); console.log('      done') })
})

// ===========================================================================
// a + c：真机事故复现
// ===========================================================================
await t.group('a 真机事故复现：值被替换后必须生效（鉴权失败 → 缓存作废）', () => {
  let h = null; let m = null
  t.test('a1  用错值 A 首次操作 → 上游 401 → 插件记录鉴权失败（不崩、形状为 200+ok:false）', async () => {
    h = makeHarness({ plan: { userSelf: 401, billing: 401 }, credentialValue: VALUE_A })
    m = await start(h)
    const r = await syncWith(m.port, VALUE_A)
    assertEq(r.status, 200, `/sync 应 200（错误形状是 200 + ok:false），实际 ${r.status}`)
    const body = JSON.parse(r.body)
    const auth = authCalls(h)
    console.log(`      /sync HTTP ${r.status} ok=${body.ok} balance.ok=${body.balance && body.balance.ok} code=${body.balance && body.balance.code}`)
    console.log(`      上游鉴权请求 ${auth.length} 次，全部 401（桩设定）；报告 httpStatus=${JSON.stringify(auth.map((c) => c.status))}`)
    assert(auth.length > 0, '应当向上游发出鉴权请求')
  })
  t.test('a2  【断言 c】internal 出现可观察的作废痕迹，且不含凭据明文', async () => {
    const st = await statusOf(m.port)
    const i = st.internal
    console.log(`      credentialResolveCalls=${i.credentialResolveCalls} credentialCacheHits=${i.credentialCacheHits}`)
    console.log(`      credentialInvalidations=${i.credentialInvalidations} credentialCacheInvalidatedAt=${i.credentialCacheInvalidatedAt}`)
    assert(i.credentialInvalidations !== undefined, 'internal 必须有 credentialInvalidations（core 实现字段名）')
    assert(i.credentialInvalidations >= 1, `鉴权失败后 credentialInvalidations 应 ≥1，实际 ${i.credentialInvalidations}`)
    assert(Number.isFinite(i.credentialCacheInvalidatedAt), `credentialCacheInvalidatedAt 应是时间戳，实际 ${i.credentialCacheInvalidatedAt}`)
    assertNotIncludes(JSON.stringify(i), VALUE_A, 'internal 不得泄漏凭据明文')
  })
  t.test('a3  【断言 a】用户改成 B 后，下一次 /sync 必须用 B（同一次操作即生效，不延迟）', async () => {
    h.state.credentialValue = VALUE_B
    const mark = h.state.upstreamCalls.length
    const r = await syncWith(m.port, VALUE_B)
    console.log(`      POST /sync  Bearer=<B> → HTTP ${r.status}`)
    assert(r.status !== 401, `改成 B 后 /sync 不应再 401（旧代码会因缓存里还是 A 而 401），实际 ${r.status}`)
    const seen = bearerValues(h.state.upstreamCalls.slice(mark))
    console.log(`      改值后上游收到的凭据=${JSON.stringify(seen.map((a) => a.replace(/^Bearer\s+/, '').slice(0, 14) + '…'))}`)
    assert(seen.length > 0, '改值后应向上游发出带凭据的请求')
    assert(seen.every((a) => a === 'Bearer ' + VALUE_B), `上游收到的凭据必须全是 B，实际 ${JSON.stringify(seen)}`)
    assert(!seen.some((a) => a === 'Bearer ' + VALUE_A), '不得再用旧值 A 打上游')
  })
  t.test('a4  /status.credential 仍是同一 ref 名（值变了、ref 不变）', async () => {
    const st = await statusOf(m.port)
    console.log(`      /status.credential=${JSON.stringify(st.credential)}`)
    assertEq(st.credential.ref, REF, '/status.credential.ref 必须仍是配置里的 ref')
    assertEq(st.credential.present, true, '凭据应当仍然 present')
  })
  t.test('a5  鉴权仍失败期间：每次操作都应重新解析（保证下一次改值立即生效）', async () => {
    const before = h.state.resolveCalls.length
    await syncWith(m.port, VALUE_B)
    await syncWith(m.port, VALUE_B)
    const delta = h.state.resolveCalls.length - before
    const st = await statusOf(m.port)
    console.log(`      上游仍 401：2 次 /sync 的 resolve 增量=${delta}（期望 ≥2）；credentialInvalidations=${st.internal.credentialInvalidations}`)
    assert(delta >= 2, `鉴权持续失败时每次操作都必须重新解析，实际增量 ${delta}`)
  })
  t.test('a6  鉴权恢复 200 后：缓存重建（2 次操作 → resolve 0 次），且始终用 B', async () => {
    h.state.plan = { userSelf: 200, billing: 200 }
    h.state.credentialValue = VALUE_B
    await syncWith(m.port, VALUE_B) // 这一轮把 B 的缓存重新建立起来
    const before = h.state.resolveCalls.length
    const mark = h.state.upstreamCalls.length
    await syncWith(m.port, VALUE_B)
    await balanceWith(m.port, VALUE_B)
    const delta = h.state.resolveCalls.length - before
    const seen = bearerValues(h.state.upstreamCalls.slice(mark))
    console.log(`      恢复 200 后：2 次操作 resolve 增量=${delta}（期望 0）；凭据集合=${JSON.stringify(seen)}`)
    assertEq(delta, 0, '鉴权恢复后应重新进入缓存状态，不得每次重解析')
    assert(seen.every((a) => a === 'Bearer ' + VALUE_B), '恢复后仍必须用 B，旧值 A 不得复活')
  })
  t.test('清理 a', async () => { await stop(h, m); console.log('      done') })
})

// ===========================================================================
// 反向：非鉴权失败不得作废
// ===========================================================================
await t.group('反向：非鉴权失败（500）不得被误判为凭据失效', () => {
  let h = null; let m = null
  t.test('上游 500 时：缓存不得被作废，也不得每次重解析', async () => {
    h = makeHarness({ plan: { userSelf: 500, billing: 500 }, credentialValue: VALUE_A })
    m = await start(h)
    await syncWith(m.port, VALUE_A)
    const st1 = await statusOf(m.port)
    const before = h.state.resolveCalls.length
    await syncWith(m.port, VALUE_A)
    await syncWith(m.port, VALUE_A)
    const st2 = await statusOf(m.port)
    const delta = h.state.resolveCalls.length - before
    console.log(`      500 场景：credentialInvalidations ${st1.internal.credentialInvalidations} → ${st2.internal.credentialInvalidations}（期望 0 → 0）`)
    console.log(`      后续 2 次操作 resolve 增量=${delta}（期望 0：500 不该让缓存失效）`)
    assertEq(st2.internal.credentialInvalidations, 0, '500（非鉴权失败）不得作废凭据缓存')
    assertEq(delta, 0, '500 场景下不得每次重解析')
  })
  t.test('清理反向用例', async () => { await stop(h, m); console.log('      done') })
})

// ===========================================================================
// d：对抗性边界（core 建议）
// ===========================================================================
await t.group('d 对抗性边界：单模式/混合/部分失败/无凭据', () => {
  t.test('d1  authMode=native 单模式 401 → 必须作废', async () => {
    const h = makeHarness({ plan: { userSelf: 401, billing: 401 }, credentialValue: VALUE_A })
    const m = await start(h, { authMode: 'native' })
    try {
      await syncWith(m.port, VALUE_A)
      const st = await statusOf(m.port)
      console.log(`      authMode=native 全 401 → credentialInvalidations=${st.internal.credentialInvalidations}`)
      assert(st.internal.credentialInvalidations >= 1, 'native 单模式 401 也必须作废缓存')
    } finally { await stop(h, m) }
  })
  t.test('d2  401 与 403 混合 → 仍必须作废', async () => {
    const h = makeHarness({ plan: { userSelf: 401, billing: 403 }, credentialValue: VALUE_A })
    const m = await start(h)
    try {
      await syncWith(m.port, VALUE_A)
      const st = await statusOf(m.port)
      console.log(`      native=401 + compat=403 → credentialInvalidations=${st.internal.credentialInvalidations}`)
      assert(st.internal.credentialInvalidations >= 1, '401/403 混合也必须作废缓存')
    } finally { await stop(h, m) }
  })
  t.test('d3  部分失败（native 401 但 compat 成功）→ 不得作废缓存', async () => {
    // 用 sk- 开头的值：compat 优先，立刻成功 → chosen !== null → 不得作废。
    const h = makeHarness({ plan: { userSelf: 401, billing: 200 }, credentialValue: VALUE_SK })
    const m = await start(h)
    try {
      await syncWith(m.port, VALUE_SK)
      const st1 = await statusOf(m.port)
      const before = h.state.resolveCalls.length
      await syncWith(m.port, VALUE_SK)
      const st2 = await statusOf(m.port)
      const delta = h.state.resolveCalls.length - before
      console.log(`      compat 成功（source=${st2.balance && st2.balance.source}）→ credentialInvalidations=${st2.internal.credentialInvalidations}（期望 0）；resolve 增量=${delta}（期望 0）`)
      assertEq(st2.balance && st2.balance.source, 'compat', '该场景应走通 compat')
      assertEq(st2.internal.credentialInvalidations, 0, '部分失败（有成功路径）不得作废缓存')
      assertEq(delta, 0, '部分失败场景下缓存应继续生效')
      void st1
    } finally { await stop(h, m) }
  })
  t.test('d4  无凭据（NO_CREDENTIAL）不得被误判为鉴权失败', async () => {
    const h = makeHarness({ plan: { userSelf: 401, billing: 401 }, credentialValue: null })
    const m = await start(h)
    try {
      const r = await syncWith(m.port, VALUE_A) // 无凭据时路由鉴权会 401，但插件不得把"没凭据"当"凭据失效"
      const st = await statusOf(m.port)
      console.log(`      /sync HTTP ${r.status}（无凭据时路由应 401）；/status.credential=${JSON.stringify(st.credential)}`)
      console.log(`      credentialInvalidations=${st.internal.credentialInvalidations}（期望 0）`)
      assertEq(st.credential.present, false, '无凭据时 credential.present 应为 false')
      assertEq(st.internal.credentialInvalidations, 0, 'NO_CREDENTIAL 不得被当作鉴权失败而作废缓存')
      // 之后用户把值填上：下一次操作必须能拿到它（同一次操作即生效）
      h.state.credentialValue = VALUE_B
      const mark = h.state.upstreamCalls.length
      const r2 = await syncWith(m.port, VALUE_B)
      const seen = bearerValues(h.state.upstreamCalls.slice(mark))
      console.log(`      填入 B 后：/sync HTTP ${r2.status}；上游收到=${JSON.stringify(seen)}`)
      assert(r2.status === 200, `填入凭据后 /sync 应 200，实际 ${r2.status}`)
      assert(seen.every((a) => a === 'Bearer ' + VALUE_B), '填入凭据后必须立刻用它')
    } finally { await stop(h, m) }
  })
  t.test('d5  作废后必须能在**同一次**后续操作里用上新值（不出现"两个操作后才生效"）', async () => {
    const h = makeHarness({ plan: { userSelf: 401, billing: 401 }, credentialValue: VALUE_A })
    const m = await start(h)
    try {
      await syncWith(m.port, VALUE_A)          // 建立错值缓存 + 触发作废
      h.state.credentialValue = VALUE_B
      h.state.plan = { userSelf: 200, billing: 200 }
      const mark = h.state.upstreamCalls.length
      const r = await syncWith(m.port, VALUE_B) // 第一次后续操作就必须用 B
      const seen = bearerValues(h.state.upstreamCalls.slice(mark))
      const st = await statusOf(m.port)
      console.log(`      改值后第 1 次操作：HTTP ${r.status}；上游收到=${JSON.stringify(seen)}；balance.source=${st.balance && st.balance.source}`)
      assertEq(r.status, 200, `第一次后续操作就应成功，实际 ${r.status}`)
      assert(seen.length > 0 && seen.every((a) => a === 'Bearer ' + VALUE_B), `第一次后续操作就必须用 B，实际 ${JSON.stringify(seen)}`)
    } finally { await stop(h, m) }
  })
})

// ===========================================================================
// e：warnings 陈旧残留（lead 提出的疑点裁定）
//    真机现象：一次**完全成功**的同步之后，/status.warnings 里仍留着
//    `上游取数失败（HTTP_401）：… Unauthorized, invalid access token；本次不改写注册表`。
//    源码依据：
//      · L396 pushWarning 只做去重 + 封顶（>50 时 shift），**成功时从不清空**；
//      · L1014 每轮同步都把自己的 result.warnings（含 L868 的 `上游取数失败`）推进持久 warnings；
//      · L644 是 task-9 的**另一条**措辞（「上游鉴权失败（所有 authMode 均 HTTP_401/403）：已作废凭据缓存」）。
//    本组用「先失败一轮、再成功一轮」做决定性实验：若成功后仍在，即为①陈旧残留（会误导排障）。
// ===========================================================================
await t.group('e warnings 陈旧残留：失败一轮后成功，失败文案是否还在', () => {
  t.test('e1  对照组：从开始就成功 → warnings 不得出现「上游取数失败」', async () => {
    const h = makeHarness({ plan: { userSelf: 200, billing: 200 }, credentialValue: VALUE_A })
    const m = await start(h)
    try {
      await syncWith(m.port, VALUE_A)
      const st = await statusOf(m.port)
      const hits = st.warnings.filter((w) => w.includes('上游取数失败'))
      console.log(`      成功路径 warnings（${st.warnings.length} 条）中含「上游取数失败」的条数=${hits.length}（期望 0）`)
      st.warnings.forEach((w, i) => console.log(`        [${i}] ${w.slice(0, 150)}`))
      assertEq(hits.length, 0, '成功周期不得产生「上游取数失败」warning')
    } finally { await stop(h, m) }
  })
  t.test('e2  失败一轮 → /status.warnings 出现「上游取数失败（HTTP_401）」与 models 兜底提示', async () => {
    // 这个实例跨 e2/e3 复用
    eHarness = makeHarness({ plan: { userSelf: 401, billing: 401 }, credentialValue: VALUE_A })
    eServer = await start(eHarness)
    const r = await syncWith(eServer.port, VALUE_A)
    const body = JSON.parse(r.body)
    const st = await statusOf(eServer.port)
    console.log(`      /sync HTTP ${r.status} ok=${body.ok}；该次响应的 warnings：`)
    ;(body.warnings || []).forEach((w, i) => console.log(`        [resp ${i}] ${w.slice(0, 160)}`))
    console.log(`      /status.warnings（${st.warnings.length} 条）：`)
    st.warnings.forEach((w, i) => console.log(`        [${i}] ${w.slice(0, 160)}`))
    const fail = st.warnings.filter((w) => w.includes('上游取数失败'))
    assert(fail.length >= 1, '失败周期应把「上游取数失败（HTTP_401）」写进持久 warnings（L1014 收集 L868）')
    assert(fail.some((w) => w.includes('HTTP_401')), '文案应含 HTTP_401')
  })
  t.test('e3  【决定性实验】随后一轮完全成功（balance.ok=true, usedMode=native）→ 陈旧失败文案是否仍在', async () => {
    eHarness.state.plan = { userSelf: 200, billing: 200 }
    eHarness.state.credentialValue = VALUE_B
    const r = await syncWith(eServer.port, VALUE_B)
    const body = JSON.parse(r.body)
    const st = await statusOf(eServer.port)
    console.log(`      成功轮：/sync HTTP ${r.status} ok=${body.ok} balance.ok=${body.balance.ok} mode=${body.balance.source}`)
    console.log(`      成功轮的 upstream.auth.usedMode=${st.upstream.auth.usedMode} attempts=${JSON.stringify(st.upstream.auth.attempts)}`)
    console.log(`      成功轮 /status.warnings（${st.warnings.length} 条）：`)
    st.warnings.forEach((w, i) => console.log(`        [${i}] ${w.slice(0, 170)}`))
    const stale = st.warnings.filter((w) => w.includes('上游取数失败'))
    const taskNine = st.warnings.filter((w) => w.includes('已作废凭据缓存'))
    console.log(`      ⇒ 成功周期后：陈旧「上游取数失败」=${stale.length} 条；task-9「已作废凭据缓存」=${taskNine.length} 条`)
    console.log('      [裁定依据] 若成功周期里仍能读到「上游取数失败」，且它并非本周期重试产生（本周期 upstream 全成功），')
    console.log('        则为 **① 累积型陈旧残留**（warnings 只在成功时从不清空），不是②有意记录。')
    assertEq(st.balance.ok, true, '本轮必须真的成功')
    assertEq(st.internal.credentialInvalidations >= 1, true, '失败轮应已作废过一次缓存')
    // 这条断言固定"缺陷现象本身"：成功后陈旧文案仍在（判定为缺陷，修法由 lead/core 决定，我不改实现）
    assert(stale.length >= 1, '复现缺陷：成功周期后 /status.warnings 仍残留陈旧的「上游取数失败」')
  })
  t.test('e4  task-9 自己的措辞与陈旧文案可区分（两条不同文本）', async () => {
    const st = await statusOf(eServer.port)
    const taskNine = st.warnings.filter((w) => w.includes('已作废凭据缓存'))
    console.log(`      task-9 警告条数=${taskNine.length}`)
    taskNine.forEach((w, i) => console.log(`        [${i}] ${w.slice(0, 200)}`))
    const stale = st.warnings.filter((w) => w.includes('上游取数失败'))
    if (taskNine.length === 0) {
      console.log('      [说明] 本实例未出现 task-9 措辞（该措辞只在「整体鉴权失败」的 refreshBalance 路径 push；')
      console.log('        若该次 401 走的是 collectUpstream 全失败路径，则由 L868 文案体现）。')
    } else {
      assert(taskNine.every((w) => !w.includes('上游取数失败')), 'task-9 措辞不应与陈旧文案混淆')
    }
    assert(stale.length >= 1, '陈旧文案仍在（e3 已复现）')
  })
  t.test('清理 e', async () => { await stop(eHarness, eServer); console.log('      done') })
})

// ===========================================================================
// 守卫
// ===========================================================================
await t.group('守卫', () => {
  t.test('真实 .dshw-api.json 未被本套件改动（只读守卫）', () => {
    if (!REAL_GUARD) { console.log('      [跳过] 真实注册表不存在'); return }
    const now = sha256(fs.readFileSync(WHALE_REGISTRY_REAL))
    console.log(`      基线=${REAL_GUARD.sha256.slice(0, 16)}…  现在=${now.slice(0, 16)}…  一致=${now === REAL_GUARD.sha256}`)
    console.log('      （小鲸鱼宿主会周期性回写 usage；本断言在单次运行窗口内有效）')
    assertEq(now, REAL_GUARD.sha256, '真实注册表不得被本套件改动')
  })
  t.test('本套件的写入都发生在隔离 $DSH_HOME 内', () => {
    console.log(`      隔离 home=${ISOLATED_HOME}；隔离注册表已被插件写入=${fs.existsSync(ISO_REGISTRY)}`)
    assert(ISOLATED_HOME.startsWith(os.tmpdir()), '隔离目录必须在 %TEMP% 下')
  })
})

globalThis.fetch = realFetch
for (const s of servers) { try { await new Promise((r) => s.server.close(r)) } catch { /* 忽略 */ } }
await t.finish()
console.log(`\n真实注册表最终校验: ${REAL_GUARD ? (sha256(fs.readFileSync(WHALE_REGISTRY_REAL)) === REAL_GUARD.sha256 ? '未变 ✓' : '已变 ✗（可能是宿主回写 usage）') : '不适用'}`)
