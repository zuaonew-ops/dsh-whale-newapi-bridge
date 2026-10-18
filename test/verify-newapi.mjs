// verify-newapi.mjs —— 独立验证 lib/newapi.mjs（SPEC §5.1 / §5.1.1）。
// 全部离线：网络函数一律注入 fetchImpl 桩，纯函数直接喂 JSON。
// 判定标准 = SPEC.md，不采信实现者说法。
import path from 'node:path'
import {
  createRunner, assert, assertEq, assertDeepEq, assertFiniteNumber, assertIncludes, assertRejects,
  need, needFn, loadFixture, jsonResponse, textResponse, makeFetchStub, mask,
  readCredentialValue, PKG_DIR,
} from './verify-helpers.mjs'

const MOD = path.join(PKG_DIR, 'lib', 'newapi.mjs')
const t = createRunner('verify-newapi.mjs —— lib/newapi.mjs 离线单测（SPEC §5.1）')

let mod = null
let loadError = null
try {
  mod = await import('file://' + MOD.replace(/\\/g, '/'))
} catch (err) {
  loadError = err
}

console.log(`模块: ${MOD}`)
if (loadError) {
  console.log(`\n!! 无法加载模块（实现未就绪或语法错误），本套件无法验证：\n${loadError.stack || loadError}`)
  console.log('SUMMARY: BLOCKED（实现文件缺失/不可加载）')
  process.exitCode = 2
} else {
  const F = {
    normalizeBaseUrl: needFn(mod, 'normalizeBaseUrl', 'newapi'),
    parseRelayStatus: needFn(mod, 'parseRelayStatus', 'newapi'),
    fetchRelayStatus: needFn(mod, 'fetchRelayStatus', 'newapi'),
    fetchNativeUser: needFn(mod, 'fetchNativeUser', 'newapi'),
    fetchCompat: needFn(mod, 'fetchCompat', 'newapi'),
    normalizeBalance: needFn(mod, 'normalizeBalance', 'newapi'),
  }
  const DEFAULT_BASE_URL = need(mod, 'DEFAULT_BASE_URL', 'newapi')
  const UNLIMITED_SENTINEL = need(mod, 'UNLIMITED_SENTINEL', 'newapi')

  const BASE = DEFAULT_BASE_URL
  const statusJson = {
    data: {
      version: 'v1.0.0-rc.40', system_name: 'New API',
      quota_per_unit: 500000, usd_exchange_rate: 7.3, price: 7.3,
      display_in_currency: true, quota_display_type: 'CUSTOM',
      custom_currency_symbol: 'credits', custom_currency_exchange_rate: 1,
    },
  }
  const subscriptionJson = { object: 'billing_subscription', hard_limit_usd: 100000000, soft_limit_usd: 100000000, system_hard_limit_usd: 100000000 }
  const usageJson = { object: 'list', total_usage: 1834.5636 }
  // 有限额度样本（用 SPEC §1 的真实结构，硬限额改为有限值）
  const finiteSubscriptionJson = { object: 'billing_subscription', hard_limit_usd: 20, soft_limit_usd: 20, system_hard_limit_usd: 20 }
  const userSelfJson = {
    success: true, message: '',
    data: { id: 1, username: 'tester', quota: 2500000, used_quota: 500000, unlimited_quota: false, group: 'default' },
  }
  const userSelfUnlimitedJson = {
    success: true,
    data: { id: 1, username: 'tester', quota: 0, used_quota: 0, unlimited_quota: true, group: 'vip' },
  }
  const baseCfg = { currency: 'USD', usdToCny: 0, quotaPerUnit: 500000, fallbackTotal: 0, modelId: 'newapi_relay' }

  // ---------- §5.1 导出与常量 ----------
  await t.group('SPEC §5.1 导出与常量', () => {
    t.test('DEFAULT_BASE_URL === http://127.0.0.1:3000', () => assertEq(DEFAULT_BASE_URL, 'http://127.0.0.1:3000', 'DEFAULT_BASE_URL'))
    t.test('UNLIMITED_SENTINEL === 100000000', () => assertEq(UNLIMITED_SENTINEL, 100000000, 'UNLIMITED_SENTINEL'))
    t.test('全部 7 个导出存在且类型正确', () => {
      for (const [k, v] of Object.entries(F)) assertEq(typeof v, 'function', `${k} 应为函数`)
    })
  })

  // ---------- normalizeBaseUrl ----------
  await t.group('normalizeBaseUrl', () => {
    t.test('去尾斜杠', () => assertEq(F.normalizeBaseUrl('http://a.b:10072/'), 'http://a.b:10072', '去尾斜杠'))
    t.test('多重尾斜杠也去掉', () => assertEq(F.normalizeBaseUrl('https://a.b///'), 'https://a.b', '多斜杠'))
    t.test('无尾斜杠保持不变', () => assertEq(F.normalizeBaseUrl('http://127.0.0.1:3000'), 'http://127.0.0.1:3000', '原样'))
    t.test('非法 → 抛 Error', async () => {
      await assertRejects(() => F.normalizeBaseUrl('not a url'), 'normalizeBaseUrl(非法)')
      await assertRejects(() => F.normalizeBaseUrl(''), 'normalizeBaseUrl(空)')
    })
    t.test('非 http/https 协议 → 抛 Error（SPEC §7.3）', async () => {
      await assertRejects(() => F.normalizeBaseUrl('ftp://a.b'), 'ftp 协议')
      await assertRejects(() => F.normalizeBaseUrl('file:///etc/passwd'), 'file 协议')
    })
    t.test('带 userinfo 的 URL → 抛 Error（SPEC §7.3）', async () => {
      await assertRejects(() => F.normalizeBaseUrl('http://user:pass@a.b'), 'userinfo')
    })
  })

  // ---------- parseRelayStatus ----------
  await t.group('parseRelayStatus（SPEC §1 真实 /api/status 形状）', () => {
    t.test('真实形状关键字段全部解出', () => {
      const r = F.parseRelayStatus(statusJson)
      assertEq(r.ok, true, 'ok')
      assertEq(r.quotaPerUnit, 500000, 'quotaPerUnit')
      assertEq(r.usdExchangeRate, 7.3, 'usdExchangeRate')
      assertEq(r.displayInCurrency, true, 'displayInCurrency')
      assertEq(r.quotaDisplayType, 'CUSTOM', 'quotaDisplayType')
      assertEq(r.customCurrencySymbol, 'credits', 'customCurrencySymbol')
      assertEq(r.customCurrencyExchangeRate, 1, 'customCurrencyExchangeRate')
      assertIncludes(String(r.systemName), 'New API', 'systemName')
    })
    t.test('空/坏输入 → ok:false（不抛）', () => {
      for (const bad of [null, undefined, 0, 'x', {}, { data: null }]) {
        const r = F.parseRelayStatus(bad)
        assertEq(r.ok, false, `parseRelayStatus(${JSON.stringify(bad)}).ok`)
        assert(typeof r.error === 'string' && r.error.length > 0, 'parseRelayStatus 失败时必须给 error')
      }
    })
  })

  // ---------- fetchRelayStatus ----------
  await t.group('fetchRelayStatus（注入 fetchImpl）', () => {
    t.test('200 正常 → { ok:true, status }', async () => {
      const stub = makeFetchStub([{ match: '/api/status', response: jsonResponse(statusJson) }])
      const r = await F.fetchRelayStatus(BASE, { fetchImpl: stub, timeoutMs: 1000 })
      assertEq(r.ok, true, 'ok')
      assertEq(r.status.quotaPerUnit, 500000, 'status.quotaPerUnit')
      assertEq(stub.calls.length, 1, '只应请求一次')
      assertIncludes(stub.calls[0].url, '/api/status', '请求路径')
    })
    t.test('404 → code HTTP_404 且带 httpStatus', async () => {
      const stub = makeFetchStub([{ match: '/api/status', response: jsonResponse({ message: 'not found' }, 404) }])
      const r = await F.fetchRelayStatus(BASE, { fetchImpl: stub })
      assertEq(r.ok, false, 'ok')
      assertEq(r.code, 'HTTP_404', 'code')
      assertEq(r.httpStatus, 404, 'httpStatus')
    })
    t.test('500 → code HTTP_ERROR', async () => {
      const stub = makeFetchStub([{ match: '/api/status', response: jsonResponse({}, 500) }])
      const r = await F.fetchRelayStatus(BASE, { fetchImpl: stub })
      assertEq(r.code, 'HTTP_ERROR', 'code')
      assertEq(r.httpStatus, 500, 'httpStatus')
    })
    t.test('超时 → code TIMEOUT', async () => {
      const stub = makeFetchStub([{ match: '/api/status', hang: true }])
      const r = await F.fetchRelayStatus(BASE, { fetchImpl: stub, timeoutMs: 30 })
      assertEq(r.code, 'TIMEOUT', 'code')
      assertEq(r.ok, false, 'ok')
    })
    t.test('网络异常 → code NETWORK', async () => {
      const stub = makeFetchStub([{ match: '/api/status', throw: new TypeError('fetch failed') }])
      const r = await F.fetchRelayStatus(BASE, { fetchImpl: stub })
      assertEq(r.code, 'NETWORK', 'code')
    })
    t.test('非 JSON 响应 → code NON_JSON', async () => {
      const stub = makeFetchStub([{ match: '/api/status', response: textResponse('<html>oops</html>') }])
      const r = await F.fetchRelayStatus(BASE, { fetchImpl: stub })
      assertEq(r.code, 'NON_JSON', 'code')
    })
    t.test('错误消息不含凭据明文', async () => {
      const secret = readCredentialValue('PI_API_KEY')
      const stub = makeFetchStub([{ match: '/api/status', response: jsonResponse({ message: 'bad' }, 500) }])
      const r = await F.fetchRelayStatus(BASE, { fetchImpl: stub })
      if (secret) assert(r.error === undefined || !String(r.error).includes(secret), '错误里不得含真实凭据')
    })
  })

  // ---------- fetchNativeUser ----------
  await t.group('fetchNativeUser（SPEC §5.1：先带 New-Api-User，401/无 userId 再试不带）', () => {
    t.test('带 userId 且成功 → withUserHeader true，且请求头含 New-Api-User', async () => {
      const stub = makeFetchStub([{ match: '/api/user/self', response: jsonResponse(userSelfJson) }])
      const r = await F.fetchNativeUser(BASE, { token: 'tok-123', userId: '7', fetchImpl: stub })
      assertEq(r.ok, true, 'ok')
      assertEq(r.withUserHeader, true, 'withUserHeader')
      assertEq(r.httpStatus, 200, 'httpStatus')
      // SPEC §5.1 只要求返回 user；实现做了字段白名单（丢弃 id/username，属脱敏向取舍）。
      // 这里断言“余额判定所需的字段必须原样保留”，而不是全等。
      for (const k of ['quota', 'used_quota', 'unlimited_quota']) {
        assertEq(r.user[k], userSelfJson.data[k], `user.${k} 必须原样保留`)
      }
      assert('remain_quota' in r.user, 'user.remain_quota 必须存在（可为 null）')
      if (r.user.id === undefined) console.log('      [说明] 实现丢弃了 user.id/username（SPEC §5.1 未要求，属脱敏取舍）')
      const h = stub.calls[0].init && stub.calls[0].init.headers
      const auth = h && (h.Authorization || h.authorization)
      assertEq(auth, 'Bearer tok-123', 'Authorization 头')
      const uid = h && (h['New-Api-User'] || h['new-api-user'])
      assertEq(String(uid), '7', 'New-Api-User 头')
    })
    t.test('带 userId 被 401 → 自动回退不带该头并成功', async () => {
      const stub = makeFetchStub([
        { match: '/api/user/self', response: (c) => {
          const h = (c.init && c.init.headers) || {}
          const hasUid = h['New-Api-User'] || h['new-api-user']
          return hasUid ? jsonResponse({ message: 'unauthorized' }, 401) : jsonResponse(userSelfJson)
        } },
      ])
      const r = await F.fetchNativeUser(BASE, { token: 'tok-123', userId: '7', fetchImpl: stub })
      assertEq(r.ok, true, 'ok（应回退成功）')
      assertEq(r.withUserHeader, false, 'withUserHeader 应为 false')
      assertEq(stub.calls.length, 2, '应请求两次')
    })
    t.test('未给 userId → 直接不带该头', async () => {
      const stub = makeFetchStub([{ match: '/api/user/self', response: jsonResponse(userSelfJson) }])
      const r = await F.fetchNativeUser(BASE, { token: 'tok-123', fetchImpl: stub })
      assertEq(r.ok, true, 'ok')
      const h = stub.calls[0].init && stub.calls[0].init.headers
      assert(!(h && (h['New-Api-User'] || h['new-api-user'])), '不该带 New-Api-User')
    })
    t.test('sk- key 打 /api/user/self → 401（SPEC §1 已实测现象）', async () => {
      const stub = makeFetchStub([{ match: '/api/user/self', response: jsonResponse({ success: false, message: '无权进行此操作' }, 401) }])
      const r = await F.fetchNativeUser(BASE, { token: 'sk-fake', userId: '7', fetchImpl: stub })
      assertEq(r.ok, false, 'ok')
      assertEq(r.code, 'HTTP_401', 'code')
    })
    t.test('缺 token → NO_CREDENTIAL（不得发请求）', async () => {
      const stub = makeFetchStub([])
      const r = await F.fetchNativeUser(BASE, { token: '', fetchImpl: stub })
      assertEq(r.ok, false, 'ok')
      assertEq(r.code, 'NO_CREDENTIAL', 'code')
      assertEq(stub.calls.length, 0, '不该发请求')
    })
    t.test('403 → HTTP_403', async () => {
      const stub = makeFetchStub([{ match: '/api/user/self', response: jsonResponse({}, 403) }])
      const r = await F.fetchNativeUser(BASE, { token: 'tok', fetchImpl: stub })
      assertEq(r.code, 'HTTP_403', 'code')
    })
    t.test('超时 → TIMEOUT / 网络异常 → NETWORK / 非 JSON → NON_JSON', async () => {
      const c1 = await F.fetchNativeUser(BASE, { token: 't', fetchImpl: makeFetchStub([{ match: '/api', hang: true }]), timeoutMs: 30 })
      assertEq(c1.code, 'TIMEOUT', 'TIMEOUT')
      const c2 = await F.fetchNativeUser(BASE, { token: 't', fetchImpl: makeFetchStub([{ match: '/api', throw: new TypeError('fetch failed') }]) })
      assertEq(c2.code, 'NETWORK', 'NETWORK')
      const c3 = await F.fetchNativeUser(BASE, { token: 't', fetchImpl: makeFetchStub([{ match: '/api', response: textResponse('<html>') }]) })
      assertEq(c3.code, 'NON_JSON', 'NON_JSON')
    })
  })

  // ---------- fetchCompat ----------
  await t.group('fetchCompat（subscription + usage；usage 失败不致命）', () => {
    t.test('真实样本：hardLimitUsd=1e8，usedUsd=total_usage/100', async () => {
      const stub = makeFetchStub([
        { match: '/v1/dashboard/billing/subscription', response: jsonResponse(subscriptionJson) },
        { match: '/v1/dashboard/billing/usage', response: jsonResponse(usageJson) },
      ])
      const r = await F.fetchCompat(BASE, { apiKey: 'sk-fake', fetchImpl: stub })
      assertEq(r.ok, true, 'ok')
      assertEq(r.hardLimitUsd, 100000000, 'hardLimitUsd')
      assertEq(r.usedCents, 1834.5636, 'usedCents')
      assert(Math.abs(r.usedUsd - 18.345636) < 1e-9, `usedUsd 应=total_usage/100，实际 ${r.usedUsd}`)
      assertIncludes(stub.calls[0].url, '/v1/dashboard/billing/subscription', '第一个请求应是 subscription')
      const auth = stub.calls[0].init.headers.Authorization || stub.calls[0].init.headers.authorization
      assertEq(auth, 'Bearer sk-fake', 'Authorization 头')
      assertIncludes(stub.calls[1].url, 'start_date', 'usage 应带 start_date')
      assertIncludes(stub.calls[1].url, 'end_date', 'usage 应带 end_date')
    })
    t.test('usage 返回 500 → 仍 ok:true，usedCents 归零/未定义但 hardLimitUsd 可用', async () => {
      const stub = makeFetchStub([
        { match: 'subscription', response: jsonResponse(subscriptionJson) },
        { match: 'usage', response: jsonResponse({}, 500) },
      ])
      const r = await F.fetchCompat(BASE, { apiKey: 'sk-fake', fetchImpl: stub })
      assertEq(r.ok, true, 'usage 失败不应致命')
      assertEq(r.hardLimitUsd, 100000000, 'hardLimitUsd 仍可用')
    })
    t.test('subscription 401 → HTTP_401', async () => {
      const stub = makeFetchStub([{ match: 'subscription', response: jsonResponse({}, 401) }])
      const r = await F.fetchCompat(BASE, { apiKey: 'sk-bad', fetchImpl: stub })
      assertEq(r.ok, false, 'ok')
      assertEq(r.code, 'HTTP_401', 'code')
      assertEq(r.httpStatus, 401, 'httpStatus')
    })
    t.test('缺 apiKey → NO_CREDENTIAL（不得发请求）', async () => {
      const stub = makeFetchStub([])
      const r = await F.fetchCompat(BASE, { apiKey: '', fetchImpl: stub })
      assertEq(r.code, 'NO_CREDENTIAL', 'code')
      assertEq(stub.calls.length, 0, '不该发请求')
    })
    t.test('超时 → TIMEOUT / 非 JSON → NON_JSON', async () => {
      const c1 = await F.fetchCompat(BASE, { apiKey: 'sk', fetchImpl: makeFetchStub([{ match: 'subscription', hang: true }]), timeoutMs: 30 })
      assertEq(c1.code, 'TIMEOUT', 'TIMEOUT')
      const c2 = await F.fetchCompat(BASE, { apiKey: 'sk', fetchImpl: makeFetchStub([{ match: 'subscription', response: textResponse('x') }]) })
      assertEq(c2.code, 'NON_JSON', 'NON_JSON')
    })
  })

  // ---------- normalizeBalance：native 分支 ----------
  await t.group('normalizeBalance —— native 有限额度（SPEC §5.1.1 规则 1）', () => {
    t.test('credits = quota/quotaPerUnit × usdToCny；USD 口径', () => {
      const r = F.normalizeBalance({
        mode: 'native',
        native: { ok: true, user: userSelfJson.data, httpStatus: 200 },
        status: F.parseRelayStatus(statusJson),
        config: { ...baseCfg, currency: 'USD' },
      })
      assertEq(r.ok, true, 'ok')
      assertEq(r.source, 'native', 'source')
      assertEq(r.unlimited, false, 'unlimited')
      assertEq(r.currency, 'USD', 'currency')
      // quota=2500000 / 500000 = 5 USD
      assertEq(r.credits, 2500000, 'credits')
      assertEq(r.remaining, 5, 'remaining')
      // used_quota=500000/500000 = 1
      assertEq(r.used, 1, 'used')
      assertEq(r.total, 6, 'total = remaining + used')
      assert(typeof r.fetchedAt === 'number' && r.fetchedAt > 0, 'fetchedAt')
      assert(r.detail && typeof r.detail.note === 'string' && r.detail.note.length > 0, 'detail.note 必须是非空中文说明（SPEC §5.1.1 规则 3）')
    })
    t.test('CNY 口径要乘 usdToCny（7.3）', () => {
      const r = F.normalizeBalance({
        mode: 'native',
        native: { ok: true, user: userSelfJson.data },
        status: F.parseRelayStatus(statusJson),
        config: { ...baseCfg, currency: 'CNY', usdToCny: 7.3 },
      })
      assertEq(r.currency, 'CNY', 'currency')
      assert(Math.abs(r.remaining - 5 * 7.3) < 1e-9, `remaining 应=5×7.3=36.5，实际 ${r.remaining}`)
      assert(Math.abs(r.used - 1 * 7.3) < 1e-9, `used 应=7.3，实际 ${r.used}`)
      assert(Math.abs(r.total - 6 * 7.3) < 1e-9, `total 应=43.8，实际 ${r.total}`)
    })
    t.test('remain_quota 存在时优先于 quota', () => {
      const user = { quota: 999999999, remain_quota: 1000000, used_quota: 500000, unlimited_quota: false }
      const r = F.normalizeBalance({
        mode: 'native', native: { ok: true, user },
        status: F.parseRelayStatus(statusJson), config: { ...baseCfg, currency: 'USD' },
      })
      assertEq(r.credits, 1000000, 'credits 应取 remain_quota')
      assertEq(r.remaining, 2, 'remaining=1000000/500000')
    })
    t.test('usdToCny=0 时从 status.usdExchangeRate 推导（SPEC §4）', () => {
      const r = F.normalizeBalance({
        mode: 'native', native: { ok: true, user: userSelfJson.data },
        status: F.parseRelayStatus(statusJson), config: { ...baseCfg, currency: 'CNY', usdToCny: 0 },
      })
      assert(Math.abs(r.remaining - 5 * 7.3) < 1e-9, `应从 status 推导 7.3，实际 remaining=${r.remaining}`)
    })
    t.test('quotaPerUnit=0 时从 status.quotaPerUnit 推导（SPEC §4）', () => {
      const r = F.normalizeBalance({
        mode: 'native', native: { ok: true, user: userSelfJson.data },
        status: F.parseRelayStatus(statusJson), config: { ...baseCfg, currency: 'USD', quotaPerUnit: 0 },
      })
      assertEq(r.remaining, 5, 'remaining 应=2500000/500000')
    })
  })

  await t.group('normalizeBalance —— native unlimited（SPEC §5.1.1 规则 2/3）', () => {
    t.test('unlimited_quota=true 且无 fallbackTotal → unlimited:true、remaining:null、total:null', () => {
      const r = F.normalizeBalance({
        mode: 'native', native: { ok: true, user: userSelfUnlimitedJson.data },
        status: F.parseRelayStatus(statusJson), config: { ...baseCfg, currency: 'USD', fallbackTotal: 0 },
      })
      assertEq(r.ok, true, 'ok')
      assertEq(r.unlimited, true, 'unlimited')
      assertEq(r.remaining, null, 'remaining')
      assertEq(r.total, null, 'total')
      assertIncludes(r.detail.note, '无限', 'note 必须说明无限额度')
    })
    t.test('unlimited_quota=true 且有 fallbackTotal>0 → remaining = fallbackTotal - used', () => {
      const r = F.normalizeBalance({
        mode: 'native', native: { ok: true, user: userSelfUnlimitedJson.data },
        status: F.parseRelayStatus(statusJson),
        config: { ...baseCfg, currency: 'USD', fallbackTotal: 100 },
      })
      assertEq(r.unlimited, true, 'unlimited 仍为 true')
      // used_quota=0 → used=0 → remaining=100
      assertEq(r.remaining, 100, 'remaining=fallbackTotal-used')
      assertEq(r.total, 100, 'total=fallbackTotal')
    })
  })

  // ---------- normalizeBalance：compat 分支 ----------
  await t.group('normalizeBalance —— compat 正常（SPEC §5.1.1 规则 2）', () => {
    t.test('有限 hard_limit_usd=20：total=20,used=18.345636,remaining=total-used（USD）', () => {
      const r = F.normalizeBalance({
        mode: 'compat',
        compat: { ok: true, hardLimitUsd: 20, usedCents: 1834.5636, usedUsd: 18.345636 },
        status: F.parseRelayStatus(statusJson), config: { ...baseCfg, currency: 'USD' },
      })
      assertEq(r.ok, true, 'ok')
      assertEq(r.source, 'compat', 'source')
      assertEq(r.unlimited, false, 'unlimited')
      assertEq(r.total, 20, 'total')
      assert(Math.abs(r.used - 18.345636) < 1e-9, `used，实际 ${r.used}`)
      assert(Math.abs(r.remaining - (20 - 18.345636)) < 1e-9, `remaining=total-used，实际 ${r.remaining}`)
      assert(Math.abs(r.usedUsd - 18.345636) < 1e-9, 'usedUsd')
      assert(r.detail && typeof r.detail.note === 'string' && r.detail.note.length > 0, 'detail.note 非空')
    })
    t.test('CNY 口径：total/used/remaining 同乘 usdToCny', () => {
      const r = F.normalizeBalance({
        mode: 'compat', compat: { ok: true, hardLimitUsd: 20, usedCents: 1000, usedUsd: 10 },
        status: F.parseRelayStatus(statusJson), config: { ...baseCfg, currency: 'CNY', usdToCny: 7.3 },
      })
      assert(Math.abs(r.total - 146) < 1e-9, `total=20×7.3，实际 ${r.total}`)
      assert(Math.abs(r.used - 73) < 1e-9, `used=10×7.3，实际 ${r.used}`)
      assert(Math.abs(r.remaining - 73) < 1e-9, `remaining=73，实际 ${r.remaining}`)
    })
    t.test('usedCents 缺失（仅给 usedUsd）→ 按 0 处理且不崩（实现将 usedCents 归一为 0）', () => {
      // SPEC §5.1.1 把 compat 的 used 定义为 usedCents/100；fetchCompat 正常路径**总是**返回数值
      // usedCents（usage 失败时归一为 0），所以 usedUsd-only 不是生产路径。这里断言的是
      // “不得抛异常/不得 NaN”，而不是凭空推导 3。
      const r = F.normalizeBalance({
        mode: 'compat', compat: { ok: true, hardLimitUsd: 20, usedUsd: 3 },
        status: F.parseRelayStatus(statusJson), config: { ...baseCfg, currency: 'USD' },
      })
      assertEq(r.ok, true, 'ok')
      assertFiniteNumber(r.used, 'used 必须是有限数值')
      assertEq(r.used, 0, `缺 usedCents 时 used 归一为 0，实际 ${r.used}`)
      assertEq(r.remaining, 20, `remaining=total-used=20，实际 ${r.remaining}`)
    })
    t.test('usedCents=300（美分）→ used=3 USD', () => {
      const r = F.normalizeBalance({
        mode: 'compat', compat: { ok: true, hardLimitUsd: 20, usedCents: 300, usedUsd: 3 },
        status: F.parseRelayStatus(statusJson), config: { ...baseCfg, currency: 'USD' },
      })
      assertEq(r.used, 3, 'used')
      assertEq(r.remaining, 17, 'remaining')
    })
  })

  await t.group('normalizeBalance —— compat 哨兵 hard_limit_usd>=1e8（SPEC §5.1.1 规则 2）', () => {
    t.test('哨兵且 fallbackTotal=0 → unlimited:true、remaining:null、total:null（SPEC 实测 1e8）', () => {
      const r = F.normalizeBalance({
        mode: 'compat', compat: { ok: true, hardLimitUsd: 100000000, usedCents: 1834.5636, usedUsd: 18.345636 },
        status: F.parseRelayStatus(statusJson), config: { ...baseCfg, currency: 'USD', fallbackTotal: 0 },
      })
      assertEq(r.ok, true, 'ok')
      assertEq(r.unlimited, true, 'unlimited 必须为 true（1e8 是无限哨兵）')
      assertEq(r.remaining, null, 'remaining')
      assertEq(r.total, null, 'total')
      assertIncludes(r.detail.note, '无限', 'note 必须说明无限额度')
    })
    t.test('哨兵 + fallbackTotal>0 → remaining=fallbackTotal-used、total=fallbackTotal', () => {
      const r = F.normalizeBalance({
        mode: 'compat', compat: { ok: true, hardLimitUsd: 100000000, usedCents: 1834.5636, usedUsd: 18.345636 },
        status: F.parseRelayStatus(statusJson), config: { ...baseCfg, currency: 'USD', fallbackTotal: 1000 },
      })
      assertEq(r.unlimited, true, 'unlimited')
      assertEq(r.total, 1000, 'total=fallbackTotal')
      assert(Math.abs(r.remaining - (1000 - 18.345636)) < 1e-9, `remaining=fallbackTotal-used，实际 ${r.remaining}`)
      assertFiniteNumber(r.remaining, 'remaining 必须是有限数值')
    })
    t.test('边界：hard_limit_usd = 99999999.99（刚好低于哨兵）→ 不判无限', () => {
      const r = F.normalizeBalance({
        mode: 'compat', compat: { ok: true, hardLimitUsd: 99999999.99, usedCents: 100, usedUsd: 1 },
        status: F.parseRelayStatus(statusJson), config: { ...baseCfg, currency: 'USD' },
      })
      assertEq(r.unlimited, false, 'unlimited')
      assertFiniteNumber(r.remaining, 'remaining')
    })
    t.test('边界：hard_limit_usd = 1e8 恰好等于哨兵 → 判无限', () => {
      const r = F.normalizeBalance({
        mode: 'compat', compat: { ok: true, hardLimitUsd: 100000000, usedCents: 0, usedUsd: 0 },
        status: F.parseRelayStatus(statusJson), config: { ...baseCfg, currency: 'USD' },
      })
      assertEq(r.unlimited, true, 'unlimited')
    })
  })

  // ---------- normalizeBalance：错误传播 ----------
  await t.group('normalizeBalance —— 上游失败传播（code 取值必须是 SPEC §5.1 固定集合）', () => {
    const CODES = ['NO_CREDENTIAL', 'HTTP_401', 'HTTP_403', 'HTTP_404', 'HTTP_ERROR', 'TIMEOUT', 'NETWORK', 'NON_JSON', 'SHAPE', 'UNLIMITED']
    t.test('native 401 → ok:false / code HTTP_401', () => {
      const r = F.normalizeBalance({
        mode: 'native', native: { ok: false, code: 'HTTP_401', error: 'unauthorized', httpStatus: 401 },
        status: F.parseRelayStatus(statusJson), config: { ...baseCfg },
      })
      assertEq(r.ok, false, 'ok')
      assertEq(r.code, 'HTTP_401', 'code')
      assert(CODES.includes(r.code), 'code 必须在固定集合内')
    })
    t.test('compat 超时 → TIMEOUT；网络 → NETWORK；非 JSON → NON_JSON', () => {
      const mk = (code) => F.normalizeBalance({
        mode: 'compat', compat: { ok: false, code, error: 'x' },
        status: F.parseRelayStatus(statusJson), config: { ...baseCfg },
      })
      assertEq(mk('TIMEOUT').code, 'TIMEOUT', 'TIMEOUT')
      assertEq(mk('NETWORK').code, 'NETWORK', 'NETWORK')
      assertEq(mk('NON_JSON').code, 'NON_JSON', 'NON_JSON')
    })
    t.test('缺凭据 → NO_CREDENTIAL', () => {
      const r = F.normalizeBalance({
        mode: 'compat', compat: { ok: false, code: 'NO_CREDENTIAL', error: '未配置' },
        status: F.parseRelayStatus(statusJson), config: { ...baseCfg },
      })
      assertEq(r.code, 'NO_CREDENTIAL', 'code')
    })
    t.test('SHAPE（user 结构缺关键字段）→ 不得返回 ok:true 且数值为 NaN', () => {
      const r = F.normalizeBalance({
        mode: 'native', native: { ok: true, user: { id: 1 } },
        status: F.parseRelayStatus(statusJson), config: { ...baseCfg, currency: 'USD' },
      })
      if (r.ok) {
        // 若实现选择“ok 但 remaining 为 null”，也必须明确（不能是 NaN）
        assert(r.remaining === null || Number.isFinite(r.remaining), `remaining 不能是 NaN（实际 ${r.remaining}）`)
      } else {
        assertEq(r.code, 'SHAPE', '无额度字段应报 SHAPE')
      }
    })
    t.test('所有失败返回都不含 httpStatus 之外的多余凭据痕迹（结构检查）', () => {
      const r = F.normalizeBalance({
        mode: 'compat', compat: { ok: false, code: 'HTTP_401', error: 'unauthorized' },
        status: F.parseRelayStatus(statusJson), config: { ...baseCfg },
      })
      assert(typeof r.error === 'string' && r.error.length > 0, '失败必须带 error 文本')
      assert(!('remaining' in r) || r.remaining === null, '失败不应给出 remaining 数值')
    })
  })

  // ---------- 真实 fixture（protocol 提供时） ----------
  await t.group('真实响应 fixture 交叉核对（test/fixtures/**）', () => {
    const statusFx = loadFixture('status.json')
    const subFx = loadFixture('billing-subscription.json')
    const usageFx = loadFixture('billing-usage.json')
    if (!statusFx || !subFx || !usageFx) {
      t.test('fixtures 缺失 → 显式标记无法验证（不静默跳过）', () => {
        const missing = [['status.json', statusFx], ['billing-subscription.json', subFx], ['billing-usage.json', usageFx]]
          .filter(([, v]) => !v).map(([n]) => n)
        console.log(`      [无法验证] protocol 的 fixtures 尚未就绪，缺少: ${missing.join(', ')}`)
      })
    } else {
      t.test('fixtures/status.json 解析出 SPEC §1 的公开字段', () => {
        const inner = statusFx.json && statusFx.json.data ? statusFx.json.data : statusFx.json
        const r = F.parseRelayStatus(statusFx.json)
        assertEq(r.ok, true, 'ok')
        assertEq(r.quotaPerUnit, inner.quota_per_unit, 'quotaPerUnit 与 fixture 一致')
        assertEq(r.usdExchangeRate, inner.usd_exchange_rate, 'usdExchangeRate 与 fixture 一致')
      })
      t.test('fixtures/billing-subscription.json → hardLimitUsd 与 fixture 一致', async () => {
        const inner = subFx.json
        const stub = makeFetchStub([{ match: 'subscription', response: jsonResponse(inner) }])
        const r = await F.fetchCompat(BASE, { apiKey: 'sk-fake', fetchImpl: stub })
        assertEq(r.ok, true, 'ok')
        assertEq(r.hardLimitUsd, inner.hard_limit_usd, 'hardLimitUsd')
      })
      t.test('fixtures/billing-usage.json → usedCents 与 fixture 一致', async () => {
        const inner = usageFx.json
        const stub = makeFetchStub([
          { match: 'subscription', response: jsonResponse(subFx.json) },
          { match: 'usage', response: jsonResponse(inner) },
        ])
        const r = await F.fetchCompat(BASE, { apiKey: 'sk-fake', fetchImpl: stub })
        assertEq(r.usedCents, inner.total_usage, 'usedCents')
      })
    }
  })

  await t.finish()
}
