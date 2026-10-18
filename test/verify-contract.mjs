// verify-contract.mjs —— 独立验证 lib/whale-contract.mjs（SPEC §5.2），并用**小鲸鱼真实源码**
// 复刻判定链证明该条目会被正确消费。
//
// 方法学（两条独立证据）：
//  证据① 源码锚点：直接读 dsh-whale-widget/lib/index.js，核对被我引用的每个关键判定语句确实
//         仍在挂件源码里（行号按 0.3.18 记录；挂件升级后会重排行号，故按内容定位并打印实际行号，
//         语句本身消失才判失败）。语义层面的兼容性由证据②判定链复刻 + 真实回环服务端独立证明。
//  证据② 判定链复刻：把该源码里 mergeNonEmpty / pickJsonPath / apiNum / originOfUrl /
//         templateOrigins / credentialMayGoTo / apiFetchJson / fetchModelBalance 的判定逻辑
//         **逐行复刻**到本文件（每段注明原始行号），喂入 buildWhaleEntry 产出的真实条目 +
//         一个真实的回环 HTTP 服务端响应，断言最终得到有限数值 remaining。
//         服务端同时校验它收到的 Authorization 头，证明凭据确实被发到了 bridge。
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {
  createRunner, assert, assertEq, assertDeepEq, assertFiniteNumber, assertIncludes,
  need, needFn, PKG_DIR, WHALE_SRC, readCredentialValue, mask,
} from './verify-helpers.mjs'

const MOD = path.join(PKG_DIR, 'lib', 'whale-contract.mjs')
const t = createRunner('verify-contract.mjs —— 条目契约 + 小鲸鱼真实源码判定链（SPEC §5.2）')

let mod = null
let loadError = null
try {
  mod = await import('file://' + MOD.replace(/\\/g, '/'))
} catch (err) {
  loadError = err
}

console.log(`模块: ${MOD}`)
console.log(`小鲸鱼源码: ${WHALE_SRC}`)

// ============ 证据①：源码锚点（在模块加载失败时也要跑，先做） ============
const { readFileSync, existsSync } = await import('node:fs')
let srcLines = null
if (existsSync(WHALE_SRC)) {
  srcLines = readFileSync(WHALE_SRC, 'utf8').split(/\r?\n/)
}
const ANCHORS = [
  [88, "path.join(DSH_HOME, '.dshw-api.json')", '注册表首选路径 = $DSH_HOME/.dshw-api.json'],
  [93, "const API_BUILTIN_ID = 'deepseek'", '内置 id 是 deepseek（我们不得占用）'],
  [246, "balance: { url: '', auth: 'Bearer {key}', json: { remaining: '' } }", "provider='custom' 模板：balance.url 默认空串"],
  [2009, 'function mergeNonEmpty(base, over) {', 'mergeNonEmpty 定义'],
  [2014, "if (v === undefined || v === null || v === '') continue", 'mergeNonEmpty：空串/null/undefined 不覆盖 base'],
  [2040, 'function assertSafeApiUrl(u) {', 'assertSafeApiUrl 定义（只放行 http/https）'],
  [2043, "if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')", 'assertSafeApiUrl：协议白名单'],
  [2055, 'if (parsed.username || parsed.password)', 'assertSafeApiUrl：拒绝 URL userinfo'],
  [2063, 'function originOfUrl(u) {', 'originOfUrl 定义'],
  [2070, 'function templateOrigins(tpl) {', 'templateOrigins 定义'],
  [2084, 'function credentialMayGoTo(model, tpl, url) {', 'credentialMayGoTo 定义'],
  [2088, 'return !!(model && model.allowCustomHost === true)', 'allowCustomHost 是自定义目的地的唯一放行开关'],
  [2107, "if (!key) return { key: '', code: 'NO_KEY', error: '未配置 '", '凭据名解析不到 → NO_KEY'],
  [2142, 'async function apiFetchJson(url, auth, key, opts) {', 'apiFetchJson 定义'],
  [2146, "if (a) headers.Authorization = a.replace('{key}', key)", "auth='Bearer {key}' → Authorization 头"],
  [2148, "const u = String(url).replace('{key}', key)", 'URL 占位符替换'],
  [2149, 'assertSafeApiUrl(u)', '发请求前过安全校验'],
  [2150, 'const init = { headers, signal: AbortSignal.timeout(15000) }', '默认 15s 超时'],
  [2160, 'const res = await fetch(u, init)', '真正发请求'],
  [2161, "if (!res.ok) throw new Error('HTTP ' + res.status)", '非 2xx 抛 HTTP 错误'],
  [2162, 'return await res.json()', '解析 JSON'],
  [2347, 'const b = mergeNonEmpty(tpl.balance, model.balance)', 'fetchModelBalance：模板与模型条目合并'],
  [2348, "if (!b.url) return { ok: false, code: 'NO_URL', error: '未配置余额接口地址' }", '无 url → NO_URL'],
  [2350, "const url = String(b.url).replace('{base}', base)", '{base} 占位符替换'],
  [2352, 'const k = await keyForDestination(model, tpl, url)', '目的地凭据校验'],
  [2362, 'if (j.remaining) { const v = apiNum(pickJsonPath(data, j.remaining), j.scale); if (v !== null) remaining = v }', 'json.remaining 路径取值'],
  [2375, 'if (remaining === null && total !== null) remaining = total - used', 'remaining 回退为 total-used'],
  [2376, "if (remaining === null) return { ok: false, code: 'SHAPE', error: '接口返回里没找到配置的字段（检查 JSON 路径）' }", '仍为 null → SHAPE'],
  [2377, 'return { ok: true, remaining, total, used, currency: model.currency || tpl.currency', '成功返回 remaining'],
  [2780, "const hasBalanceApi = !!String(balDesc.url || '').trim()", 'apiModelsPayload：hasBalanceApi 由 url 决定'],
  [2795, "entry.balanceMode = hasBalanceApi ? 'api' : 'events'", 'balanceMode 二态'],
  [2796, 'if (hasBalanceApi && hasKey)', '有接口且有 key 才取余额'],
  [2799, 'entry.balance = r.remaining', '余额写入 entry.balance'],
  [2810, 'entry.error = null', '无余额接口不算错误'],
]

// 行号锚点基线：dsh-whale-widget@0.3.18（lib/index.js 共 4198 行）。
// 挂件升级会重排行号（0.4.2 已重排），因此证据①按**内容定位**：关键语句仍存在于当前安装的
// 挂件源码（任意行）即通过，仅打印「行号漂移 → 实际行号」；语句彻底消失才算契约失效。
const ANCHOR_FALLBACKS = new Map([
  [2146, {
    needle: "let raw = String(auth == null ? 'Bearer {key}' : auth)",
    note: '0.4.2 起 auth 改为「头名:值」列表（headersFromAuth），缺省仍等价于单个 Authorization: Bearer {key}',
  }],
])
if (srcLines) {
  let whaleVersion = 'unknown'
  try {
    whaleVersion = JSON.parse(readFileSync(path.join(path.dirname(WHALE_SRC), '..', 'package.json'), 'utf8')).version
  } catch { /* 版本号读不到不影响锚点核对 */ }
  console.log(`小鲸鱼版本: ${whaleVersion}（${srcLines.length} 行；锚点行号基线 0.3.18 / 4198 行）`)
  let drifted = 0
  await t.group('证据① 源码锚点：小鲸鱼真实源码内容定位（行号基线 0.3.18）', () => {
    for (const [ln, needle, why] of ANCHORS) {
      t.test(`L${ln} ${why}`, () => {
        let idx = srcLines.findIndex((line) => line.includes(needle))
        let viaFallback = false
        if (idx < 0) {
          const fb = ANCHOR_FALLBACKS.get(ln)
          if (fb) {
            idx = srcLines.findIndex((line) => line.includes(fb.needle))
            viaFallback = idx >= 0
          }
        }
        assert(idx >= 0,
          `锚点内容已从当前小鲸鱼源码中消失：${needle}\n    （行号基线 0.3.18；若挂件大版本升级重写了该逻辑，请重新核对契约）`)
        if (idx + 1 !== ln) {
          drifted++
          console.log(`      [行号漂移] 记录 L${ln} → 实际 L${idx + 1}：${why}`)
        }
        if (viaFallback) console.log(`      [已重构] 记录 L${ln} → 实际 L${idx + 1}：${ANCHOR_FALLBACKS.get(ln).note}`)
      })
    }
    t.test('锚点内容全部可定位（行号允许随挂件版本漂移）', () => {
      console.log(`      内容定位 ${ANCHORS.length}/${ANCHORS.length} 处；行号与基线不同的 ${drifted} 处（基线 0.3.18 / 4198 行，当前 ${whaleVersion} / ${srcLines.length} 行）`)
      assert(srcLines.length > 500, `源码行数 ${srcLines.length} 异常，可能不是小鲸鱼挂件源码`)
    })
  })
} else {
  console.log('[无法验证] 找不到小鲸鱼源码，跳过源码锚点核对')
}

if (loadError) {
  console.log(`\n!! 无法加载模块，条目形状部分无法验证：\n${loadError.stack || loadError}`)
  console.log('SUMMARY: BLOCKED（lib/whale-contract.mjs 缺失/不可加载）')
  process.exitCode = 2
} else {
  const buildWhaleEntry = needFn(mod, 'buildWhaleEntry', 'whale-contract')
  const describeEntry = needFn(mod, 'describeEntry', 'whale-contract')
  const WHALE_API_FILE = need(mod, 'WHALE_API_FILE', 'whale-contract')

  const KEY = readCredentialValue('PI_API_KEY')
  const CRED_REF = 'PI_API_KEY'
  const SECRET = KEY || 'sk-verify-placeholder-not-a-real-key'

  const cfg = {
    modelId: 'newapi_relay', modelName: '团队中转站', currency: 'CNY',
    credentialRef: CRED_REF, matchIds: ['deepseek-v4.1-flash', 'tier-max', 'tier-power', 'tier-std'],
  }
  const ctxInfo = {
    bridgeUrl: 'http://127.0.0.1:19387',
    credentialRef: CRED_REF,
    modelId: 'newapi_relay',
    modelName: '团队中转站',
    currency: 'CNY',
    matchIds: ['deepseek-v4.1-flash', 'tier-max', 'tier-power', 'tier-std'],
    relayBaseUrl: 'http://127.0.0.1:3000',
  }
  const bal = (remaining, unlimited = false) => ({
    ok: true, source: 'compat', unlimited, remaining,
    total: unlimited ? null : 100, used: 18.345636, currency: 'CNY', credits: null, usedUsd: 18.345636,
    fetchedAt: Date.now(), mode: 'money',
    detail: { quotaPerUnit: 500000, usdExchangeRate: 7.3, note: '测试' },
    raw: {},
  })
  // SPEC §5.2 签名是 buildWhaleEntry(cfg, ctxInfo)：余额快照属于 cfg。实现文档化了三种等效形状
  // （cfg.coverage / cfg.balance / 扁平字段）——这里按 cfg.balance 构造，并探测“第三参数”形状是否
  // 也被接受（若支持则两种调用都被覆盖）。
  const cfgWith = (coverage) => ({ ...cfg, balance: coverage })
  const supportsThirdArg = (() => {
    try { return buildWhaleEntry(cfg, ctxInfo, bal(1)).mode === 'balance' } catch { return false }
  })()
  const build = (coverage) => buildWhaleEntry(cfgWith(coverage), ctxInfo)
  console.log(`调用形状: buildWhaleEntry(cfg{balance}, ctxInfo)（SPEC §5.2）；第三参数形状支持=${supportsThirdArg}`)

  await t.group('WHALE_API_FILE 常量', () => {
    t.test("WHALE_API_FILE === '.dshw-api.json'", () => assertEq(WHALE_API_FILE, '.dshw-api.json', 'WHALE_API_FILE'))
  })

  await t.group('evidence②-a buildWhaleEntry —— balance 模式（SPEC §5.2 形状逐字段）', () => {
    const r = build(bal(81.65))
    const e = r && r.entry ? r.entry : null
    t.test('返回 { entry, mode, warnings }', () => {
      assert(e, '必须返回 entry')
      assertEq(r.mode, 'balance', 'mode')
      assert(Array.isArray(r.warnings), 'warnings 必须是数组')
    })
    t.test('id/name/provider/currency/keyRef/baseUrl 逐字段正确', () => {
      assertEq(e.id, 'newapi_relay', 'id')
      assertEq(e.name, '团队中转站', 'name')
      assertEq(e.provider, 'custom', 'provider')
      assertEq(e.currency, 'CNY', 'currency')
      assertEq(e.keyRef, CRED_REF, 'keyRef 必须指向真实存在的凭据名')
      assertEq(e.baseUrl, 'http://127.0.0.1:3000', 'baseUrl')
    })
    t.test('allowCustomHost 必须为 true（否则小鲸鱼拒绝把凭据发到 bridge，L2088）', () => {
      assertEq(e.allowCustomHost, true, 'allowCustomHost')
    })
    t.test("balance.url 指向 <bridgeUrl>/dsh-whale-newapi/balance", () => {
      assert(e.balance && typeof e.balance.url === 'string', 'balance.url 必须是字符串')
      assertEq(e.balance.url, 'http://127.0.0.1:19387/dsh-whale-newapi/balance', 'balance.url')
    })
    t.test("balance.auth === 'Bearer {key}'（L2146 据此组 Authorization 头）", () => {
      assertEq(e.balance.auth, 'Bearer {key}', 'balance.auth')
    })
    t.test("balance.json.remaining === 'remaining'（L2362 pickJsonPath 取值路径）", () => {
      assert(e.balance.json && typeof e.balance.json === 'object', 'balance.json 必须存在')
      assertEq(e.balance.json.remaining, 'remaining', 'balance.json.remaining')
    })
    t.test('matchIds 为 SPEC §1 实测的 4 个模型 id', () => {
      assertDeepEq(e.matchIds, ['deepseek-v4.1-flash', 'tier-max', 'tier-power', 'tier-std'], 'matchIds')
    })
    t.test('不得写入凭据明文（任何字段都搜不到密钥）', () => {
      const s = JSON.stringify(e)
      assert(!s.includes(SECRET), '条目里不得出现凭据明文')
      assert(s.length < 2000, `条目不应异常臃肿（实际 ${s.length} 字节）`)
    })
    t.test('describeEntry 返回不含密钥的人类可读摘要', () => {
      const d = describeEntry(e)
      assertEq(typeof d, 'string', 'describeEntry 应返回字符串')
      assert(d.length > 0, '摘要不得为空')
      assert(!d.includes(SECRET), '摘要里不得出现凭据明文')
    })
    t.test('余额为 0 时仍必须是 balance 模式（0 是有限数值）', () => {
      const r0 = build(bal(0))
      assertEq(r0.mode, 'balance', 'remaining=0 应仍是 balance 模式')
      assertEq(r0.entry.balance.url, 'http://127.0.0.1:19387/dsh-whale-newapi/balance', 'url')
    })
    t.test('bridgeUrl 带尾斜杠时不得出现双斜杠', () => {
      const rr = buildWhaleEntry(cfg, { ...ctxInfo, bridgeUrl: 'http://127.0.0.1:19387/' }, bal(1))
      assert(!rr.entry.balance.url.includes('//dsh-whale-newapi'), `URL 出现双斜杠: ${rr.entry.balance.url}`)
    })
  })

  await t.group('buildWhaleEntry —— events 模式（unlimited 且无 fallbackTotal，SPEC §5.2）', () => {
    const r = build(bal(null, true))
    const e = r.entry
    t.test("mode === 'events'", () => assertEq(r.mode, 'events', 'mode'))
    t.test('不带可用 balance.url（空串或省略），使小鲸鱼 hasBalanceApi=false（L2780/L2795）', () => {
      const url = e.balance && typeof e.balance.url === 'string' ? e.balance.url : ''
      assertEq(String(url).trim(), '', `events 模式不得给出可用余额 URL，实际: ${JSON.stringify(url)}`)
    })
    t.test('warnings 非空且写明原因', () => {
      assert(Array.isArray(r.warnings) && r.warnings.length > 0, 'warnings 必须写明降级原因')
      assert(r.warnings.every((w) => typeof w === 'string' && w.length > 0), 'warnings 每项必须是非空字符串')
    })
    t.test('其余字段（id/provider/keyRef/allowCustomHost/matchIds）仍正确', () => {
      assertEq(e.id, 'newapi_relay', 'id')
      assertEq(e.provider, 'custom', 'provider')
      assertEq(e.keyRef, CRED_REF, 'keyRef')
      assertEq(e.allowCustomHost, true, 'allowCustomHost')
      assertDeepEq(e.matchIds, ['deepseek-v4.1-flash', 'tier-max', 'tier-power', 'tier-std'], 'matchIds')
    })
    t.test('remaining=Infinity/NaN（非有限数值）→ 降级为 events，绝不产出会让小鲸鱼报 SHAPE 的条目', () => {
      const cases = [bal(Infinity), bal(NaN)]
      for (const [i, input] of cases.entries()) {
        const rr = build(input)
        assertEq(rr.mode, 'events', `场景 ${i} 应降级为 events（SPEC §5.2：balance 模式只允许有限数值）`)
        const url = rr.entry.balance && rr.entry.balance.url ? rr.entry.balance.url : ''
        assertEq(String(url).trim(), '', `场景 ${i} 降级后不得留可用 URL`)
        assert(rr.warnings.length > 0, `场景 ${i} 降级必须给出 warnings`)
      }
    })
    t.test('上游 ok:false（临时故障）：允许 balance 或 events，但两种语义都必须自洽且不产出坏条目', () => {
      const rr = build({ ok: false, code: 'HTTP_401', error: 'unauthorized' })
      const url = String((rr.entry.balance && rr.entry.balance.url) || '').trim()
      if (rr.mode === 'balance') {
        // 保持 balance：必须保留可用 URL，并给出 warnings（小鲸鱼会走 /balance 得到 HTTP 200 + 业务错误行）
        assert(url.length > 0, 'balance 模式下必须保留可用 balance.url')
        assert(rr.warnings.length > 0, 'balance 模式下必须给出 warnings 说明上游失败')
        console.log(`      实测: mode=balance（保留 URL，挂件显示错误行）；warning=${rr.warnings[0]}`)
      } else {
        assertEq(url, '', 'events 模式下不得留可用 URL')
        assert(rr.warnings.length > 0, 'events 模式下必须给出 warnings')
        console.log(`      实测: mode=events；warning=${rr.warnings[0]}`)
      }
    })
    t.test('不传 balance（undefined）时不得抛异常（SPEC §7.5）', () => {
      let threw = null
      let rr = null
      try { rr = build(undefined) } catch (err) { threw = err }
      if (threw) throw new Error('buildWhaleEntry 不该抛: ' + threw.message)
      assert(rr && rr.entry, '应仍返回条目')
      assertEq(rr.mode, 'events', '无余额信息 → events')
    })
  })

  // ============ 证据②：判定链复刻 + 真实回环 HTTP 服务端 ============
  // —— 以下函数为 dsh-whale-widget/lib/index.js 对应函数的逐行复刻，行号见注释 ——

  // L2009-L2019 mergeNonEmpty
  function mergeNonEmpty(base, over) {
    const out = Object.assign({}, base || {})
    const o = over && typeof over === 'object' ? over : {}
    for (const k of Object.keys(o)) {
      const v = o[k]
      if (v === undefined || v === null || v === '') continue
      if (v && typeof v === 'object' && !Array.isArray(v)) { out[k] = mergeNonEmpty(out[k], v); continue }
      out[k] = v
    }
    return out
  }
  // L1989-L1999 pickJsonPath
  function pickJsonPath(obj, pathStr) {
    try {
      const parts = String(pathStr || '').replace(/\[(\d+)\]/g, '.$1').split('.').filter((x) => x.length > 0)
      let cur = obj
      for (const p of parts) {
        if (cur === null || cur === undefined) return undefined
        cur = cur[p]
      }
      return cur
    } catch (err) { return undefined }
  }
  // L2000-L2005 apiNum（忠实复刻：先用 Number() 强转，再 globalThis.isFinite 判定）
  function apiNum(v, scale) {
    const n = Number(v)
    if (!isFinite(n)) return null
    const s = isFinite(Number(scale)) && Number(scale) > 0 ? Number(scale) : 1
    return n * s
  }
  // 复刻 L2000-2005「值是数字」的严格判定，仅用于对照说明（宿主实际用的是上面 apiNum 的强转语义）
  function strictShape(data, j) {
    let remaining = null
    if (j && j.remaining) { const v = pickJsonPath(data, j.remaining); if (typeof v === 'number' && Number.isFinite(v)) remaining = v }
    if (remaining === null) return { ok: false, code: 'SHAPE', error: '接口返回里没找到配置的字段（检查 JSON 路径）' }
    return { ok: true, remaining }
  }
  // L2063-L2069 originOfUrl
  function originOfUrl(u) {
    try {
      const p = new URL(String(u))
      if (p.protocol !== 'http:' && p.protocol !== 'https:') return ''
      return p.origin.toLowerCase()
    } catch (err) { return '' }
  }
  // L2070-L2083 templateOrigins
  function templateOrigins(tpl) {
    const out = new Set()
    const add = (u) => {
      const s = String(u == null ? '' : u)
      if (!s || s.indexOf('{base}') >= 0) return
      const o = originOfUrl(s.replace('{key}', 'placeholder'))
      if (o) out.add(o)
    }
    add(tpl && tpl.probeUrl)
    add(tpl && tpl.balance && tpl.balance.url)
    add(tpl && tpl.balance && tpl.balance.usage && tpl.balance.usage.url)
    add(tpl && tpl.quota && tpl.quota.url)
    return out
  }
  // L2084-L2089 credentialMayGoTo
  function credentialMayGoTo(model, tpl, url) {
    const o = originOfUrl(url)
    if (!o) return false
    if (templateOrigins(tpl).has(o)) return true
    return !!(model && model.allowCustomHost === true)
  }
  // L2040-L2056 assertSafeApiUrl
  function assertSafeApiUrl(u) {
    let parsed
    try { parsed = new URL(u) } catch { throw new Error('无效的接口地址') }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('不支持的协议: ' + parsed.protocol)
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    if (host === 'metadata.google.internal' || host === 'metadata.goog' || host === '100.100.100.200') throw new Error('禁止访问云元数据地址')
    const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
    if (m) {
      const [a, b] = [Number(m[1]), Number(m[2])]
      if (a === 169 && b === 254) throw new Error('禁止访问 link-local 地址')
      if (a === 0) throw new Error('禁止访问该地址')
    }
    if (parsed.username || parsed.password) throw new Error('接口地址不允许携带用户名/密码')
  }
  // L2142-L2163 apiFetchJson
  async function apiFetchJson(url, auth, key, opts, fetchImpl = fetch) {
    const o = opts || {}
    const headers = {}
    const a = String(auth == null ? 'Bearer {key}' : auth)
    if (a) headers.Authorization = a.replace('{key}', key)
    const u = String(url).replace('{key}', key)
    assertSafeApiUrl(u)
    const init = { headers, signal: AbortSignal.timeout(15000) }
    const method = String((o.method) || 'GET').trim().toUpperCase()
    if (method !== 'GET') {
      init.method = method
      const raw = o.body
      if (raw !== undefined && raw !== null && String(raw).length) {
        headers['Content-Type'] = 'application/json'
        init.body = String(raw)
      }
    }
    const res = await fetchImpl(u, init)
    if (!res.ok) throw new Error('HTTP ' + res.status)
    return await res.json()
  }
  // L2339-L2381 fetchModelBalance（砍掉无关分支：不含 usage 子请求 / 非 custom 模板逻辑）
  async function fetchModelBalanceReplica(model, tpl, resolvedKey, fetchImpl) {
    const b = mergeNonEmpty(tpl.balance, model.balance) // L2347
    if (!b.url) return { ok: false, code: 'NO_URL', error: '未配置余额接口地址' } // L2348
    const base = String(model.baseUrl || '').replace(/\/+$/, '') // L2349
    const url = String(b.url).replace('{base}', base) // L2350
    // keyForDestination（L2101-L2118）
    let key = resolvedKey ? String(resolvedKey) : ''
    if (!key) return { ok: false, code: 'NO_KEY', error: '未配置 ' + (model.keyRef || '') } // L2107
    if (!credentialMayGoTo(model, tpl, url)) return { ok: false, code: 'DEST_NOT_ALLOWED', error: '已拒绝把凭据发出去' } // L2108-L2115
    try {
      const data = await apiFetchJson(url, b.auth, key, { method: b.method, body: b.body, base, params: model.params }, fetchImpl) // L2357
      const j = b.json || {}
      let remaining = null
      let total = null
      let used = 0
      if (j.remaining) { const v = apiNum(pickJsonPath(data, j.remaining), j.scale); if (v !== null) remaining = v } // L2362
      if (j.total) { const v = apiNum(pickJsonPath(data, j.total), j.scale); if (v !== null) total = v } // L2363
      if (j.used) { const v = apiNum(pickJsonPath(data, j.used), j.scale); if (v !== null) used += v } // L2364
      if (remaining === null && total !== null) remaining = total - used // L2375
      if (remaining === null) return { ok: false, code: 'SHAPE', error: '接口返回里没找到配置的字段（检查 JSON 路径）' } // L2376
      return { ok: true, remaining, total, used, currency: model.currency || tpl.currency || 'CNY' } // L2377
    } catch (err) {
      return { ok: false, code: 'HTTP', error: '余额接口请求失败: ' + String((err && err.message) || err).slice(0, 160) } // L2379
    }
  }
  // L2709-L2828 apiModelsPayload 里与我们的条目相关的判定（复刻）
  function payloadJudgment(model, tpl, resolvedKey) {
    const tplE = tpl || {}
    const balDesc = mergeNonEmpty(tplE.balance, model.balance) // L2745
    const entry = {
      needsHostConfirm: (() => {
        const tpl2 = tpl || {}
        const b2 = mergeNonEmpty(tpl2.balance, model.balance) || {}
        const base2 = String(model.baseUrl || '').replace(/\/+$/, '')
        const u2 = String(tpl2.probeUrl || b2.url || '').replace('{base}', base2)
        return !!u2 && !credentialMayGoTo(model, tpl2, u2)
      })(),
      allowCustomHost: model.allowCustomHost === true, // L2748
      hasKey: !!resolvedKey, // L2776
    }
    const tplM = tpl || {}
    const balDesc2 = Object.assign({}, tplM.balance || {}, model.balance || {}) // L2779（注意：这里是浅合并，非 mergeNonEmpty）
    const hasBalanceApi = !!String(balDesc2.url || '').trim() // L2780
    entry.hasBalanceApi = hasBalanceApi
    entry.balanceMode = hasBalanceApi ? 'api' : 'events' // L2795
    entry.balanceDesc = balDesc
    if (hasBalanceApi && entry.hasKey) {
      // 由调用方填充 balance
    } else if (!hasBalanceApi) {
      entry.error = null // L2810
    } else {
      entry.error = '未配置 ' + (model.keyRef || 'API key') // L2812
    }
    return entry
  }

  const CUSTOM_TPL = { name: '自定义 HTTP', currency: 'CNY', keyRef: 'CUSTOM_API_KEY', balance: { url: '', auth: 'Bearer {key}', json: { remaining: '' } } } // L244-L247

  await t.group('证据②-b credentialMayGoTo：为何 allowCustomHost 是必需的', () => {
    const entry = build(bal(81.65)).entry
    t.test('bridge origin 不在 custom 模板硬编码端点里（模板 balance.url 为空串 → 集合为空）', () => {
      const origins = templateOrigins(CUSTOM_TPL)
      assertEq(origins.size, 0, `custom 模板硬编码 origin 应为空集，实际 ${JSON.stringify([...origins])}`)
    })
    t.test('endpoint 带 {base} 的模板 URL 不算可信（L2074）', () => {
      const tplWithBase = { balance: { url: 'http://127.0.0.1:19387/{base}/x' } }
      assertEq(templateOrigins(tplWithBase).size, 0, '含 {base} 的 URL 必须被排除')
    })
    t.test('不设 allowCustomHost → 凭据被拒（DEST_NOT_ALLOWED）', async () => {
      const noFlag = { ...entry, allowCustomHost: false }
      const r = await fetchModelBalanceReplica(noFlag, CUSTOM_TPL, SECRET, fetch)
      assertEq(r.ok, false, 'ok')
      assertEq(r.code, 'DEST_NOT_ALLOWED', 'code')
      console.log(`      实际: ${JSON.stringify(r).slice(0, 200)}`)
    })
    t.test('设 allowCustomHost=true → 放行（L2088）', () => {
      assertEq(credentialMayGoTo(entry, CUSTOM_TPL, entry.balance.url), true, 'allowCustomHost=true 必须放行')
    })
    t.test('非 http/https 的 bridge URL → 拒绝', () => {
      assertEq(credentialMayGoTo({ ...entry, allowCustomHost: true }, CUSTOM_TPL, 'file:///etc/passwd'), false, 'file: 必须拒绝')
      assertEq(credentialMayGoTo({ ...entry, allowCustomHost: true }, CUSTOM_TPL, 'ftp://x/y'), false, 'ftp: 必须拒绝')
    })
  })

  await t.group('证据②-c 判定链复刻 + 真实回环 HTTP 服务端：端到端得到数值余额', () => {
    t.test('bridge 真实响应 → fetchModelBalance 得到有限数值 remaining，且凭据确实发出', async () => {
      const entry = build(bal(81.65)).entry
      const received = []
      // 真实回环 HTTP 服务端，充当插件的 /dsh-whale-newapi/balance
      const server = http.createServer((req, res) => {
        received.push({ url: req.url, authorization: req.headers.authorization, method: req.method })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          ok: true, remaining: 81.65, currency: 'CNY', total: 100, used: 18.35,
          unlimited: false, source: 'compat', fetchedAt: Date.now(), label: '团队中转站', note: '测试',
        }))
      })
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      const port = server.address().port
      try {
        const liveEntry = { ...entry, balance: { ...entry.balance, url: `http://127.0.0.1:${port}/dsh-whale-newapi/balance` } }
        const r = await fetchModelBalanceReplica(liveEntry, CUSTOM_TPL, SECRET, fetch)
        assertEq(r.ok, true, `判定链应成功，实际: ${JSON.stringify(r)}`)
        assertFiniteNumber(r.remaining, 'remaining 必须是有限数值（小鲸鱼对 null 会报 SHAPE）')
        assertEq(r.remaining, 81.65, 'remaining 必须等于 bridge 返回的数值')
        assertEq(r.currency, 'CNY', 'currency')
        assertEq(received.length, 1, '服务端应收到 1 次请求')
        assertEq(received[0].method, 'GET', '必须是 GET')
        assertEq(received[0].authorization, 'Bearer ' + SECRET, `Authorization 头必须是 'Bearer <凭据值>'（脱敏: Bearer ${mask(SECRET)}）`)
        console.log(`      服务端收到: ${received[0].method} ${received[0].url}  Authorization: Bearer ${mask(SECRET)}`)
        console.log(`      判定链结果: ${JSON.stringify(r)}`)
      } finally {
        await new Promise((resolve) => server.close(resolve))
      }
    })
    t.test('bridge 返回 remaining=null（且 total=null）→ 判定链得 remaining=0（∵ apiNum(null)=0），不报 SHAPE', async () => {
      // 实测证据（复刻宿主 L2000-2005 + L2362）：宿主用 `apiNum` 判定——`Number(null) === 0` 且
      // `isFinite(0)` 为真，所以 `remaining: null` 会被当成 **0** 接受，得 `{ok:true, remaining:0}`，
      // **不会**触发 SHAPE（SHAPE 只在 `pickJsonPath` 返回 undefined 即“响应体没有该键”时发生）。
      // 这正是 SPEC §6.1「remaining 在 balance 模式下必须是有限数值」的必要性所在：
      // 若实现真下发 `remaining: null`，挂件会显示「余额 0」，而不是红色 SHAPE 错误。
      const entry = build(bal(81.65)).entry
      const server = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, remaining: null, total: null, currency: 'CNY' }))
      })
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      const port = server.address().port
      try {
        const liveEntry = { ...entry, balance: { ...entry.balance, url: `http://127.0.0.1:${port}/x` } }
        const r = await fetchModelBalanceReplica(liveEntry, CUSTOM_TPL, SECRET, fetch)
        assertEq(r.ok, true, `实测判定链: ${JSON.stringify(r)}`)
        assertEq(r.remaining, 0, `实测: remaining=null 被 apiNum 折算为 0，实际 ${JSON.stringify(r.remaining)}`)
        const strict = strictShape({ remaining: null, total: null }, { remaining: 'remaining' })
        console.log(`      实测(宿主行为): ${JSON.stringify(r)} → 挂件显示「余额 0」`)
        console.log(`      对照(若宿主按 Number.isFinite 判定): ${JSON.stringify(strict)} → 这才是 SHAPE`)
      } finally {
        await new Promise((resolve) => server.close(resolve))
      }
    })
    t.test('bridge 响应里缺少 remaining 键 → 判定链确实报 SHAPE（这才是 SHAPE 的真实触发条件）', async () => {
      const entry = build(bal(81.65)).entry
      const server = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, currency: 'CNY' }))
      })
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      const port = server.address().port
      try {
        const liveEntry = { ...entry, balance: { ...entry.balance, url: `http://127.0.0.1:${port}/x` } }
        const r = await fetchModelBalanceReplica(liveEntry, CUSTOM_TPL, SECRET, fetch)
        assertEq(r.ok, false, `缺 remaining 键应失败，实测 ${JSON.stringify(r)}`)
        assertEq(r.code, 'SHAPE', 'code')
        console.log(`      实测: ${JSON.stringify(r)}`)
      } finally {
        await new Promise((resolve) => server.close(resolve))
      }
    })
    t.test('条目只配置 json.remaining（实为 SPEC §5.2 形状）→ 宿主 total-used 回退不会介入，remaining=0 直接生效', async () => {
      // 实测：建出的条目 balance.json 只有 { remaining: 'remaining' }（无 total/used 路径）。
      // 宿主 L2363-2364 只在 `j.total` / `j.used` 有配置时才取值，因此 total 恒为 null，
      // L2375 的 `remaining = total - used` 回退**不会触发**——remaining=null 经 apiNum 变成 0。
      const entry = build(bal(81.65)).entry
      assertDeepEq(entry.balance.json, { remaining: 'remaining' }, '条目只配置 remaining 路径')
      const server = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, remaining: null, total: 100, used: 18.5, currency: 'CNY' }))
      })
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      const port = server.address().port
      try {
        const liveEntry = { ...entry, balance: { ...entry.balance, url: `http://127.0.0.1:${port}/x` } }
        const r = await fetchModelBalanceReplica(liveEntry, CUSTOM_TPL, SECRET, fetch)
        assertEq(r.ok, true, `实测 ${JSON.stringify(r)}`)
        assertEq(r.remaining, 0, `total 未配置 → 回退不可用 → remaining=apiNum(null)=0，实际 ${r.remaining}`)
        console.log(`      实测: ${JSON.stringify(r)}（total=null 说明 j.total 未配置，L2375 回退未触发）`)
      } finally {
        await new Promise((resolve) => server.close(resolve))
      }
    })
    t.test('发现（证据固定）：响应体含 remaining:null 时，宿主 L2375 的 total-used 回退不可达 —— apiNum(null)=0', async () => {
      // 实测（本文件复刻的 apiNum，与源码 L2000-2005 逐字一致）：
      //   Number(null) === 0 → isFinite(0) === true → apiNum(null) 返回 0，**不是 null**。
      // 因此 L2362 `if (v !== null) remaining = v` 会把 remaining 置为 0；L2375 的
      // `if (remaining === null && total !== null)` 永远不成立（回退不可达）。
      // 即使把 JSON 路径补全为 {remaining,total,used}（mergeNonEmpty 合并后三键都在），结论相同。
      // ⇒ 对 bridge 的硬性含义：/balance 必须返回**有限数值**的 remaining；
      //   返回 null 会让挂件显示「余额 0」而不是「—」或 SHAPE 错误（SPEC §6.1 的硬要求因此必要）。
      const patched = {
        ...build(bal(81.65)).entry,
        balance: {
          url: 'http://127.0.0.1:1/x', auth: 'Bearer {key}',
          json: { remaining: 'remaining', total: 'total', used: 'used' },
        },
      }
      const b = mergeNonEmpty(CUSTOM_TPL.balance, patched.balance)
      assertDeepEq(b.json, { remaining: 'remaining', total: 'total', used: 'used' }, 'mergeNonEmpty 后三条路径都在')
      const data = { ok: true, remaining: null, total: 100, used: 18.5 }
      let remaining = null
      if (b.json.remaining) { const v = apiNum(pickJsonPath(data, b.json.remaining), b.json.scale); if (v !== null) remaining = v }
      assertEq(remaining, 0, 'apiNum(null) = 0（不是 null）')
      assertEq(apiNum(null), 0, 'apiNum(null) 必须为 0（源码 L2000-2005 语义）')
      console.log(`      实测: pickJsonPath→null; apiNum(null)=${apiNum(null)}; remaining=${remaining}`)
      console.log('      结论: 响应含 remaining:null → 宿主显示「余额 0」；L2375 回退不可达（回退仅在**缺该键**时有意义）')
    })
    t.test('L2375 回退可达的唯一条件：响应体**不含** remaining 键且配置了 total/used', async () => {
      const entry = build(bal(81.65)).entry
      const server = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, total: 100, used: 18.5, currency: 'CNY' })) // 无 remaining 键
      })
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      const port = server.address().port
      try {
        const patched = {
          ...entry,
          balance: { ...entry.balance, url: `http://127.0.0.1:${port}/x`, json: { remaining: 'remaining', total: 'total', used: 'used' } },
        }
        const r = await fetchModelBalanceReplica(patched, CUSTOM_TPL, SECRET, fetch)
        assertEq(r.ok, true, `实测 ${JSON.stringify(r)}`)
        assertEq(r.remaining, 81.5, `remaining = total - used，实际 ${r.remaining}`)
        console.log(`      实测: ${JSON.stringify(r)} → 缺键时 L2375 回退生效`)
      } finally {
        await new Promise((resolve) => server.close(resolve))
      }
    })
    t.test('bridge 返回 HTTP 401 → 判定链报 HTTP 错误（不会静默给出余额）', async () => {
      const entry = build(bal(81.65)).entry
      const server = http.createServer((req, res) => { res.writeHead(401); res.end('{}') })
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      const port = server.address().port
      try {
        const liveEntry = { ...entry, balance: { ...entry.balance, url: `http://127.0.0.1:${port}/x` } }
        const r = await fetchModelBalanceReplica(liveEntry, CUSTOM_TPL, SECRET, fetch)
        assertEq(r.ok, false, 'ok')
        assertIncludes(r.error, 'HTTP 401', '错误里应包含 HTTP 401')
      } finally {
        await new Promise((resolve) => server.close(resolve))
      }
    })
    t.test('需要 {base} 替换：baseUrl 末尾斜杠不会造成 URL 破损', () => {
      const e2 = { ...build(bal(1)).entry, baseUrl: 'http://127.0.0.1:3000/' }
      const base = String(e2.baseUrl).replace(/\/+$/, '')
      assertEq(base, 'http://127.0.0.1:3000', 'base 去尾斜杠')
      assertEq(originOfUrl(e2.balance.url), 'http://127.0.0.1:19387', 'bridge origin')
    })
  })

  await t.group('证据②-d apiModelsPayload 判定：我们的条目 → api 模式且有余额', () => {
    t.test('balance 模式条目：hasBalanceApi=true, balanceMode=api, error=null, needsHostConfirm=false', () => {
      const entry = build(bal(81.65)).entry
      const j = payloadJudgment(entry, CUSTOM_TPL, SECRET)
      assertEq(j.hasBalanceApi, true, 'hasBalanceApi（L2780 用 balDesc.url）')
      assertEq(j.balanceMode, 'api', 'balanceMode（L2795）')
      assertEq(j.allowCustomHost, true, 'allowCustomHost（L2748）')
      assertEq(j.needsHostConfirm, false, 'needsHostConfirm 必须为 false（否则前端会提示“需在本机确认”，L2720-L2728）')
      assertEq(j.hasKey, true, 'hasKey')
      console.log(`      判定: ${JSON.stringify(j)}`)
    })
    t.test('events 模式条目：hasBalanceApi=false, balanceMode=events, error=null（显示“余额 —”而非报错）', () => {
      const entry = build(bal(null, true)).entry
      const j = payloadJudgment(entry, CUSTOM_TPL, SECRET)
      assertEq(j.hasBalanceApi, false, 'hasBalanceApi 必须为 false（L2810: 无余额接口不算错误）')
      assertEq(j.balanceMode, 'events', 'balanceMode（L2795）')
      assertEq(j.error, null, 'error 必须为 null（L2810）')
      console.log(`      判定: ${JSON.stringify(j)}`)
    })
    t.test('若 keyRef 指向的凭据不存在 → hasKey=false 且小鲸鱼报“未配置 X”（L2812）', () => {
      const entry = build(bal(81.65)).entry
      const j = payloadJudgment(entry, CUSTOM_TPL, '')
      assertEq(j.hasKey, false, 'hasKey')
      assertEq(j.error, '未配置 ' + CRED_REF, 'error 文案')
    })
    t.test('bridge url 未被小鲸鱼 safety 校验拒绝（assertSafeApiUrl 通过）', () => {
      const entry = build(bal(81.65)).entry
      let threw = null
      try { assertSafeApiUrl(entry.balance.url) } catch (err) { threw = err }
      assertEq(threw, null, `bridge URL 不应被 assertSafeApiUrl 拒绝: ${threw && threw.message}`)
    })
    t.test('条目里 baseUrl 与 bridge url 是不同 origin（这正是需要 allowCustomHost 的原因）', () => {
      const entry = build(bal(81.65)).entry
      assert(originOfUrl(entry.balance.url) !== originOfUrl(entry.baseUrl), 'bridge origin 与中转站 origin 不同')
    })
  })

  await t.finish()
}
