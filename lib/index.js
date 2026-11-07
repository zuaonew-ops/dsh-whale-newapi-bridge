/**
 * dsh-whale-newapi-bridge —— 宿主半区（v0.2.0 起 host + web client bundle plugin）。
 *
 * 职责（SPEC §3 / §6 / §7）：
 * 1. 在回环 HTTP 上提供 6 条路由，供设置页（client.js）、小鲸鱼挂件与本机诊断使用：
 *    `GET  /dsh-whale-newapi/balance`        小鲸鱼取余额（Bearer 恒定时间比较）
 *    `GET  /dsh-whale-newapi/status`         诊断快照（脱敏）
 *    `POST /dsh-whale-newapi/sync`           强制重新探测 + 重写 `.dshw-api.json` 条目
 *    `GET  /dsh-whale-newapi/health`         本机自检（无 Bearer，仍过信任栅栏）
 *    `GET  /dsh-whale-newapi/settings`       设置页读当前生效配置 + 状态（无 Bearer，仅回环）
 *    `POST /dsh-whale-newapi/settings`       保存设置（校验 → 原子写设置文件 → 热生效）
 *    `POST /dsh-whale-newapi/settings/reset` 恢复默认（删除设置文件，回退 yml/默认值）
 * 2. 按 `$DSH_HOME/.dshw-api.json` 的扩展面维护**我们自己的**模型条目
 *    （委托给 bridge 的 `whale-registry.mjs` / `whale-contract.mjs`，SPEC §5.2/§5.3）。
 * 3. 按 `$DSH_HOME/whale-newapi-bridge-settings.json` 维护设置页的覆盖项
 *    （委托给 `settings.mjs`；优先级：设置文件 > Loader yml > 内置默认，SPEC §4.7）。
 *
 * 铁律：
 * - `apply` **永不抛出**：所有路径包 try/catch，异常进内部状态，`/status` 可见；
 * - 任何响应/错误/日志都不出现凭据明文（统一 {@link redactText}）；
 * - 上游只允许 http/https（`normalizeBaseUrl`），不允许 userinfo；
 * - 写 `.dshw-api.json` 前必须 `readWhaleRegistry` 成功，坏文件只报错不写。
 *
 * @module dsh-whale-newapi-bridge
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import {
  Config,
  PLUGIN_VERSION,
  SCHEMASTERMY_SOURCE,
  normalizeConfig,
  publicConfig,
} from './config.mjs'
import {
  PERSISTED_KEYS,
  deleteSettingsFile,
  readSettingsFile,
  resolveSettingsPath,
  saveSettings,
  validateSettingsPatch,
} from './settings.mjs'
import {
  explainLoopbackBaseUrl,
  isFiniteNumber,
  fetchCompat,
  fetchModelIds,
  fetchNativeUser,
  fetchRelayStatus,
  normalizeBalance,
  normalizeBaseUrl,
  normalizeLoopbackBaseUrl,
  redactText,
  requestJson,
} from './newapi.mjs'

export { Config }

/** 插件名（Loader 行会用它，也是 `/health` 自检的期望值）。 */
export const name = 'dsh-whale-newapi-bridge'

/** 硬依赖：没有 HTTP 服务就不该加载这个 bundle。credentials 走软取。 */
export const inject = ['webServer']

const ROUTE_PREFIX = '/dsh-whale-newapi'
const PATHS = {
  balance: `${ROUTE_PREFIX}/balance`,
  status: `${ROUTE_PREFIX}/status`,
  sync: `${ROUTE_PREFIX}/sync`,
  health: `${ROUTE_PREFIX}/health`,
  /** 设置页：读当前生效配置 + 最近同步/余额/凭据状态（仅回环，无 Bearer）。 */
  settings: `${ROUTE_PREFIX}/settings`,
  /** 设置页：恢复默认（删除设置文件）。 */
  settingsReset: `${ROUTE_PREFIX}/settings/reset`,
}

/** `/balance` 的短缓存：5s 内的重复轮询复用上一次结果（避免每次挂件刷新都打 2 个上游接口）。 */
const BALANCE_CACHE_MS = 5000
/** 路由路径上给上游的总预算：必须明显小于挂件自己的 15s（`apiFetchJson` 的 AbortSignal.timeout(15000)）。 */
const ROUTE_DEADLINE_MS = 12000
/** 桥自检超时。 */
const SELF_CHECK_TIMEOUT_MS = 4000
/** POST /sync 请求体上限。 */
const MAX_BODY_BYTES = 64 * 1024
/** warnings 数组上限（内部状态不无限增长）。 */
const MAX_WARNINGS = 50
/** 内部错误环形缓冲上限。 */
const MAX_ERRORS = 20
/** `/v1/models` 取不到时的 matchIds 兜底（SPEC §1 实测列表）。 */
const MATCH_IDS_FALLBACK = Object.freeze([
  'deepseek-v4.1-flash',
  'tier-max',
  'tier-power',
  'tier-std',
])
/** `POST /sync` 只接受这些键（SPEC §6.3）。 */
const SYNC_OVERRIDE_KEYS = Object.freeze(['bridgeBaseUrl', 'credentialRef', 'modelId', 'fallbackTotal'])
/** 默认桥地址（SPEC §6 探测顺序的最后一项）。 */
const DEFAULT_BRIDGE_BASE_URL = 'http://127.0.0.1:19387'

// ── 通用小工具 ──────────────────────────────────────────────────────────────

function headerOf(req, key) {
  const headers = req && req.headers ? req.headers : {}
  const value = headers[key]
  return typeof value === 'string' ? value : undefined
}

function parseAuthority(authority) {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

/** 回环主机名（语义对齐 dsh-better-sidebar/src/trust-fence.ts）。 */
function isLoopbackHostname(hostname) {
  const host = String(hostname || '').toLowerCase()
  if (host === 'localhost' || host === '[::1]' || host === '::1') return true
  const parts = host.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** `DSHW_TRUSTED_HOSTS` 声明的权威（逗号分隔，可带端口）。 */
function trustedHosts() {
  return String(process.env.DSHW_TRUSTED_HOSTS || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== '')
}

function canonicalAuthority(entry, entryUrl) {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
}

function isTrustedAuthority(hostUrl, list) {
  return list.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

/**
 * 浏览器信任栅栏（SPEC §6 首段，语义照抄 trust-fence.ts）：
 * Host 必须是回环或 `DSHW_TRUSTED_HOSTS` 声明的权威；`Sec-Fetch-Site: cross-site` 拒绝；
 * 带 `Origin` 时必须与 Host 同 hostname（Chromium 在非默认端口上可能省略 Origin 的端口）。
 *
 * @param req - node HTTP 请求。
 * @returns 允许通过时 true。
 */
function fence(req) {
  try {
    const host = headerOf(req, 'host')
    if (host === undefined) return false
    const hostUrl = parseAuthority(host)
    if (hostUrl === undefined) return false
    if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts())) return false
    if (headerOf(req, 'sec-fetch-site') === 'cross-site') return false
    const origin = headerOf(req, 'origin')
    if (origin === undefined) return true
    try {
      return new URL(origin).hostname === hostUrl.hostname
    } catch {
      return false
    }
  } catch {
    return false
  }
}

/**
 * 恒定时间比较两个字符串。先各自 sha256（长度不同也安全，且不泄漏长度差）。
 *
 * @param a - 请求带来的值。
 * @param b - 真实凭据值。
 * @returns 相等时 true。
 */
function secretEquals(a, b) {
  try {
    if (typeof a !== 'string' || typeof b !== 'string' || a === '' || b === '') return false
    const ha = createHash('sha256').update(a, 'utf8').digest()
    const hb = createHash('sha256').update(b, 'utf8').digest()
    return timingSafeEqual(ha, hb)
  } catch {
    return false
  }
}

function bearerOf(req) {
  const raw = headerOf(req, 'authorization')
  if (typeof raw !== 'string') return null
  const match = /^Bearer[ \t]+(.+)$/i.exec(raw.trim())
  return match === null ? null : match[1].trim()
}

function sendJson(res, status, payload) {
  let body
  try {
    body = JSON.stringify(payload)
  } catch {
    body = '{"ok":false,"code":"INTERNAL","error":"响应序列化失败"}'
    status = 500
  }
  try {
    if (res.headersSent !== true) {
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
    }
    res.end(body)
  } catch {
    try {
      res.end()
    } catch {
      /* 连接已经没了 */
    }
  }
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let size = 0
    let settled = false
    const chunks = []
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    try {
      req.on('data', (chunk) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
        size += buf.length
        if (size > MAX_BODY_BYTES) {
          finish({ ok: false, error: `请求体超过 ${MAX_BODY_BYTES} 字节` })
          try {
            req.destroy()
          } catch {
            /* 忽略 */
          }
          return
        }
        chunks.push(buf)
      })
      req.on('end', () => {
        if (size === 0) {
          finish({ ok: true, value: {} })
          return
        }
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            finish({ ok: false, error: '请求体必须是 JSON 对象' })
            return
          }
          finish({ ok: true, value: parsed })
        } catch {
          finish({ ok: false, error: '请求体不是合法 JSON' })
        }
      })
      req.on('error', () => finish({ ok: false, error: '读取请求体失败' }))
    } catch {
      finish({ ok: false, error: '读取请求体失败' })
    }
  })
}

function methodNotAllowed(req, res, expected) {
  if (String(req.method || 'GET').toUpperCase() === expected) return false
  sendJson(res, 405, { ok: false, code: 'METHOD', error: `只支持 ${expected}` })
  return true
}

function forbidden(res) {
  sendJson(res, 403, { ok: false, code: 'FORBIDDEN', error: '请求未通过回环信任栅栏' })
}

// ── 桥地址探测 ──────────────────────────────────────────────────────────────

/** `process.argv` 里的端口声明（SPEC §6：`--port=<n>`，也兼容 `--port <n>`）。 */
function portFromArgv(argv = process.argv) {
  const args = argv.slice(1).map((value) => String(value))
  for (let i = 0; i < args.length; i += 1) {
    const inline = /^--port=(\d{1,5})$/.exec(args[i])
    if (inline !== null) return inline[1]
    if (args[i] === '--port' && i + 1 < args.length && /^\d{1,5}$/.test(args[i + 1])) return args[i + 1]
  }
  return null
}

/**
 * 宿主 Web 服务**实际监听**的 origin（`ctx.webServer.getOrigin()`，spec-v2 §10.6）。
 *
 * 为什么需要它：桌面宿主用 `--port 0` 启动 profile（端口由系统随机分配、不落盘），
 * 而 `DSH_WEB_URL` 是 Web 服务**起来之后**才注入给子进程的 —— 插件 apply 时宿主自己的
 * `process.env` 里还没有它，`argv` 里也没有真实端口，于是探测链会一路掉到默认值 19387，
 * 写进注册表的 `balance.url` 指向一个没人监听的端口。
 *
 * @param deps - `{ getOrigin }`；`getOrigin` 抛（监听尚未 bind）或缺失时返回 null，交给下一候选。
 * @returns origin 字符串或 null。
 */
function liveOrigin(deps) {
  try {
    const getOrigin = deps?.getOrigin
    if (typeof getOrigin !== 'function') return null
    const value = getOrigin()
    return typeof value === 'string' && value.trim() !== '' ? value : null
  } catch {
    return null
  }
}

/**
 * 桥地址自动探测（SPEC §6 + §10.6 顺序）：config.bridgeBaseUrl → DSH_WEB_URL →
 * `webServer.getOrigin()` → DSH_WEB_PORT/PORT → argv 的 --port → 默认 http://127.0.0.1:19387。
 *
 * @param config - 归一化配置。
 * @param deps - `{ getOrigin }`（宿主 Web 服务的实时 origin；缺省则跳过该候选）。
 * @returns `{ baseUrl, source, warnings }`（探测失败也总会给出默认地址，并由自检如实报告）。
 *
 * 回环策略（SPEC §10.2 + §10.2-a）：只有 `config.bridgeBaseUrl`（在 `normalizeConfig` 里
 * 用 `normalizeLoopbackBaseUrl` 落地）与 `/sync` 的覆盖值受「必须回环」硬约束；下面这些候选
 * —— `DSH_WEB_URL` / `webServer.getOrigin()` / `DSH_WEB_PORT` / `PORT` / `argv --port=` ——
 * **允许非回环**：它们由宿主自己或启动宿主的人（操作者）控制，不在「本机任意进程都能改写条目
 * balance.url、把中转站凭据导向别处」的威胁模型内，因此不收紧；但按 §10.2-a 必须**可见** ——
 * 选中的候选非回环时，下面会往 warnings 里记一条点明来源与 hostname 的提示。
 */
function resolveBridgeBaseUrl(config, deps = {}) {
  const warnings = []
  const attempt = (value, source) => {
    if (typeof value !== 'string' || value.trim() === '') return null
    try {
      return { baseUrl: normalizeBaseUrl(value), source }
    } catch (err) {
      warnings.push(`桥地址候选（${source}）不可用：${err.message}`)
      return null
    }
  }
  const ordered = [
    attempt(config.bridgeBaseUrl, 'config.bridgeBaseUrl'),
    attempt(process.env.DSH_WEB_URL, 'env:DSH_WEB_URL'),
    // spec-v2 §10.6：宿主 Web 服务实际监听的 origin —— 桌面宿主用 `--port 0` 随机分配端口，
    // 上面两个候选在插件 apply/sync 时都拿不到真实端口，这里才是权威来源。
    attempt(liveOrigin(deps), 'webServer.getOrigin()'),
  ]
  const envPort = process.env.DSH_WEB_PORT || process.env.PORT
  if (typeof envPort === 'string' && envPort.trim() !== '') {
    const port = Number(envPort)
    if (Number.isFinite(port) && port > 0) {
      ordered.push(attempt(`http://127.0.0.1:${Math.floor(port)}`, 'env:DSH_WEB_PORT/PORT'))
    } else {
      warnings.push(`DSH_WEB_PORT/PORT=${envPort} 不是合法端口，已忽略`)
    }
  }
  const argvPort = portFromArgv()
  if (argvPort !== null) ordered.push(attempt(`http://127.0.0.1:${argvPort}`, 'argv:--port'))
  for (const candidate of ordered) {
    if (candidate !== null) {
      const notLoopback = explainLoopbackBaseUrl(candidate.baseUrl)
      if (notLoopback !== null) {
        warnings.push(
          `自动探测到的桥地址非回环（来源 ${candidate.source}，${notLoopback}）：${candidate.baseUrl}。` +
            '条目 balance.url 会指向该主机，小鲸鱼会把凭据发往此地址；' +
            '该候选来自宿主进程环境变量/启动参数（由启动宿主的人控制，SPEC §10.2 允许），此处只作提示。',
        )
      }
      return { baseUrl: candidate.baseUrl, source: candidate.source, warnings }
    }
  }
  return { baseUrl: DEFAULT_BRIDGE_BASE_URL, source: 'default', warnings }
}

// ── 插件实例 ────────────────────────────────────────────────────────────────

/**
 * 装配一个插件实例（apply 的全部逻辑都在这里，便于把所有异常收进内部状态）。
 *
 * @param ctx - cordis Context（已注入 webServer）。
 * @param rawConfig - Loader 传入的配置。
 * @returns 内部句柄（apply 不使用返回值，但便于测试/诊断）。
 */
function createBridge(ctx, rawConfig) {
  const warnings = []
  const errors = []
  const state = {
    config: normalizeConfig(undefined).config,
    credential: { ref: normalizeConfig(undefined).config.credentialRef, present: false, source: 'config', tried: [] },
    upstream: null,
    balance: null,
    balanceAt: 0,
    whale: {
      id: null,
      mode: null,
      entry: null,
      registryFile: null,
      registryOk: null,
      lastSyncAt: null,
      lastSyncResult: null,
      lastSyncTrigger: null,
      changed: null,
      backupPath: null,
    },
    bridge: {
      baseUrl: null,
      probeSource: null,
      selfCheck: { ok: null, httpStatus: null, error: null, at: null },
    },
    /** 设置页持久化状态（文件路径 + 已生效的覆盖项 + 键列表，SPEC §4.7）。 */
    settings: {
      file: null,
      values: {},
      keys: [],
    },
  }
  /** 只在闭包里保存凭据明文，永不进 state / 响应 / 日志。 */
  let credentialValue = null
  let credentialCache = null
  /** 凭据解析诊断计数（只有数字，进 /status.internal，不含任何凭据内容）。 */
  let credentialResolveCalls = 0
  let credentialCacheHits = 0
  let credentialInvalidations = 0
  let credentialCacheInvalidatedAt = null
  let bridgeModules = null
  let syncInFlight = false
  let balanceInFlight = null
  let timer = null
  /** 定时器只注册一个 ctx.effect（热更新只替换 interval，不重复注册 effect）。 */
  let timerEffectInstalled = false
  /** Loader 传入的 yml 配置浅拷贝（设置文件覆盖层的底；reset 时回退到它）。 */
  let baseConfig = {}

  const redact = (value, extra = []) => redactText(value, [
    ...(typeof credentialValue === 'string' && credentialValue !== '' ? [credentialValue] : []),
    ...extra,
  ])

  /** 脱敏后记一条 warning（去重、封顶）。 */
  function pushWarning(text) {
    const clean = redact(text)
    if (clean === '' || warnings.includes(clean)) return
    warnings.push(clean)
    while (warnings.length > MAX_WARNINGS) warnings.shift()
  }

  /** 脱敏后记一条内部错误（`/status` 的 `internal.errors` 可见）。 */
  function noteError(where, err) {
    const message = redact(err && err.message !== undefined ? err.message : err)
    if (errors.some((entry) => entry.where === where && entry.error === message)) return
    errors.push({ at: Date.now(), where: String(where), error: message })
    while (errors.length > MAX_ERRORS) errors.shift()
  }

  /** 软取一个宿主服务（credentials 是软依赖，缺失/抛异常都不能影响 apply）。 */
  function getService(serviceName) {
    try {
      if (typeof ctx.get === 'function') {
        const service = ctx.get(serviceName)
        if (service) return service
      }
    } catch {
      /* 服务未注册时 cordis 代理可能抛，忽略 */
    }
    try {
      const service = ctx[serviceName]
      if (service) return service
    } catch {
      /* 同上 */
    }
    return undefined
  }

  function credValueOf(result) {
    if (typeof result === 'string') return result
    if (result !== null && typeof result === 'object') {
      for (const key of ['value', 'key', 'secret', 'token']) {
        if (typeof result[key] === 'string' && result[key] !== '') return result[key]
      }
    }
    return null
  }

  /**
   * 是否需要绕过凭据缓存重新解析（SPEC §10.3）。
   *
   * 只有「缓存到的 ref 就是配置里的首选 credentialRef」时才允许继续用缓存；
   * 若当前用的是候选回退（ref !== credentialRef），说明用户可能**之后**才把系统访问令牌
   * 写进首选 ref，必须每次都重新解析，好让它被立刻接管。
   *
   * @param config - 本次生效的配置。
   * @returns 需要强制重新解析时为 true。
   */
  function credentialNeedsRefresh(config) {
    if (credentialCache === null || credentialValue === null) return true
    return credentialCache.ref !== config.credentialRef
  }

  /**
   * 按 credentialRef → credentialCandidates 顺序解析凭据（软依赖 credentials）。
   *
   * @param config - 本次生效的配置。
   * @param options - `{ force?: boolean }`。
   * @returns `{ ref, source, value, tried, present }`（value 只在闭包内流转）。
   */
  async function resolveCredential(config, options = {}) {
    if (options.force !== true && credentialCache !== null && credentialValue !== null) {
      credentialCacheHits += 1
      return credentialCache
    }
    credentialResolveCalls += 1
    const previousRef = credentialCache !== null ? credentialCache.ref : null
    const tried = []
    const service = getService('credentials')
    const finish = (entry) => {
      if (entry.ref !== previousRef) {
        // SPEC §10.3：凭据来源发生切换（例如候选 → 后来才写进首选 ref 的令牌）时，
        // 立刻作废 5s 余额缓存，避免把上一份凭据的结论继续喂给挂件。
        state.balanceAt = 0
      }
      return entry
    }
    if (service === undefined || typeof service.resolve !== 'function') {
      pushWarning('credentials 服务不可用：无法解析凭据，余额接口会按 NO_CREDENTIAL 处理')
      credentialValue = null
      credentialCache = { ref: config.credentialRef, source: 'config', value: null, tried, present: false }
      state.credential = { ref: config.credentialRef, present: false, source: 'config', tried: [] }
      return finish(credentialCache)
    }
    for (const ref of config.credentialCandidates) {
      try {
        const value = credValueOf(await service.resolve(ref))
        if (typeof value === 'string' && value !== '') {
          credentialValue = value
          credentialCache = {
            ref,
            source: ref === config.credentialRef ? 'config' : 'candidate',
            value,
            tried,
            present: true,
          }
          state.credential = { ref, present: true, source: credentialCache.source, tried: [...tried] }
          return finish(credentialCache)
        }
      } catch (err) {
        noteError(`credentials.resolve(${ref})`, err)
      }
      tried.push(ref)
    }
    credentialValue = null
    credentialCache = { ref: config.credentialRef, source: 'config', value: null, tried, present: false }
    state.credential = { ref: config.credentialRef, present: false, source: 'config', tried: [...tried] }
    pushWarning(`没有解析到任何可用凭据（已尝试：${tried.join(', ') || '无候选'}）`)
    return finish(credentialCache)
  }

  /** authMode → 取数顺序。auto：sk- 渠道 key 先走 compat，否则先走 native。 */
  function authModeOrder(config, secret) {
    if (config.authMode === 'native') return ['native']
    if (config.authMode === 'compat') return ['compat']
    const text = typeof secret === 'string' ? secret.trim().toLowerCase() : ''
    return text.startsWith('sk-') ? ['compat', 'native'] : ['native', 'compat']
  }

  /**
   * task-9 / 宿主 `credentials` 服务契约（"must not cache across operations"）：
   * 判断一次取数是否**整体因鉴权失败而失败** —— 尝试过的每个 authMode 都是 401/403。
   *
   * @param attempts - `collectUpstream` 的 attempts。
   * @returns 全部尝试都是鉴权失败时为 true。
   */
  function isAuthFailureOnly(attempts) {
    if (!Array.isArray(attempts) || attempts.length === 0) return false
    return attempts.every((item) => item !== null
      && typeof item === 'object'
      && (item.code === 'HTTP_401' || item.code === 'HTTP_403'))
  }

  function summarizeAttempt(mode, result) {
    return {
      mode,
      ok: result.ok === true,
      code: result.ok === true ? null : result.code ?? 'SHAPE',
      httpStatus: isFiniteNumber(result.httpStatus) ? result.httpStatus : null,
      withUserHeader: mode === 'native' && result.ok === true ? result.withUserHeader === true : null,
    }
  }

  /**
   * 取上游数据：`/api/status` + native/compat 二选一（按 authMode 顺序试）。
   *
   * @param config - 生效配置。
   * @param secret - 凭据明文（可能为 null）。
   * @param options - `{ deadline?: number }` 路由路径上的总预算（epoch ms）。
   * @returns 归一化前的原始素材。
   */
  async function collectUpstream(config, secret, options = {}) {
    const deadline = isFiniteNumber(options.deadline) ? options.deadline : null
    // 路由路径上给上游的总预算：按「还剩多少」切片，并给 relay status 最多一半，
    // 保证后面的取数请求不会被一个慢的 /api/status 挤成 500ms 超时。
    const budget = (share = 1) => {
      if (deadline === null) return config.requestTimeoutMs
      const left = Math.max(0, deadline - Date.now())
      return Math.max(300, Math.min(config.requestTimeoutMs, Math.floor(left / share)))
    }
    const relay = await fetchRelayStatus(config.baseUrl, { timeoutMs: budget(2) })
    const modes = authModeOrder(config, secret)
    const attempts = []
    let native = null
    let compat = null
    let chosen = null
    if (typeof secret !== 'string' || secret === '') {
      const noCredential = { ok: false, code: 'NO_CREDENTIAL', error: '未配置凭据（credentialRef/候选都解析不到值）' }
      if (modes[0] === 'native') native = noCredential
      else compat = noCredential
      attempts.push({ mode: modes[0], ok: false, code: 'NO_CREDENTIAL', httpStatus: null, withUserHeader: null })
    } else {
      for (const mode of modes) {
        if (mode === 'native') {
          const result = await fetchNativeUser(config.baseUrl, {
            token: secret,
            userId: config.userId,
            timeoutMs: budget(),
          })
          native = result
          attempts.push(summarizeAttempt('native', result))
          if (result.ok === true) {
            chosen = 'native'
            break
          }
        } else {
          const result = await fetchCompat(config.baseUrl, { apiKey: secret, timeoutMs: budget() })
          compat = result
          attempts.push(summarizeAttempt('compat', result))
          if (result.ok === true) {
            chosen = 'compat'
            break
          }
        }
      }
    }
    return { relay, relayStatus: relay.ok === true ? relay.status : null, native, compat, chosen, attempts, modes }
  }

  function relaySummary(relay) {
    if (relay.ok !== true) {
      return {
        ok: false,
        code: relay.code ?? 'SHAPE',
        error: relay.error ?? '取 /api/status 失败',
        httpStatus: isFiniteNumber(relay.httpStatus) ? relay.httpStatus : null,
        baseUrl: state.config.baseUrl,
        at: Date.now(),
      }
    }
    return {
      ok: true,
      code: null,
      error: null,
      httpStatus: null,
      baseUrl: state.config.baseUrl,
      at: Date.now(),
      version: relay.status.version,
      systemName: relay.status.systemName,
      quotaPerUnit: relay.status.quotaPerUnit,
      usdExchangeRate: relay.status.usdExchangeRate,
      displayInCurrency: relay.status.displayInCurrency,
      quotaDisplayType: relay.status.quotaDisplayType,
      customCurrencySymbol: relay.status.customCurrencySymbol,
      customCurrencyExchangeRate: relay.status.customCurrencyExchangeRate,
    }
  }

  /** 取一次余额并归一（SPEC §5.1.1），顺带刷新 `state.upstream`/`state.balance`。 */
  async function refreshBalance(config, options = {}) {
    const credential = await resolveCredential(config, { force: options.forceCredential === true })
    const upstream = await collectUpstream(config, credential.value, options)
    // task-9：宿主 credentials 契约要求"不得跨操作缓存凭据"（changed credential must reach the
    // next operation without a restart）。但每个请求都打凭据服务又没必要，所以折中：
    // **成功路径继续用缓存**；只有「所有 authMode 都因 401/403 失败」时才作废缓存 ——
    // 这种整体鉴权失败最常见的成因就是用户刚改过同一个 ref 名下的值（令牌轮换/纠错），
    // 下一轮自动同步（≤syncIntervalSeconds）即可拿到新值，无需重启宿主。
    if (upstream.chosen === null && isAuthFailureOnly(upstream.attempts)) {
      credentialValue = null
      credentialCache = null
      credentialInvalidations += 1
      credentialCacheInvalidatedAt = Date.now()
      pushWarning(
        '上游鉴权失败（所有 authMode 均 HTTP_401/403）：已作废凭据缓存，'
        + `下一次 /balance 或下一轮同步会重新解析凭据（若刚改动过 ref「${config.credentialRef}」的值，无需重启宿主）。`,
      )
    }
    const modeForNormalize = upstream.chosen ?? upstream.modes[0]
    const balance = normalizeBalance({
      mode: modeForNormalize,
      native: upstream.native,
      compat: upstream.compat,
      status: upstream.relayStatus,
      config,
    })
    state.upstream = {
      relay: relaySummary(upstream.relay),
      auth: {
        requestedMode: config.authMode,
        usedMode: upstream.chosen,
        credentialRef: credential.ref,
        credentialSource: credential.source,
        attempts: upstream.attempts,
      },
      fetchedAt: Date.now(),
    }
    state.balance = balance
    state.balanceAt = Date.now()
    return balance
  }

  /** `/balance` 用的余额：5s 短缓存 + 并发去重 + 路由总预算。 */
  async function currentBalance(config) {
    if (state.balance !== null && Date.now() - state.balanceAt < BALANCE_CACHE_MS) return state.balance
    if (balanceInFlight !== null) return balanceInFlight
    balanceInFlight = (async () => {
      try {
        return await refreshBalance(config, { deadline: Date.now() + ROUTE_DEADLINE_MS })
      } finally {
        balanceInFlight = null
      }
    })()
    return balanceInFlight
  }

  /** 桥自检：`GET <base>/dsh-whale-newapi/health`，结果如实进 `/status`。 */
  async function selfCheckBridge(baseUrl) {
    const at = Date.now()
    if (typeof baseUrl !== 'string' || baseUrl === '') {
      return { ok: false, httpStatus: null, error: '桥地址未探测到', at }
    }
    const res = await requestJson(`${baseUrl}${PATHS.health}`, { timeoutMs: SELF_CHECK_TIMEOUT_MS })
    if (res.ok !== true) {
      return {
        ok: false,
        httpStatus: isFiniteNumber(res.httpStatus) ? res.httpStatus : null,
        error: redact(res.error ?? '自检请求失败'),
        at,
      }
    }
    const payload = res.json
    const healthy = payload !== null
      && typeof payload === 'object'
      && payload.ok === true
      && payload.name === name
    return {
      ok: healthy,
      httpStatus: isFiniteNumber(res.httpStatus) ? res.httpStatus : null,
      error: healthy ? null : '自检响应形状不符（期望 {ok:true,name:"dsh-whale-newapi-bridge"}）',
      at,
    }
  }

  /** 载入 bridge 的注册表/契约模块（缺文件时抛，由 sync 吞掉并记状态）。 */
  async function loadBridgeModules() {
    if (bridgeModules !== null) return bridgeModules
    const [registry, contract] = await Promise.all([
      import('./whale-registry.mjs'),
      import('./whale-contract.mjs'),
    ])
    const missing = []
    for (const fn of ['resolveWhaleApiFile', 'readWhaleRegistry', 'upsertWhaleEntry', 'removeWhaleEntry', 'writeWhaleRegistryAtomic']) {
      if (typeof registry?.[fn] !== 'function') missing.push(`whale-registry.${fn}`)
    }
    for (const fn of ['buildWhaleEntry']) {
      if (typeof contract?.[fn] !== 'function') missing.push(`whale-contract.${fn}`)
    }
    if (missing.length > 0) throw new Error(`bridge 模块缺少导出：${missing.join(', ')}`)
    bridgeModules = { registry, contract }
    return bridgeModules
  }

  function resolveRegistryFile(registry) {
    const dshHome = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
      ? process.env.DSH_HOME
      : path.join(os.homedir(), '.dsh')
    try {
      const file = registry.resolveWhaleApiFile(dshHome)
      if (typeof file === 'string' && file !== '') return file
    } catch (err) {
      noteError('resolveWhaleApiFile', err)
    }
    return path.join(dshHome, '.dshw-api.json')
  }

  /**
   * 校验并落地 `POST /sync` 的覆盖参数（SPEC §6.3：只接受 4 个键）。
   *
   * @param config - 当前配置。
   * @param overrides - 请求体对象。
   * @param localWarnings - 收集 warning。
   * @param hardErrors - 收集必须整单拒绝的原因（SPEC §10.2：非回环 bridgeBaseUrl → 400 且不写注册表）。
   * @returns 本次生效的配置。
   */
  function applyOverrides(config, overrides, localWarnings, hardErrors) {
    const effective = { ...config, credentialCandidates: [...config.credentialCandidates] }
    if (overrides === null || typeof overrides !== 'object') return effective
    const unknown = Object.keys(overrides).filter((key) => !SYNC_OVERRIDE_KEYS.includes(key))
    if (unknown.length > 0) localWarnings.push(`忽略 /sync 不认识的参数：${unknown.join(', ')}`)
    if (overrides.bridgeBaseUrl !== undefined) {
      if (overrides.bridgeBaseUrl === '') {
        effective.bridgeBaseUrl = ''
      } else {
        // SPEC §10.2：覆盖值也必须回环，否则整单 400（条目 balance.url 决定挂件把凭据发往哪里）
        const loopback = normalizeLoopbackBaseUrl(overrides.bridgeBaseUrl)
        if (loopback !== null) {
          effective.bridgeBaseUrl = loopback
        } else {
          const reason = explainLoopbackBaseUrl(overrides.bridgeBaseUrl) ?? '不是回环 origin'
          hardErrors.push(`/sync 的 bridgeBaseUrl 被拒绝（SPEC §10.2：只允许回环 origin；${reason}）`)
        }
      }
    }
    if (overrides.credentialRef !== undefined) {
      const ref = typeof overrides.credentialRef === 'string' ? overrides.credentialRef.trim() : ''
      if (/^[A-Za-z0-9_]+$/.test(ref)) {
        effective.credentialRef = ref
        effective.credentialCandidates = [ref, ...config.credentialCandidates.filter((item) => item !== ref)]
      } else {
        localWarnings.push('/sync 的 credentialRef 只允许 [A-Za-z0-9_]，已忽略')
      }
    }
    if (overrides.modelId !== undefined) {
      const modelId = typeof overrides.modelId === 'string' ? overrides.modelId.trim() : ''
      if (/^[A-Za-z0-9_-]+$/.test(modelId)) effective.modelId = modelId
      else localWarnings.push('/sync 的 modelId 只允许 [A-Za-z0-9_-]，已忽略')
    }
    if (overrides.fallbackTotal !== undefined) {
      const total = Number(overrides.fallbackTotal)
      if (Number.isFinite(total) && total >= 0) effective.fallbackTotal = total
      else localWarnings.push('/sync 的 fallbackTotal 必须是非负有限数值，已忽略')
    }
    return effective
  }

  /** 我们的条目从注册表里移除（`enabled:false` 时用）。 */
  async function removeOurEntry(startedAt, localWarnings) {
    let modules
    try {
      modules = await loadBridgeModules()
    } catch (err) {
      noteError('loadBridgeModules', err)
      localWarnings.push(`bridge 模块不可用，未清理条目：${err.message}`)
      return { ok: false, changed: false, mode: null, entry: null, syncAt: startedAt, balance: state.balance, warnings: localWarnings }
    }
    const file = resolveRegistryFile(modules.registry)
    state.whale.registryFile = file
    state.whale.id = state.config.modelId
    const read = modules.registry.readWhaleRegistry(file)
    state.whale.registryOk = read !== null && typeof read === 'object' && read.ok === true
    if (state.whale.registryOk !== true) {
      localWarnings.push(`注册表读取失败，未清理条目：${redact(read?.error ?? '未知错误')}`)
      return { ok: false, changed: false, mode: null, entry: null, syncAt: startedAt, balance: state.balance, warnings: localWarnings }
    }
    const removed = modules.registry.removeWhaleEntry(read.registry, state.config.modelId)
    const changed = removed !== null && typeof removed === 'object' && removed.changed === true
    state.whale.entry = null
    state.whale.mode = null
    state.whale.changed = changed
    if (!changed) return { ok: true, changed: false, mode: null, entry: null, syncAt: startedAt, balance: state.balance, warnings: localWarnings }
    const written = modules.registry.writeWhaleRegistryAtomic(file, removed.registry)
    if (written === null || typeof written !== 'object' || written.ok !== true) {
      localWarnings.push(`注册表写入失败：${redact(written?.error ?? '未知错误')}`)
      return { ok: false, changed: false, mode: null, entry: null, syncAt: startedAt, balance: state.balance, warnings: localWarnings }
    }
    if (typeof written.backupPath === 'string') state.whale.backupPath = written.backupPath
    return { ok: true, changed: true, mode: null, entry: null, syncAt: startedAt, balance: state.balance, warnings: localWarnings }
  }

  /** 一次完整同步：探测桥 → 取自检 → 取余额 → 建条目 → 读注册表 → （有变化才）原子写。 */
  async function doSync(overrides, startedAt) {
    const localWarnings = []
    const hardErrors = []
    const effective = applyOverrides(state.config, overrides, localWarnings, hardErrors)
    if (hardErrors.length > 0) {
      // SPEC §10.2：整单拒绝 —— 在探测/取数/写注册表**之前**返回，保证注册表一字未动。
      for (const message of hardErrors) localWarnings.push(message)
      return {
        ok: false,
        changed: false,
        badRequest: true,
        mode: state.whale.mode,
        entry: state.whale.entry,
        syncAt: startedAt,
        balance: state.balance,
        warnings: localWarnings,
      }
    }
    if (effective.enabled !== true) return removeOurEntry(startedAt, localWarnings)

    // 桥地址探测 + 自检（每次都重新探测：SPEC §6.3「强制重新探测」）
    const probe = resolveBridgeBaseUrl(effective, {
      // spec-v2 §10.6：宿主 Web 服务的实时 origin（监听前会抛 → liveOrigin 返回 null 交给下一候选）
      getOrigin: () => ctx.webServer?.getOrigin?.(),
    })
    state.bridge.baseUrl = probe.baseUrl
    state.bridge.probeSource = probe.source
    for (const warning of probe.warnings) localWarnings.push(warning)
    const selfCheck = await selfCheckBridge(probe.baseUrl)
    state.bridge.selfCheck = selfCheck
    if (selfCheck.ok !== true) {
      localWarnings.push(`桥自检未通过：GET ${PATHS.health} @ ${probe.baseUrl} → ${selfCheck.error ?? 'HTTP ' + selfCheck.httpStatus}`)
    }

    // 余额（SPEC §10.3：候选回退时每次同步都重新解析凭据；credentialRef 覆盖也强制重解析）
    const balance = await refreshBalance(effective, {
      forceCredential: overrides?.credentialRef !== undefined || credentialNeedsRefresh(effective),
    })
    if (balance.ok !== true) {
      localWarnings.push(`上游取数失败（${balance.code}）：${balance.error}；本次不改写注册表`)
      return {
        ok: false,
        changed: false,
        mode: state.whale.mode,
        entry: state.whale.entry,
        syncAt: startedAt,
        balance,
        warnings: localWarnings,
      }
    }

    // bridge 模块
    let modules
    try {
      modules = await loadBridgeModules()
    } catch (err) {
      noteError('loadBridgeModules', err)
      localWarnings.push(`bridge 模块不可用（${redact(err.message)}）；待 lib/whale-registry.mjs 与 lib/whale-contract.mjs 就绪后重试`)
      return { ok: false, changed: false, mode: null, entry: null, syncAt: startedAt, balance, warnings: localWarnings }
    }

    // matchIds：实时取 /v1/models；取不到用 SPEC §1 的已知列表兜底
    let matchIds = []
    if (typeof credentialValue === 'string' && credentialValue !== '') {
      const models = await fetchModelIds(effective.baseUrl, {
        apiKey: credentialValue,
        timeoutMs: effective.requestTimeoutMs,
      })
      if (models.ok === true) matchIds = models.ids
      else localWarnings.push(`/v1/models 取模型列表失败（${models.code ?? 'SHAPE'}），matchIds 使用兜底列表`)
    } else {
      localWarnings.push('无凭据，matchIds 使用兜底列表')
    }
    if (matchIds.length === 0) matchIds = [...MATCH_IDS_FALLBACK]

    const remainingIsNumber = isFiniteNumber(balance.remaining)
    const derivedMode = remainingIsNumber ? 'balance' : 'events'
    if (derivedMode === 'events' && balance.unlimited === true) {
      localWarnings.push(
        '上游报告无限额度（UNLIMITED_SENTINEL / unlimited_quota）且 fallbackTotal=0：条目降级为 events 模式，'
        + '挂件显示「余额 —」并仅按本机会话估算今日已用。'
        + '要显示真实余额：配置 fallbackTotal（人工额度，remaining = fallbackTotal - 累计已用），'
        + '或改用用户系统访问令牌（PAT）走 authMode=native 查 /api/user/self',
      )
    }
    const ctxInfo = {
      bridgeUrl: probe.baseUrl,
      credentialRef: state.credential.ref,
      modelId: effective.modelId,
      modelName: effective.modelName,
      currency: effective.currency,
      matchIds,
      relayBaseUrl: effective.baseUrl,
    }
    const cfgForBridge = {
      ...effective,
      balance,
      balanceOk: true,
      unlimited: balance.unlimited === true,
      balanceMode: derivedMode,
    }

    let built
    try {
      built = modules.contract.buildWhaleEntry(cfgForBridge, ctxInfo)
    } catch (err) {
      noteError('buildWhaleEntry', err)
      localWarnings.push(`buildWhaleEntry 抛错：${redact(err.message)}；未改写注册表`)
      return { ok: false, changed: false, mode: null, entry: null, syncAt: startedAt, balance, warnings: localWarnings }
    }
    const entry = built !== null && typeof built === 'object' ? built.entry ?? null : null
    if (entry === null || typeof entry !== 'object') {
      localWarnings.push('buildWhaleEntry 未返回可用的 entry；未改写注册表')
      return { ok: false, changed: false, mode: null, entry: null, syncAt: startedAt, balance, warnings: localWarnings }
    }
    const mode = built.mode === 'balance' || built.mode === 'events' ? built.mode : derivedMode
    if (built.mode !== undefined && built.mode !== derivedMode) {
      localWarnings.push(`buildWhaleEntry 的 mode=${built.mode} 与余额口径推导的 ${derivedMode} 不同，以 buildWhaleEntry 为准`)
    }
    for (const warning of Array.isArray(built.warnings) ? built.warnings : []) {
      if (typeof warning === 'string' && warning !== '') localWarnings.push(redact(warning))
    }

    // 注册表：读成功才写；changed===false 不落盘
    const file = resolveRegistryFile(modules.registry)
    state.whale.id = typeof entry.id === 'string' ? entry.id : effective.modelId
    state.whale.registryFile = file
    state.whale.entry = entry
    state.whale.mode = mode
    const read = modules.registry.readWhaleRegistry(file)
    state.whale.registryOk = read !== null && typeof read === 'object' && read.ok === true
    if (state.whale.registryOk !== true) {
      localWarnings.push(`注册表读取失败（${redact(read?.error ?? '未知错误')}）；按 SPEC §7.4 不写入`)
      return { ok: false, changed: false, mode, entry, syncAt: startedAt, balance, warnings: localWarnings }
    }
    const upsert = modules.registry.upsertWhaleEntry(read.registry, entry)
    const changed = upsert !== null && typeof upsert === 'object' && upsert.changed === true
    state.whale.changed = changed
    if (!changed) {
      return { ok: true, changed: false, mode, entry, syncAt: startedAt, balance, warnings: localWarnings }
    }
    const written = modules.registry.writeWhaleRegistryAtomic(file, upsert.registry)
    if (written === null || typeof written !== 'object' || written.ok !== true) {
      localWarnings.push(`注册表写入失败：${redact(written?.error ?? '未知错误')}`)
      return { ok: false, changed: false, mode, entry, syncAt: startedAt, balance, warnings: localWarnings }
    }
    if (typeof written.backupPath === 'string') state.whale.backupPath = written.backupPath
    return { ok: true, changed: true, mode, entry, syncAt: startedAt, balance, warnings: localWarnings }
  }

  /** 同步入口：永不抛出；结果与触发者都进内部状态。 */
  async function runSync(trigger, overrides = {}) {
    const startedAt = Date.now()
    if (syncInFlight) {
      return {
        ok: false,
        changed: false,
        mode: state.whale.mode,
        entry: state.whale.entry,
        syncAt: startedAt,
        balance: state.balance,
        warnings: ['已有同步在进行，本次跳过'],
      }
    }
    syncInFlight = true
    let result
    try {
      result = await doSync(overrides, startedAt)
    } catch (err) {
      noteError('sync', err)
      result = {
        ok: false,
        changed: false,
        mode: state.whale.mode,
        entry: state.whale.entry,
        syncAt: startedAt,
        balance: state.balance,
        warnings: [`同步异常：${redact(err && err.message !== undefined ? err.message : err)}`],
      }
    } finally {
      syncInFlight = false
    }
    state.whale.lastSyncAt = startedAt
    state.whale.lastSyncResult = result
    state.whale.lastSyncTrigger = String(trigger)
    for (const warning of Array.isArray(result.warnings) ? result.warnings : []) pushWarning(warning)
    return result
  }

  // ── 路由 ──────────────────────────────────────────────────────────────────

  function wrap(handler) {
    return (req, res) => {
      Promise.resolve()
        .then(() => handler(req, res))
        .catch((err) => {
          noteError('route', err)
          sendJson(res, 500, { ok: false, code: 'INTERNAL', error: '插件内部错误（详见 /status 的 internal.errors）' })
        })
    }
  }

  /**
   * 取出请求携带的凭据值：`Authorization: Bearer <v>` 或 `?token=<v>`。
   *
   * @param req - node:http 请求。
   * @returns 字符串或 null。
   */
  function providedToken(req) {
    let query = null
    try {
      query = new URL(req.url ?? '/', 'http://dsh.internal')
    } catch {
      query = null
    }
    return bearerOf(req) ?? query?.searchParams.get('token') ?? null
  }

  /**
   * SPEC §6.1 + §10.1：`/balance` 与 `/sync` 同鉴权 —— 恒定时间比较 Bearer，失败 `401`。
   *
   * 会先按 §10.3 的规则决定是否重新解析凭据（候选回退时必须重新解析），
   * 因此「首选凭据后来出现」能被立即接管，`/sync` 也会用新凭据校验。
   *
   * @param req - node:http 请求。
   * @param config - 本次生效的配置。
   * @returns `{ok:true,credential}` 或 `{ok:false,status,payload}`。
   */
  async function authorize(req, config) {
    const credential = await resolveCredential(config, { force: credentialNeedsRefresh(config) })
    if (credential.value === null) {
      return { ok: false, status: 401, payload: { ok: false, code: 'NO_CREDENTIAL', error: '插件未解析到凭据，无法校验 Bearer' } }
    }
    if (!secretEquals(providedToken(req) ?? '', credential.value)) {
      return { ok: false, status: 401, payload: { ok: false, code: 'UNAUTHORIZED', error: 'Bearer 凭据不匹配' } }
    }
    return { ok: true, credential }
  }

  async function handleHealth(req, res) {
    if (!fence(req)) return forbidden(res)
    if (methodNotAllowed(req, res, 'GET')) return
    return sendJson(res, 200, { ok: true, name, version: PLUGIN_VERSION, enabled: state.config.enabled === true })
  }

  async function handleBalance(req, res) {
    if (!fence(req)) return forbidden(res)
    if (methodNotAllowed(req, res, 'GET')) return
    const config = state.config
    if (config.enabled !== true) {
      return sendJson(res, 503, { ok: false, code: 'DISABLED', error: '插件已禁用（config.enabled=false）' })
    }
    const auth = await authorize(req, config)
    if (auth.ok !== true) return sendJson(res, auth.status, auth.payload)
    const balance = await currentBalance(config)
    if (balance.ok !== true) {
      return sendJson(res, 200, { ok: false, code: balance.code ?? 'SHAPE', error: balance.error ?? '余额获取失败' })
    }
    if (!isFiniteNumber(balance.remaining)) {
      if (balance.unlimited === true) {
        // SPEC §10.5：区分「真是无限额度」与「credits 触发荒诞值护栏」，别让诊断信息误导用户
        const guarded = balance.detail?.sanityGuard !== undefined
        return sendJson(res, 200, {
          ok: false,
          code: 'UNLIMITED',
          error: guarded
            ? '上游 credits 触发荒诞值护栏（SPEC §10.5：credits<=0 或超出 100 万面板单位），未提供数值余额，且未配置 fallbackTotal（条目已降级为 events 模式）'
            : '无限额度：上游未提供数值余额，且未配置 fallbackTotal（条目已降级为 events 模式）',
        })
      }
      return sendJson(res, 200, { ok: false, code: 'SHAPE', error: '上游未给出数值余额' })
    }
    return sendJson(res, 200, {
      ok: true,
      remaining: balance.remaining,
      currency: balance.currency,
      total: balance.total ?? null,
      used: balance.used ?? null,
      unlimited: balance.unlimited === true,
      source: balance.source,
      fetchedAt: balance.fetchedAt,
      label: config.modelName,
      note: balance.detail?.note ?? '',
    })
  }

  function statusPayload() {
    return {
      ok: true,
      version: PLUGIN_VERSION,
      config: publicConfig(state.config),
      credential: {
        ref: state.credential.ref,
        present: state.credential.present === true,
        source: state.credential.source,
      },
      upstream: state.upstream,
      balance: state.balance,
      whale: {
        id: state.whale.id,
        mode: state.whale.mode,
        entry: state.whale.entry,
        registryFile: state.whale.registryFile,
        registryOk: state.whale.registryOk,
        lastSyncAt: state.whale.lastSyncAt,
        lastSyncResult: state.whale.lastSyncResult,
        changed: state.whale.changed,
        backupPath: state.whale.backupPath,
      },
      bridge: {
        baseUrl: state.bridge.baseUrl,
        selfCheck: state.bridge.selfCheck,
      },
      settings: {
        file: state.settings.file,
        persistedKeys: [...state.settings.keys],
      },
      warnings: [...warnings],
      internal: {
        startedAt: state.startedAt,
        schemaSource: SCHEMASTERMY_SOURCE,
        credentialCandidatesTried: state.credential.tried ?? [],
        credentialResolveCalls,
        credentialCacheHits,
        credentialInvalidations,
        credentialCacheInvalidatedAt,
        bridgeProbeSource: state.bridge.probeSource,
        lastSyncTrigger: state.whale.lastSyncTrigger,
        syncIntervalSeconds: state.config.syncIntervalSeconds,
        autoSync: state.config.autoSync,
        errors: [...errors],
      },
    }
  }

  /** 设置页可编辑的「生效配置」原始值（含真实 userId 供表单回填；凭据只有名字，没有值）。 */
  function editableConfig() {
    const config = state.config
    const out = {}
    for (const key of PERSISTED_KEYS) {
      out[key] = Array.isArray(config[key]) ? [...config[key]] : config[key]
    }
    return out
  }

  /** 设置文件里实际持久化的覆盖项（键序固定，未知键不出现）。 */
  function persistedSnapshot() {
    const out = {}
    for (const key of PERSISTED_KEYS) {
      if (Object.prototype.hasOwnProperty.call(state.settings.values, key)) out[key] = state.settings.values[key]
    }
    return out
  }

  /** GET /settings 的响应（SPEC §6.5）：表单数据 + 最近同步/凭据/余额 + warnings。 */
  function settingsPayload() {
    return {
      ok: true,
      version: PLUGIN_VERSION,
      config: editableConfig(),
      persisted: persistedSnapshot(),
      settingsPath: state.settings.file,
      sync: {
        lastSyncAt: state.whale.lastSyncAt,
        lastSyncResult: state.whale.lastSyncResult,
        lastSyncTrigger: state.whale.lastSyncTrigger,
      },
      credential: {
        ref: state.credential.ref,
        present: state.credential.present === true,
        source: state.credential.source,
      },
      balance: state.balance,
      warnings: [...warnings],
    }
  }

  /**
   * 应用一份设置补丁（SPEC §6.5 / §4.7）：
   * 校验 → 合并覆盖层 → 原子写设置文件 → 重新归一化配置（热生效）→ 重排定时器 → 触发一次同步。
   *
   * 写文件失败时 `state.config` 保持不变，由调用方回 500。
   * 校验失败时不写文件、不改配置，返回全部字段级错误。
   */
  function applySettingsPatch(patch) {
    const validation = validateSettingsPatch(patch)
    if (validation.ok !== true) return { ok: false, code: 'BAD_SETTINGS', errors: validation.errors }
    const values = { ...state.settings.values, ...validation.patch }
    const file = state.settings.file ?? resolveSettingsPath()
    const written = saveSettings(file, values)
    if (written.ok !== true) return { ok: false, code: 'SAVE_FAILED', error: written.error }
    state.settings.file = file
    state.settings.values = values
    state.settings.keys = PERSISTED_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(values, key))
    const normalized = normalizeConfig({ ...baseConfig, ...values })
    state.config = normalized.config
    for (const warning of normalized.warnings) pushWarning(warning)
    restartTimer()
    void runSync('settings')
    return {
      ok: true,
      applied: Object.keys(validation.patch),
      config: editableConfig(),
      persisted: persistedSnapshot(),
      warnings: [...warnings],
    }
  }

  /**
   * /settings（同一路径同时支持读写，SPEC §6.5）：
   * - `GET`  → 200 当前生效配置 + 状态（仅回环 + 同源栅栏）；
   * - `POST` → 200 保存成功 / 400 BAD_SETTINGS / 500 SAVE_FAILED；
   * - 其它方法 → 405。
   */
  async function handleSettings(req, res) {
    if (!fence(req)) return forbidden(res)
    const method = String(req.method || 'GET').toUpperCase()
    if (method === 'GET') return sendJson(res, 200, settingsPayload())
    if (method !== 'POST') {
      return sendJson(res, 405, { ok: false, code: 'METHOD', error: '只支持 GET / POST' })
    }
    const body = await readJsonBody(req)
    if (body.ok !== true) {
      return sendJson(res, 400, { ok: false, code: 'BAD_REQUEST', error: body.error })
    }
    const result = applySettingsPatch(body.value)
    if (result.ok !== true) {
      if (result.code === 'SAVE_FAILED') {
        return sendJson(res, 500, { ok: false, code: 'SAVE_FAILED', error: result.error })
      }
      const fields = {}
      for (const error of result.errors) fields[error.key] = error.message
      return sendJson(res, 400, {
        ok: false,
        code: 'BAD_SETTINGS',
        error: '设置校验失败，未写入任何改动',
        fields,
      })
    }
    return sendJson(res, 200, {
      ok: true,
      config: result.config,
      persisted: result.persisted,
      applied: result.applied,
      warnings: result.warnings,
    })
  }

  /** POST /settings/reset（SPEC §6.5）：删除设置文件并回退到 yml/默认值，热生效。 */
  async function handleSettingsReset(req, res) {
    if (!fence(req)) return forbidden(res)
    if (methodNotAllowed(req, res, 'POST')) return
    const file = state.settings.file ?? resolveSettingsPath()
    const removed = deleteSettingsFile(file)
    if (removed.ok !== true) {
      return sendJson(res, 500, { ok: false, code: 'SAVE_FAILED', error: removed.error })
    }
    state.settings = { file, values: {}, keys: [] }
    const normalized = normalizeConfig({ ...baseConfig })
    state.config = normalized.config
    for (const warning of normalized.warnings) pushWarning(warning)
    restartTimer()
    return sendJson(res, 200, { ok: true, config: editableConfig(), persisted: {} })
  }

  async function handleStatus(req, res) {
    if (!fence(req)) return forbidden(res)
    if (methodNotAllowed(req, res, 'GET')) return
    let payload
    try {
      payload = statusPayload()
    } catch (err) {
      noteError('status', err)
      payload = { ok: false, version: PLUGIN_VERSION, error: redact(err.message) }
    }
    return sendJson(res, 200, payload)
  }

  async function handleSync(req, res) {
    if (!fence(req)) return forbidden(res)
    if (methodNotAllowed(req, res, 'POST')) return
    // SPEC §10.1：/sync 会改写挂件的凭据目的地，必须与 /balance 同鉴权
    const auth = await authorize(req, state.config)
    if (auth.ok !== true) return sendJson(res, auth.status, auth.payload)
    // 先读完 body 再判 enabled：否则 503 早返回会留下未消费的请求体
    const body = await readJsonBody(req)
    if (state.config.enabled !== true) {
      return sendJson(res, 503, { ok: false, code: 'DISABLED', error: '插件已禁用（config.enabled=false）' })
    }
    if (body.ok !== true) {
      return sendJson(res, 400, { ok: false, code: 'BAD_REQUEST', error: body.error })
    }
    const result = await runSync('route:/sync', body.value)
    // SPEC §10.2：非回环 bridgeBaseUrl 覆盖 → 400（且 doSync 未改写注册表）
    const status = result.badRequest === true ? 400 : 200
    return sendJson(res, status, {
      ok: result.ok === true,
      changed: result.changed === true,
      mode: result.mode ?? null,
      entry: result.entry ?? null,
      syncAt: result.syncAt,
      balance: result.balance ?? null,
      warnings: result.warnings ?? [],
    })
  }

  function registerRoute(pathname, kind, handler) {
    try {
      ctx.effect(() => {
        try {
          const disposer = ctx.webServer.register({ kind, path: pathname, handler: wrap(handler) })
          return () => {
            try {
              if (typeof disposer === 'function') disposer()
            } catch (err) {
              noteError(`dispose:${pathname}`, err)
            }
          }
        } catch (err) {
          noteError(`register:${pathname}`, err)
          pushWarning(`路由注册失败（${pathname}）：${redact(err.message)}`)
          return () => {}
        }
      }, `dsh-whale-newapi-bridge: ${pathname}`)
      return true
    } catch (err) {
      noteError(`effect:${pathname}`, err)
      pushWarning(`ctx.effect 注册失败（${pathname}）：${redact(err.message)}`)
      return false
    }
  }

  /** 停掉周期同步（幂等；ctx 销毁时的 effect 清理也走这里）。 */
  function stopTimer() {
    if (timer === null) return
    try {
      clearInterval(timer)
    } catch (err) {
      noteError('timer-clear', err)
    }
    timer = null
  }

  /**
   * 启动/重启周期同步（按 `state.config` 当前值，SPEC §4.7 热生效）。
   *
   * 只注册**一次** `ctx.effect`：后续改间隔只替换 interval，不重复注册 effect；
   * effect 的清理函数读闭包里的 `timer`，因此不会误清掉热更新后新建的定时器。
   */
  function startTimer() {
    stopTimer()
    if (state.config.autoSync !== true || state.config.enabled !== true) return
    const intervalMs = Math.max(5, state.config.syncIntervalSeconds) * 1000
    try {
      if (timerEffectInstalled !== true) {
        ctx.effect(() => () => stopTimer(), 'dsh-whale-newapi-bridge: periodic sync')
        timerEffectInstalled = true
      }
      timer = setInterval(() => {
        void runSync('interval')
      }, intervalMs)
      if (timer && typeof timer.unref === 'function') timer.unref()
    } catch (err) {
      noteError('timer', err)
      pushWarning(`周期同步未启动：${redact(err.message)}`)
    }
  }

  /** 设置保存/重置后重排定时器（禁用时停表；间隔取新配置）。 */
  function restartTimer() {
    startTimer()
  }

  /**
   * 启动（同步部分）：解析配置（设置文件 > yml > 默认）、注册 6 条路由、启动定时器。
   */
  function start() {
    state.startedAt = Date.now()
    baseConfig = rawConfig !== null && typeof rawConfig === 'object' && !Array.isArray(rawConfig) ? { ...rawConfig } : {}
    const settingsFile = resolveSettingsPath()
    const read = readSettingsFile(settingsFile)
    for (const warning of read.warnings ?? []) pushWarning(warning)
    if (read.ok !== true && typeof read.error === 'string') pushWarning(read.error)
    /** 设置文件里通过逐键校验的覆盖项；坏键丢弃并告警（该键退回 yml/默认值）。 */
    const persisted = {}
    for (const key of Object.keys(read.values ?? {})) {
      const single = { [key]: read.values[key] }
      const validation = validateSettingsPatch(single)
      if (validation.ok === true) {
        persisted[key] = validation.patch[key]
        continue
      }
      const reason = validation.errors.map((item) => item.message).join('；') || '值不合法'
      pushWarning(`设置文件里的 ${key} 不合法（${reason}），已退回 yml 的值`)
    }
    state.settings = {
      file: settingsFile,
      values: persisted,
      keys: PERSISTED_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(persisted, key)),
    }
    const normalized = normalizeConfig({ ...baseConfig, ...persisted })
    state.config = normalized.config
    for (const warning of normalized.warnings) pushWarning(warning)
    if (normalized.config.authMode === 'auto') {
      pushWarning('authMode=auto：sk- 渠道 key 会先走 compat（billing），其它令牌先走 native（/api/user/self）')
    }
    const registered = [
      registerRoute(PATHS.health, 'exact', handleHealth),
      registerRoute(PATHS.balance, 'exact', handleBalance),
      registerRoute(PATHS.status, 'exact', handleStatus),
      registerRoute(PATHS.sync, 'exact', handleSync),
      // /settings 由同一个 handler 分派 GET（读）与 POST（写），因此只注册一条路由。
      registerRoute(PATHS.settings, 'exact', handleSettings),
      registerRoute(PATHS.settingsReset, 'exact', handleSettingsReset),
    ].filter(Boolean).length
    if (registered !== 6) pushWarning(`只注册成功 ${registered}/6 条路由（路径冲突或 webServer 不可用）`)
    startTimer()
    return { registered }
  }

  /** 启动（异步部分，fire-and-forget）：首次同步。任何异常都被吞进内部状态。 */
  function runInitialSync() {
    void (async () => {
      try {
        await runSync(state.config.enabled === true ? 'startup' : 'startup-disabled')
      } catch (err) {
        noteError('initial-sync', err)
      }
    })()
  }

  return { state, warnings, errors, start, runInitialSync, runSync, statusPayload, fence, secretEquals }
}

/**
 * cordis 插件入口。**永不抛出**（SPEC §3 / §7.5）。
 *
 * @param ctx - cordis Context（`inject = ['webServer']`）。
 * @param config - Loader 传入的配置（SPEC §4）；本函数把它当普通对象处理。
 */
export function apply(ctx, config) {
  try {
    const bridge = createBridge(ctx, config)
    bridge.start()
    bridge.runInitialSync()
  } catch (err) {
    // 最后一道保险：apply 抛错会拖垮宿主 fiber，所以这里只能记录。
    try {
      console.error('[dsh-whale-newapi-bridge] apply 失败（已吞掉，宿主不受影响）：', redactText(err && err.message !== undefined ? err.message : err))
    } catch {
      /* 连日志都失败也不能抛 */
    }
  }
}
