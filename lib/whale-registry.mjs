// dsh-whale-newapi-bridge — 小鲸鱼注册表桥接层
//
// 职责：读写小鲸鱼宿主消费的 $DSH_HOME/.dshw-api.json（`{version, models:[], usage:{}}`），
// 并且**只增删我们自己的那一条条目**，其余内容逐字段保留。
//
// 冻结契约：SPEC.md `spec-v1` §5.3。小鲸鱼宿主事实来源：
//   %USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-whale-widget\lib\index.js
//   · API_FILE_CANDIDATES            第 87-92 行（$DSH_HOME 优先）
//   · readApiRegistry                第 1953-1964 行（坏 JSON / models 非数组 → 回落内置默认，不报错）
//   · writeApiRegistry               第 1965-1971 行（JSON.stringify(reg, null, 2)，UTF-8）
//   · apiAllModels / apiModelById    第 1980-1987 行（models 里 id === 'deepseek' 的条目被过滤掉）
//   · apiRecordBalance               第 2394-2410 行（宿主会**在我们条目上写 usage[id]**）
//   · apiTodayUsage                  第 2414-2423 行（读 usage[id].lastBalance / delta / eventCost）
//
// 为什么必须逐字段保留其它条目与 usage：
//   小鲸鱼的余额记账把 `usage[id]` 当作自己的账本（第 2394-2410 行），宿主每次取余额都会
//   重写整个注册表（第 2407 行 writeApiRegistry(reg)）。我们只要在重写时丢掉任何一个键
//   （例如 usage.eventCost / dayStart 或别的模型的 allowCustomHost），用户就会看到
//   「今日已用」归零、别的模型余额突然报「需要在本机确认」。所以本模块用「只替换 id 命中的那一条」
//   的策略：其它条目对象**原样引用**（不重建、不改键序），我们自己的条目按契约重建。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 注册表文件名（SPEC §5.2 同名常量，此处不重复导出，只内部使用）。 */
export const WHALE_API_FILENAME = '.dshw-api.json'

/**
 * 注册表文件名别名：SPEC §5.2 把 `WHALE_API_FILE` 归在 whale-contract；
 * 独立消费者（如 test/verify-whale-registry.mjs）也会直接从本模块 import 它，
 * 因此这里导出**同一个值**，两个模块的常量恒等。
 */
export const WHALE_API_FILE = WHALE_API_FILENAME

/** 首次修改原文件前的备份后缀（SPEC §5.3）。已存在则不覆盖。 */
export const BACKUP_SUFFIX = '.bak-newapi-bridge'

/** 注册表顶层版本号（小鲸鱼 defaultApiRegistry，宿主第 1952 行）。 */
export const REGISTRY_VERSION = 1

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** 深拷贝 JSON 值（注册表只含 JSON 类型）；用于绝不改动调用方传入的对象。 */
function cloneJson(v) {
  if (Array.isArray(v)) return v.map(cloneJson)
  if (isPlainObject(v)) {
    const o = {}
    for (const k of Object.keys(v)) o[k] = cloneJson(v[k])
    return o
  }
  return v
}

/** 深比较两份 JSON 值（键序无关、数组顺序敏感）。 */
function deepEqualJson(a, b) {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!deepEqualJson(a[i], b[i])) return false
    return true
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a)
    const kb = Object.keys(b)
    if (ka.length !== kb.length) return false
    for (const k of ka) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false
      if (!deepEqualJson(a[k], b[k])) return false
    }
    return true
  }
  // NaN 不会出现在 JSON 里，但防御一下
  return Number.isNaN(a) && Number.isNaN(b)
}

/** 空注册表（宿主 defaultApiRegistry，第 1952 行）。 */
function defaultRegistry() {
  return { version: REGISTRY_VERSION, models: [], usage: {} }
}

/** 把任意解析结果规范化成 { ok, registry, error }；结构不对即 ok:false（**绝不覆盖**）。 */
function normalizeRegistryShape(value) {
  if (Array.isArray(value)) {
    return { ok: false, registry: null, error: '注册表顶层是数组（应为对象）' }
  }
  if (!isPlainObject(value)) {
    return { ok: false, registry: null, error: `注册表顶层不是对象（实际 ${value === null ? 'null' : typeof value}）` }
  }
  if (value.models === undefined) {
    return { ok: false, registry: null, error: '注册表缺少 .models 数组（宿主 readApiRegistry 要求 Array.isArray(parsed.models)，第 1957 行）' }
  }
  if (!Array.isArray(value.models)) {
    return { ok: false, registry: null, error: `注册表 .models 不是数组（实际 ${typeof value.models}）` }
  }
  if (value.usage !== undefined && value.usage !== null && !isPlainObject(value.usage)) {
    return { ok: false, registry: null, error: `注册表 .usage 不是对象（实际 ${Array.isArray(value.usage) ? 'array' : typeof value.usage}）` }
  }
  const registry = cloneJson(value)
  if (!isPlainObject(registry.usage)) registry.usage = {}
  if (!Number.isFinite(Number(registry.version))) registry.version = REGISTRY_VERSION
  return { ok: true, registry, error: '' }
}

// ---------------------------------------------------------------------------
// 路径与读取
// ---------------------------------------------------------------------------

/**
 * SPEC §5.3：首选 `$DSH_HOME/.dshw-api.json`。
 *
 * 与宿主 API_FILE_CANDIDATES（第 87-92 行）保持一致：$DSH_HOME 优先。
 * 桌面端加载的是 strip 过的发布副本（DATA_CANDIDATES_TAIL 为空，见第 36-38 行注释），
 * 发布版只保留 $DSH_HOME 与其 profiles/web 兜底 —— 所以**只写首选路径**即可被两端同时看到；
 * 我们刻意不去写 `profiles/web/.dshw-api.json` 兜底（写两份会造成第 31-34 行抱怨的
 * 「两端各写各的、互相看不到」）。
 *
 * @param {string} [dshHome] DSH_HOME；省略时依次取 process.env.DSH_HOME、~/.dsh
 * @returns {string} 首选注册表文件绝对路径
 */
export function resolveWhaleApiFile(dshHome) {
  let home = String(dshHome == null ? '' : dshHome).trim()
  if (!home) home = String(process.env.DSH_HOME || '').trim()
  if (!home) home = path.join(os.homedir(), '.dsh')
  return path.join(home, WHALE_API_FILENAME)
}

/**
 * SPEC §5.3：读取注册表。
 *
 * 返回 `{ ok, existed, registry, raw, error }`：
 *   · 文件不存在      → `{ ok:true, existed:false, registry:{version:1,models:[],usage:{}}, raw:null }`
 *   · 正常 JSON       → `{ ok:true, existed:true, registry, raw:<原文> }`
 *   · 坏 JSON / 结构不对 → `{ ok:false, existed:true, registry:null, raw:<原文>, error }`（**绝不覆盖**）
 *
 * 注意：宿主对坏文件的策略是「静默回落内置默认值」（第 1961-1963 行 catch + defaultApiRegistry），
 * 我们**不能**照抄 —— 照抄就等于把用户手写的其它模型整份删掉。SPEC §7.4 要求先 read 成功才允许写。
 *
 * @param {string} file
 * @returns {{ok:boolean, existed:boolean, registry:object|null, raw:string|null, error:string}}
 */
export function readWhaleRegistry(file) {
  const target = String(file == null ? '' : file)
  if (!target) {
    return { ok: false, existed: false, registry: null, raw: null, error: '未提供注册表文件路径' }
  }
  let raw
  try {
    raw = fs.readFileSync(target, 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { ok: true, existed: false, registry: defaultRegistry(), raw: null, error: '' }
    }
    return { ok: false, existed: false, registry: null, raw: null, error: `读取失败: ${String((err && err.message) || err)}` }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return { ok: false, existed: true, registry: null, raw, error: `JSON 解析失败: ${String((err && err.message) || err)}` }
  }
  const shape = normalizeRegistryShape(parsed)
  if (!shape.ok) return { ok: false, existed: true, registry: null, raw, error: shape.error }
  return { ok: true, existed: true, registry: shape.registry, raw, error: '' }
}

// ---------------------------------------------------------------------------
// 增删（只动 id 命中的那一条）
// ---------------------------------------------------------------------------

/** 复制一份注册表外壳；其它模型条目**原样引用**（保证键序与未识别字段一字不动）。 */
function copyShell(registry) {
  const reg = registry && typeof registry === 'object' ? registry : {}
  const out = {}
  if (Object.prototype.hasOwnProperty.call(reg, 'version')) out.version = reg.version
  if (!Number.isFinite(Number(out.version))) out.version = REGISTRY_VERSION
  out.models = Array.isArray(reg.models) ? reg.models.slice() : []
  if (Object.prototype.hasOwnProperty.call(reg, 'usage')) out.usage = reg.usage
  if (!isPlainObject(out.usage)) out.usage = {}
  // 保留任何我们没见过的顶层键（未来版本新增字段）—— 同「逐字段保留」原则
  for (const k of Object.keys(reg)) {
    if (k === 'version' || k === 'models' || k === 'usage') continue
    out[k] = reg[k]
  }
  return out
}

/**
 * SPEC §5.3：插入或替换 `entry.id` 那一条。
 *
 * @returns {{registry:object, changed:boolean, previousEntry:object|null}}
 *   · `changed===false` 时调用方**不得落盘**（避免 mtime 抖动：宿主按文件读取，
 *     无谓的重写会让它反复重新解析）。
 *   · 其它模型条目与 `usage` 逐字段保留；传入的 registry 不被改动。
 */
export function upsertWhaleEntry(registry, entry) {
  const source = registry && typeof registry === 'object' ? registry : defaultRegistry()
  if (!isPlainObject(entry) || typeof entry.id !== 'string' || !entry.id) {
    return { registry: source, changed: false, previousEntry: null, error: '待写入条目的 id 无效（必须是非空字符串）' }
  }
  const reg = copyShell(source)
  const id = entry.id
  let index = -1
  for (let i = 0; i < reg.models.length; i++) {
    const m = reg.models[i]
    if (isPlainObject(m) && m.id === id) { index = i; break }
  }
  const previousEntry = index >= 0 ? reg.models[index] : null
  const next = cloneJson(entry)
  if (previousEntry && deepEqualJson(previousEntry, next)) {
    // 内容等价 → 不重建对象（保留原条目的键序与引用），changed=false
    return { registry: reg, changed: false, previousEntry }
  }
  if (index >= 0) reg.models[index] = next
  else reg.models.push(next)
  return { registry: reg, changed: true, previousEntry }
}

/**
 * SPEC §5.3：按 id 移除我们自己的条目。
 *
 * @returns {{registry:object, changed:boolean, removedEntry:object|null}}
 */
export function removeWhaleEntry(registry, id) {
  const source = registry && typeof registry === 'object' ? registry : defaultRegistry()
  const reg = copyShell(source)
  const target = String(id == null ? '' : id)
  let index = -1
  for (let i = 0; i < reg.models.length; i++) {
    const m = reg.models[i]
    if (isPlainObject(m) && m.id === target) { index = i; break }
  }
  if (index < 0) return { registry: reg, changed: false, removedEntry: null }
  const removedEntry = reg.models[index]
  reg.models.splice(index, 1)
  // usage[id] 是宿主账本，**不删**：删掉会让宿主下次重写时把它写回来，
  // 反而多一次 mtime 抖动；保留它也能让用户重新启用后「今日已用」延续。
  return { registry: reg, changed: true, removedEntry }
}

// ---------------------------------------------------------------------------
// 原子写 + 备份
// ---------------------------------------------------------------------------

/**
 * SPEC §5.3：原子写入注册表。
 *
 * 步骤：
 *   1. 备份：`<file>.bak-newapi-bridge`（**已存在则不覆盖**，保留小鲸鱼接手前的那一份）；
 *   2. 写临时文件 `<dir>/.<base>.tmp-<pid>-<rand>`（同目录，保证 rename 是同一文件系统内的原子操作）；
 *   3. `fs.renameSync(tmp, file)` 覆盖目标。
 *
 * 为什么这么麻烦：宿主每次取余额都会 readApiRegistry 解析整个文件（第 1953-1964 行），
 * 直接 `writeFileSync` 存在「读到半截 JSON」的窗口 → 宿主静默判定为坏文件 → 用户余额
 * 与所有其它模型同时消失（第 1961-1963 行）。临时文件同样用 JSON.stringify(reg, null, 2)
 * + UTF-8，保持与小鲸鱼 writeApiRegistry（第 1966 行）同样的字节风格。
 *
 * @param {string} file
 * @param {object} registry
 * @returns {{ok:boolean, backupPath:string|null, error:string}}
 */
export function writeWhaleRegistryAtomic(file, registry) {
  const target = String(file == null ? '' : file)
  if (!target) return { ok: false, backupPath: null, error: '未提供注册表文件路径' }
  const shape = normalizeRegistryShape(registry)
  if (!shape.ok) return { ok: false, backupPath: null, error: `拒绝写入非法注册表: ${shape.error}` }
  const dir = path.dirname(target)
  const base = path.basename(target)
  const tmp = path.join(dir, `.${base}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
  const backupPath = target + BACKUP_SUFFIX
  let backedUp = false
  try {
    // 目录**必须已存在**：SPEC §5.3 的路径永远是 $DSH_HOME（必然存在）。
    // 这里刻意**不** mkdir -p —— 目标目录缺失属于配置错误，必须显式 ok:false 报出来，
    // 而不是悄悄多建几层目录把问题掩盖掉（test/verify-whale-registry.mjs 也按此断言）。
    if (!fs.existsSync(dir)) {
      return { ok: false, backupPath: null, error: `目标目录不存在: ${dir}（拒绝自动创建，请检查 DSH_HOME）` }
    }
    // —— 1. 备份（硬链接：原子地「不存在才创建」，避免 existsSync→copyFileSync 的竞争窗口）
    if (fs.existsSync(target) && !fs.existsSync(backupPath)) {
      try {
        fs.linkSync(target, backupPath)
        backedUp = true
      } catch {
        try {
          fs.copyFileSync(target, backupPath, fs.constants.COPYFILE_EXCL)
          backedUp = true
        } catch (err2) {
          if (!(err2 && err2.code === 'EEXIST')) {
            return { ok: false, backupPath: null, error: `备份失败: ${String((err2 && err2.message) || err2)}` }
          }
        }
      }
    }
    // —— 2 + 3. 临时文件 + rename
    const body = JSON.stringify(shape.registry, null, 2)
    fs.writeFileSync(tmp, body, 'utf8')
    try {
      fs.renameSync(tmp, target)
    } catch (err) {
      // Windows 上 rename 覆盖可能被占用/权限挡住：退化为先删目标再 rename（窗口极小）
      try {
        fs.rmSync(target, { force: true })
        fs.renameSync(tmp, target)
      } catch (err2) {
        try { fs.rmSync(tmp, { force: true }) } catch { /* ignore */ }
        return { ok: false, backupPath: backedUp ? backupPath : null, error: `写入失败: ${String((err2 && err2.message) || err2)}` }
      }
    }
    return { ok: true, backupPath: backedUp ? backupPath : null, error: '' }
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }) } catch { /* ignore */ }
    return { ok: false, backupPath: backedUp ? backupPath : null, error: `写入失败: ${String((err && err.message) || err)}` }
  }
}

// ---------------------------------------------------------------------------
// 摘要
// ---------------------------------------------------------------------------

/**
 * SPEC §5.3：给人看的注册表摘要（不含任何凭据）。
 * @returns {{modelIds:string[], usageKeys:number}}
 */
export function summarizeRegistry(registry) {
  const reg = registry && typeof registry === 'object' ? registry : {}
  const models = Array.isArray(reg.models) ? reg.models : []
  const modelIds = models.map((m) => (isPlainObject(m) && typeof m.id === 'string' ? m.id : ''))
  const usageKeys = isPlainObject(reg.usage) ? Object.keys(reg.usage).length : 0
  return { modelIds, usageKeys }
}

/** 读取 + 摘要（诊断路由的便捷入口）。 */
export function readWhaleSummary(file) {
  const read = readWhaleRegistry(file)
  return {
    file: String(file == null ? '' : file),
    ok: read.ok,
    existed: read.existed,
    error: read.error,
    summary: read.ok ? summarizeRegistry(read.registry) : null,
  }
}
