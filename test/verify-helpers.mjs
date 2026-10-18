// verify-helpers.mjs —— 独立验证组（子团队 C）零依赖测试工具。
// 本文件只被 verify-*.mjs 使用；不含任何凭据明文。
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))
export const PKG_DIR = path.resolve(TEST_DIR, '..')
export const FIXTURE_DIR = path.join(TEST_DIR, 'fixtures')
export const DSH_HOME_REAL = path.join(os.homedir(), '.dsh')
export const WHALE_REGISTRY_REAL = path.join(DSH_HOME_REAL, '.dshw-api.json')
export const CREDENTIALS_REAL = path.join(DSH_HOME_REAL, '.credentials.yaml')
export const WHALE_SRC = path.join(
  os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-whale-widget', 'lib', 'index.js',
)

/** 极简测试运行器：零依赖、串行、打印每项结果，失败时汇总并以退出码 1 结束。
 *
 *  用法（两种都支持，最终必须 `await t.finish()`）：
 *    t.group('名字', () => { t.test('用例', () => {...}) })          // 同步登记，执行被内部串行化
 *    t.group('名字', async () => { await t.test('用例', async () => {...}) })
 *
 *  finish() 会等到所有已登记的用例（含异步）真正跑完才出汇总，绝不会提前打印。 */
export function createRunner(title) {
  const results = []
  const pendingGroups = []
  let current = null
  let chain = Promise.resolve()
  let notify = null
  const wake = () => { if (notify) { const f = notify; notify = null; f() } }

  const enqueue = (fn) => { chain = chain.then(fn); return chain }

  const t = {
    title,
    group(name, fn) {
      const group = { name, cases: [], expected: 0, settled: false, error: null }
      results.push(group)
      const prev = current
      current = group
      let p
      try {
        // 同步上下文：期间 t.test(...) 会被登记到本组
        p = Promise.resolve(fn())
      } catch (err) {
        group.error = err
        p = Promise.resolve()
      } finally {
        current = prev
      }
      const handle = (async () => {
        try { await p } catch (err) { group.error = err }
        // 等待本组所有已登记用例完成（异步用例也算）
        while (group.cases.length < group.expected) {
          await new Promise((resolve) => {
            notify = resolve
            setTimeout(resolve, 5000)
          })
        }
        group.settled = true
      })()
      pendingGroups.push(handle)
      return handle
    },
    test(name, fn) {
      const group = current
      if (!group) throw new Error(`内部错误：t.test('${name}') 不在 t.group(...) 同步上下文中`)
      group.expected += 1
      const start = Date.now()
      enqueue(async () => {
        try {
          await fn()
          group.cases.push({ name, ok: true, ms: Date.now() - start })
          console.log(`  \u2713 ${name}`)
        } catch (err) {
          const detail = (err && err.stack ? err.stack : String(err))
          group.cases.push({ name, ok: false, ms: Date.now() - start, error: detail })
          console.log(`  \u2717 ${name}`)
          console.log(indent(detail.split('\n').slice(0, 12).join('\n'), 6))
        } finally {
          wake()
        }
      })
      return chain
    },
    async finish() {
      await Promise.all(pendingGroups)
      await chain
      let pass = 0, fail = 0
      console.log(`\n===== ${title} =====`)
      for (const g of results) {
        const gp = g.cases.filter((c) => c.ok).length
        const gf = g.cases.length - gp
        const empty = g.cases.length === 0 || g.cases.length < g.expected || g.error
        const label = empty ? 'EMPTY' : (gf === 0 ? 'PASS' : 'FAIL')
        console.log(`${label}  ${g.name}  (${gp}/${g.cases.length}${g.expected !== g.cases.length ? `, 登记 ${g.expected}` : ''})`)
        if (g.error) console.log(`      - 分组内抛出未捕获错误: ${String(g.error && g.error.message || g.error)}`)
        for (const c of g.cases) if (!c.ok) console.log(`      - FAILED: ${c.name}`)
        pass += gp; fail += gf
        if (empty) fail += 1
      }
      console.log(`----- 合计: ${pass} 通过 / ${fail} 失败 (${results.reduce((n, g) => n + g.cases.length, 0)} 项) -----`)
      if (fail > 0) {
        console.log('SUMMARY: FAIL')
        process.exitCode = 1
      } else if (pass === 0) {
        console.log('SUMMARY: EMPTY（没有任何断言被执行，不能视为通过）')
        process.exitCode = 3
      } else {
        console.log('SUMMARY: PASS')
      }
      return { pass, fail }
    },
  }
  return t
}

function indent(s, n) { return s.split('\n').map((l) => ' '.repeat(n) + l).join('\n') }

export function assert(cond, msg) {
  if (!cond) throw new Error('断言失败: ' + msg)
}
export function assertEq(actual, expected, msg) {
  if (!Object.is(actual, expected)) {
    throw new Error(`断言失败: ${msg}\n  期望: ${fmt(expected)}\n  实际: ${fmt(actual)}`)
  }
}
export function assertDeepEq(actual, expected, msg) {
  const a = stable(actual), b = stable(expected)
  if (a !== b) throw new Error(`深比较失败: ${msg}\n  期望: ${b}\n  实际: ${a}`)
}
export function assertFiniteNumber(v, msg) {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`断言失败: ${msg}（期望有限数值，实际 ${fmt(v)}）`)
}
export function assertIncludes(hay, needle, msg) {
  if (String(hay).indexOf(needle) < 0) throw new Error(`断言失败: ${msg}\n  未找到: ${needle}\n  实际: ${String(hay).slice(0, 400)}`)
}
export function assertNotIncludes(hay, needle, msg) {
  if (String(hay).indexOf(needle) >= 0) throw new Error(`断言失败: ${msg}\n  响应/文本中出现了不该出现的字符串（长度 ${String(needle).length}）`)
}
export async function assertRejects(fn, msg) {
  let threw = null
  try { await fn() } catch (err) { threw = err }
  if (!threw) throw new Error('断言失败: ' + msg + '（期望抛错，实际没有）')
  return threw
}

function fmt(v) {
  try { return typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v) } catch { return String(v) }
}
/** 稳定序列化：对象键排序，用于逐字段深比较（能区分“键缺失”与“键为 undefined”）。 */
export function stable(v) {
  return JSON.stringify(sortKeys(v))
}
export function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === 'object') {
    const out = {}
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k])
    return out
  }
  return v
}

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}
export function sha256File(p) {
  return sha256(fs.readFileSync(p))
}
export function mask(secret) {
  if (!secret) return '(空)'
  return `sk-*** (长度 ${String(secret).length})`
}

/** 读取本机 DSH 凭据文件里的某个 ref（只用于黑盒探测，绝不落盘/打印明文）。 */
export function readCredentialValue(ref) {
  if (!fs.existsSync(CREDENTIALS_REAL)) return null
  const text = fs.readFileSync(CREDENTIALS_REAL, 'utf8')
  const lines = text.split(/\r?\n/)
  let inRefs = false
  for (const raw of lines) {
    const line = raw.replace(/\t/g, '    ')
    if (/^refs\s*:/.test(line)) { inRefs = true; continue }
    if (inRefs && /^\S/.test(line)) { inRefs = false }
    if (!inRefs) continue
    const m = line.match(/^\s+([A-Za-z0-9_]+)\s*:\s*(.+?)\s*$/)
    if (!m) continue
    if (m[1] !== ref) continue
    let v = m[2]
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    return v
  }
  return null
}

/** 创建临时目录（用于文件读写测试），返回 { dir, cleanup, file(...) }。 */
export async function makeTempDir(prefix = 'dsh-verify-') {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix))
  return {
    dir,
    file: (...p) => path.join(dir, ...p),
    async cleanup() { await fsp.rm(dir, { recursive: true, force: true }).catch(() => {}) },
  }
}

export function readJsonIfExists(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}

/** 真实响应 fixture：优先用 protocol 的 fixtures/**，缺失时返回 null（调用方须显式报告）。 */
export function loadFixture(name) {
  const p = path.join(FIXTURE_DIR, name)
  if (!fs.existsSync(p)) return null
  try { return { path: p, json: JSON.parse(fs.readFileSync(p, 'utf8')) } } catch (err) {
    return { path: p, json: null, error: String(err && err.message || err) }
  }
}

/** Response 桩：供注入 fetchImpl 使用（不联网）。 */
export function jsonResponse(obj, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map([['content-type', 'application/json']]),
    async json() { return obj },
    async text() { return JSON.stringify(obj) },
  }
}
export function textResponse(body, status = 200, contentType = 'text/html') {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map([['content-type', contentType]]),
    async json() { throw new SyntaxError('Unexpected token < in JSON') },
    async text() { return body },
  }
}
/** 按 URL 分派响应的 fetch 桩；记录所有调用（用于断言“没有联网/发了什么头”）。 */
export function makeFetchStub(routes) {
  const calls = []
  const stub = async (url, init) => {
    const entry = { url: String(url), init: init || null }
    calls.push(entry)
    for (const r of routes) {
      const match = typeof r.match === 'string' ? String(url).indexOf(r.match) >= 0 : r.match.test(String(url))
      if (!match) continue
      if (r.throw) throw r.throw
      if (r.hang) return await new Promise((_, reject) => {
        const err = new Error('The operation was aborted due to timeout')
        err.name = 'TimeoutError'
        if (init && init.signal && typeof init.signal.addEventListener === 'function') init.signal.addEventListener('abort', () => reject(err))
      })
      return typeof r.response === 'function' ? r.response(entry) : r.response
    }
    throw new Error('fetch 桩未匹配 URL: ' + url)
  }
  stub.calls = calls
  return stub
}

export function codeOf(r) {
  return r && typeof r === 'object' ? r.code : undefined
}

/** 从模块里安全取导出，缺失时给出显式错误（用于报告“无法验证”而不是静默通过）。 */
export function need(mod, name, modName) {
  if (!(name in mod)) throw new Error(`模块 ${modName} 缺少 SPEC 要求的导出: ${name}`)
  return mod[name]
}
export function needFn(mod, name, modName) {
  const v = need(mod, name, modName)
  if (typeof v !== 'function') throw new Error(`模块 ${modName} 的 ${name} 不是函数（实际 ${typeof v}）`)
  return v
}

export async function exists(p) {
  try { await fsp.access(p); return true } catch { return false }
}
export function nowIso() { return new Date().toISOString() }
