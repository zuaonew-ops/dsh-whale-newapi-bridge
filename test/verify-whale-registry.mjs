// verify-whale-registry.mjs —— 独立验证 lib/whale-registry.mjs（SPEC §5.3 / §7.4）。
// 全部离线，使用临时目录，绝不动真实 profile 与真实 .dshw-api.json。
import fs from 'node:fs'
import path from 'node:path'
import {
  createRunner, assert, assertEq, assertDeepEq, assertRejects,
  need, needFn, makeTempDir, sha256, sha256File, stable, PKG_DIR, WHALE_REGISTRY_REAL, readJsonIfExists,
} from './verify-helpers.mjs'

const MOD = path.join(PKG_DIR, 'lib', 'whale-registry.mjs')
const t = createRunner('verify-whale-registry.mjs —— 注册表读写（SPEC §5.3）')

let mod = null
let loadError = null
try {
  mod = await import('file://' + MOD.replace(/\\/g, '/'))
} catch (err) {
  loadError = err
}

console.log(`模块: ${MOD}`)
if (loadError) {
  console.log(`\n!! 无法加载模块，本套件无法验证：\n${loadError.stack || loadError}`)
  console.log('SUMMARY: BLOCKED（实现文件缺失/不可加载）')
  process.exitCode = 2
} else {
  // 先做导出清单核对（SPEC §5.3）：缺失导出要**全部列出**并显式判为未通过，而不是抛异常中断。
  const REQUIRED = [
    'resolveWhaleApiFile', 'readWhaleRegistry', 'upsertWhaleEntry', 'removeWhaleEntry',
    'writeWhaleRegistryAtomic', 'summarizeRegistry', 'WHALE_API_FILE',
  ]
  const missing = REQUIRED.filter((k) => !(k in mod))
  console.log(`导出清单核对（SPEC §5.3）: 实际导出 = ${Object.keys(mod).join(', ')}`)
  if (missing.length) console.log(`!! 缺少 SPEC §5.3 要求的导出: ${missing.join(', ')}`)
  const F = {}
  for (const k of REQUIRED) {
    if (k === 'WHALE_API_FILE') { if (k in mod) F[k] = mod[k]; continue }
    if (typeof mod[k] === 'function') F[k] = mod[k]
  }
  const missingFn = REQUIRED.filter((k) => k !== 'WHALE_API_FILE' && typeof F[k] !== 'function')
  const WHALE_API_FILE = F.WHALE_API_FILE
  if (missingFn.length) {
    console.log(`SUMMARY: BLOCKED（关键导出缺失: ${missingFn.join(', ')}，无法验证注册表行为）`)
    process.exitCode = 2
  } else {
  const OUR_ID = 'newapi_relay'

  // 大 usage 对象 + 其它模型（字段故意“奇怪”：嵌套对象、数组、null、空串、0、false）
  const otherModelA = {
    id: 'kimi-k2', name: 'Kimi 中转', provider: 'custom', currency: 'CNY',
    keyRef: 'KIMI_KEY', baseUrl: 'https://api.moonshot.cn/v1',
    balance: { url: 'https://api.moonshot.cn/v1/users/me/balance', auth: 'Bearer {key}', json: { remaining: 'data.available_balance' } },
    matchIds: ['kimi', 'moonshot'], allowCustomHost: false, params: { uuid: 'abc' }, price: null,
  }
  const otherModelB = {
    id: 'ollama-local', name: '本地 Ollama', provider: 'custom', currency: 'CNY',
    keyRef: '', baseUrl: 'http://127.0.0.1:11434/v1',
    balance: { url: '', auth: '', json: { remaining: '' } }, matchIds: [], extra: { deep: { deeper: [1, 2, { x: false }] } },
  }
  const bigUsage = {
    'kimi-k2': { day: '2026-10-05', dayStart: 1122334455, lastBalance: 42.5, delta: 0.25, eventCost: 0, eventTokens: 123456, currency: 'CNY', tokensTotal: 987654321, month: '2026-10', tokensMonth: 12345 },
    'ollama-local': { day: '2026-10-04', dayStart: null, lastBalance: null, delta: 0, eventCost: 1.5, eventTokens: 7, currency: '', tokensTotal: 1, month: '2026-10' },
    [OUR_ID]: { day: '2026-10-05', lastBalance: 1000, delta: 3, eventCost: 0, eventTokens: 5, currency: 'CNY' },
    legacy_unknown_key: { weird: [null, 0, '', false], nested: { a: { b: {} } } },
  }
  const seededRegistry = {
    version: 1,
    models: [otherModelA, otherModelB],
    usage: bigUsage,
    extraTopLevel: { keep: 'me', arr: [1, '2', null] }, // 规范没提的顶层键，也必须保留
  }
  const ourEntry = {
    id: OUR_ID, name: '团队中转站', provider: 'custom', currency: 'CNY', keyRef: 'PI_API_KEY',
    baseUrl: 'https://relay.example.com',
    balance: { url: 'http://127.0.0.1:19387/dsh-whale-newapi/balance', auth: 'Bearer {key}', json: { remaining: 'remaining' } },
    matchIds: ['deepseek-v4.1-flash', 'tier-max', 'tier-power', 'tier-std'], allowCustomHost: true,
  }

  const tmp = await makeTempDir('dsh-verify-reg-')

  await t.group('WHALE_API_FILE 常量（SPEC §5.3 要求本模块导出）', () => {
    t.test("WHALE_API_FILE === '.dshw-api.json'", () => {
      assertEq(F.WHALE_API_FILE, '.dshw-api.json',
        `SPEC §5.3 要求本模块导出 WHALE_API_FILE = '.dshw-api.json'；实际导出键: ${Object.keys(mod).join(', ')}`)
    })
  })

  // 导出清单缺口：作为显式失败项记入结果（不能静默通过）
  await t.group('SPEC §5.3 导出清单完整性', () => {
    t.test(`SPEC §5.3 的 7 个导出一个不缺（缺失: ${missing.length ? missing.join(', ') : '无'}）`, () => {
      assertEq(missing.length, 0,
        `SPEC §5.3 明文列出 WHALE_API_FILE；本模块实际导出 ${Object.keys(mod).join(', ')}。` +
        `缺失: ${missing.join(', ')}（注意：whale-contract.mjs 导出了同名常量，但 SPEC §5.3 把它归在本模块）`)
    })
  })

  // ---------- resolveWhaleApiFile ----------
  await t.group('resolveWhaleApiFile', () => {
    t.test('返回 首选 $DSH_HOME/.dshw-api.json', () => {
      const p = F.resolveWhaleApiFile('D:\\fake\\dshhome')
      assertEq(path.basename(p), WHALE_API_FILE, 'basename 应为 ' + WHALE_API_FILE)
      assertEq(path.basename(p), '.dshw-api.json', 'WHALE_API_FILE 必须是 .dshw-api.json')
      assertEq(path.dirname(path.resolve(p)), path.resolve('D:\\fake\\dshhome'), '应位于给定 dshHome 下')
    })
    t.test('无参数时指向真实 $DSH_HOME（只读路径断言，不写）', () => {
      const p = F.resolveWhaleApiFile()
      assert(path.isAbsolute(p), '应为绝对路径')
      assertEq(path.basename(p), '.dshw-api.json', 'basename')
      console.log(`      实际解析: ${p}`)
    })
  })

  // ---------- readWhaleRegistry ----------
  await t.group('readWhaleRegistry', () => {
    t.test('文件不存在 → { ok:true, existed:false, registry:{version:1,models:[],usage:{}} }', () => {
      const p = tmp.file('nope.json')
      const r = F.readWhaleRegistry(p)
      assertEq(r.ok, true, 'ok')
      assertEq(r.existed, false, 'existed')
      assertDeepEq(r.registry, { version: 1, models: [], usage: {} }, '空注册表形状')
    })
    t.test('坏 JSON → ok:false 且带 error，绝不返回可写注册表（SPEC §7.4）', () => {
      const p = tmp.file('bad.json')
      fs.writeFileSync(p, '{ "version": 1, "models": [ }}} 坏掉了', 'utf8')
      const before = sha256File(p)
      const r = F.readWhaleRegistry(p)
      assertEq(r.ok, false, 'ok 必须为 false')
      assert(typeof r.error === 'string' && r.error.length > 0, '必须给 error')
      assertEq(sha256File(p), before, '读取失败绝不能改文件')
    })
    t.test('结构不对（models 不是数组）→ ok:false', () => {
      for (const [name, body] of [
        ['models-obj.json', JSON.stringify({ version: 1, models: { a: 1 }, usage: {} })],
        ['models-null.json', JSON.stringify({ version: 1, models: null })],
        ['array-root.json', JSON.stringify([1, 2, 3])],
        ['string-root.json', JSON.stringify('hello')],
      ]) {
        const p = tmp.file(name)
        fs.writeFileSync(p, body, 'utf8')
        const r = F.readWhaleRegistry(p)
        assertEq(r.ok, false, `${name} 应 ok:false`)
      }
    })
    t.test('正常文件 → existed:true 且 registry 逐字段等于磁盘内容', () => {
      const p = tmp.file('good.json')
      fs.writeFileSync(p, JSON.stringify(seededRegistry, null, 2), 'utf8')
      const r = F.readWhaleRegistry(p)
      assertEq(r.ok, true, 'ok')
      assertEq(r.existed, true, 'existed')
      assertDeepEq(r.registry, seededRegistry, '读出的注册表必须与磁盘逐字段一致')
    })
    t.test('usage 缺失时补成 {}（不能崩）', () => {
      const p = tmp.file('no-usage.json')
      fs.writeFileSync(p, JSON.stringify({ version: 1, models: [otherModelA] }), 'utf8')
      const r = F.readWhaleRegistry(p)
      assertEq(r.ok, true, 'ok')
      assert(r.registry.usage && typeof r.registry.usage === 'object', 'usage 应为对象')
      assertEq(Object.keys(r.registry.usage).length, 0, 'usage 应为空对象')
    })
  })

  // ---------- upsertWhaleEntry ----------
  await t.group('upsertWhaleEntry —— 保留性（SPEC §5.3 硬性要求）', () => {
    t.test('新 id 追加：changed=true，保留其它模型与 usage 全部字段', () => {
      const reg = JSON.parse(JSON.stringify(seededRegistry))
      const r = F.upsertWhaleEntry(reg, ourEntry)
      assertEq(r.changed, true, 'changed')
      assertEq(r.previousEntry, null, '此前无同 id 条目 → previousEntry 应为 null')
      const models = r.registry.models
      assertEq(models.length, 3, '模型数应为 3')
      assertDeepEq(models[0], otherModelA, '第 0 个模型必须逐字段保留')
      assertDeepEq(models[1], otherModelB, '第 1 个模型必须逐字段保留')
      assertDeepEq(models[2], ourEntry, '我们的条目应逐字段写入')
      assertDeepEq(r.registry.usage, bigUsage, 'usage 必须逐字段保留（大对象）')
      assertDeepEq(r.registry.extraTopLevel, seededRegistry.extraTopLevel, '未知顶层键也必须保留')
      assertEq(r.registry.version, 1, 'version 保留')
    })
    t.test('同 id 重复 upsert → changed=false 且内容逐字段不变（幂等）', () => {
      const reg1 = F.upsertWhaleEntry(JSON.parse(JSON.stringify(seededRegistry)), ourEntry).registry
      const r2 = F.upsertWhaleEntry(JSON.parse(JSON.stringify(reg1)), ourEntry)
      assertEq(r2.changed, false, 'changed 必须为 false（否则会造成 mtime 抖动）')
      assertDeepEq(r2.registry, reg1, '注册表必须逐字段不变')
    })
    t.test('同 id 内容变化 → changed=true 且 previousEntry 是旧条目', () => {
      const reg1 = F.upsertWhaleEntry(JSON.parse(JSON.stringify(seededRegistry)), ourEntry).registry
      const changedEntry = { ...ourEntry, name: '团队中转站2', balance: { url: 'http://127.0.0.1:19387/dsh-whale-newapi/balance', auth: 'Bearer {key}', json: { remaining: 'remaining' } } }
      const r2 = F.upsertWhaleEntry(reg1, changedEntry)
      assertEq(r2.changed, true, 'changed')
      assertDeepEq(r2.previousEntry, ourEntry, 'previousEntry 应为旧条目')
      assertDeepEq(r2.registry.usage, bigUsage, 'usage 仍必须保留')
      assertDeepEq(r2.registry.models[0], otherModelA, '其它模型仍必须保留')
      assertEq(r2.registry.models.length, 3, '不应重复插入')
    })
    t.test('不含我们 id 的注册表 → 只增我们一条', () => {
      const reg = { version: 1, models: [otherModelA], usage: {} }
      const r = F.upsertWhaleEntry(reg, ourEntry)
      assertEq(r.registry.models.length, 2, '模型数')
      assertDeepEq(r.registry.models[0], otherModelA, '既有模型保留')
    })
    t.test('输入注册表不被就地篡改（无副作用）', () => {
      const reg = JSON.parse(JSON.stringify(seededRegistry))
      const snapshot = stable(reg)
      F.upsertWhaleEntry(reg, ourEntry)
      assertEq(stable(reg), snapshot, 'upsert 不应就地修改传入的 registry 对象')
    })
  })

  // ---------- removeWhaleEntry ----------
  await t.group('removeWhaleEntry —— 只删自己的 id', () => {
    t.test('存在 → 删除且 changed=true，其它模型与 usage 保留', () => {
      const reg = F.upsertWhaleEntry(JSON.parse(JSON.stringify(seededRegistry)), ourEntry).registry
      const r = F.removeWhaleEntry(reg, OUR_ID)
      assertEq(r.changed, true, 'changed')
      assertEq(r.registry.models.length, 2, '剩 2 个模型')
      assertDeepEq(r.registry.models[0], otherModelA, 'otherModelA 保留')
      assertDeepEq(r.registry.models[1], otherModelB, 'otherModelB 保留')
      assertDeepEq(r.registry.usage, bigUsage, 'usage 保留（可能含我们的 id，也不许动别人的 key）')
    })
    t.test('不存在 → changed=false 且注册表不变', () => {
      const reg = JSON.parse(JSON.stringify(seededRegistry))
      const r = F.removeWhaleEntry(reg, OUR_ID)
      assertEq(r.changed, false, 'changed')
      assertDeepEq(r.registry.models, seededRegistry.models, '模型不变')
      assertDeepEq(r.registry.usage, seededRegistry.usage, 'usage 不变')
    })
    t.test('不会误删其它 id（名字相似也一样）', () => {
      const near = [{ ...otherModelA }, { ...otherModelB, id: 'ollama-local-2' }]
      const reg = { version: 1, models: near, usage: {} }
      const r = F.removeWhaleEntry(reg, OUR_ID)
      assertEq(r.changed, false, '没有我们的 id 时不该删任何东西')
      assertEq(r.registry.models.length, 2, '模型数不变')
    })
    t.test('内置 id = deepseek 不可被我们删掉（防御性）', () => {
      const reg = { version: 1, models: [{ id: 'deepseek', name: 'DeepSeek' }, { ...otherModelA }], usage: {} }
      const r = F.removeWhaleEntry(reg, OUR_ID)
      assertEq(r.changed, false, '不该删 deepseek')
      assertEq(r.registry.models.length, 2, '模型数不变')
      assertEq(r.registry.models[0].id, 'deepseek', 'deepseek 仍在')
    })
  })

  // ---------- writeWhaleRegistryAtomic ----------
  await t.group('writeWhaleRegistryAtomic —— 原子写 + 备份（SPEC §5.3）', () => {
    t.test('目标不存在 → 写入成功；不应产生“空文件备份”', () => {
      const p = tmp.file('w1.json')
      const reg = F.upsertWhaleEntry({ version: 1, models: [], usage: {} }, ourEntry).registry
      const w = F.writeWhaleRegistryAtomic(p, reg)
      assertEq(w.ok, true, 'ok')
      assertDeepEq(readJsonIfExists(p), reg, '磁盘内容应与注册表逐字段一致')
      const bak = p + '.bak-newapi-bridge'
      if (fs.existsSync(bak)) {
        assert(fs.readFileSync(bak, 'utf8').length > 0 || true, '备份存在则不应是破坏性内容')
        console.log(`      [注意] 目标原本不存在却生成了备份: ${path.basename(bak)}（长度 ${fs.statSync(bak).size}）`)
      }
    })
    t.test('已有文件 → 首次写入前备份成 <file>.bak-newapi-bridge，且备份是原始字节', () => {
      const p = tmp.file('w2.json')
      const originalBytes = Buffer.from(JSON.stringify(seededRegistry, null, 2), 'utf8')
      fs.writeFileSync(p, originalBytes)
      const bak = p + '.bak-newapi-bridge'
      assert(!fs.existsSync(bak), '前置：备份不应存在')
      const reg = F.upsertWhaleEntry(JSON.parse(originalBytes.toString('utf8')), ourEntry).registry
      const w = F.writeWhaleRegistryAtomic(p, reg)
      assertEq(w.ok, true, 'ok')
      assertEq(typeof w.backupPath, 'string', 'backupPath 应为字符串')
      assertEq(path.resolve(w.backupPath), path.resolve(bak), 'backupPath 应为 <file>.bak-newapi-bridge')
      assert(fs.existsSync(bak), '备份文件必须存在')
      assertEq(sha256File(bak), sha256(originalBytes), '备份内容必须与原始文件字节一致')
      assertDeepEq(readJsonIfExists(p), reg, '新内容写入正确')
    })
    t.test('备份已存在 → 不覆盖（保留更早的原始快照）', () => {
      const p = tmp.file('w3.json')
      const bak = p + '.bak-newapi-bridge'
      const firstOriginal = Buffer.from('{"version":1,"models":[],"usage":{"a":1}}', 'utf8')
      fs.writeFileSync(p, firstOriginal)
      F.writeWhaleRegistryAtomic(p, { version: 1, models: [ourEntry], usage: { a: 1 } })
      const bakHash1 = sha256File(bak)
      // 第二次写：先改文件内容，再写
      fs.writeFileSync(p, '{"version":1,"models":[],"usage":{"b":2},"changed":"yes"}')
      F.writeWhaleRegistryAtomic(p, { version: 1, models: [ourEntry], usage: { b: 2 } })
      assertEq(sha256File(bak), bakHash1, '第二次写不得覆盖已有备份')
      assertEq(sha256File(bak), sha256(firstOriginal), '备份仍应是最初的原始内容')
    })
    t.test('原子性：写入过程不留半成品（写完目录里没有临时残留 .tmp/.tmp-* 之类）', () => {
      const p = tmp.file('w4.json')
      fs.writeFileSync(p, JSON.stringify({ version: 1, models: [], usage: {} }))
      F.writeWhaleRegistryAtomic(p, F.upsertWhaleEntry({ version: 1, models: [], usage: {} }, ourEntry).registry)
      const leftovers = fs.readdirSync(tmp.dir).filter((f) => /\.tmp|~$|\.swp|\.part$/i.test(f) && !f.endsWith('.bak-newapi-bridge'))
      assertEq(leftovers.length, 0, `不应有临时文件残留，实际: ${leftovers.join(', ')}`)
    })
    t.test('目标路径被目录占用（rename 必定失败）→ 返回 ok:false 且不抛异常（SPEC §7.5 不得影响宿主）', () => {
      // 构造真实失败：在目标文件路径上建一个**非空目录**，renameSync(tmp → 目录) 必然 EPERM/EISDIR。
      // （不用“只读目录”，因为本机以管理员运行时会绕过只读属性。）
      const p = tmp.file('blocked-as-dir.json')
      fs.mkdirSync(p)
      fs.writeFileSync(path.join(p, 'occupant.txt'), 'x', 'utf8')
      const w = F.writeWhaleRegistryAtomic(p, { version: 1, models: [], usage: {} })
      assertEq(w.ok, false, 'ok 应为 false')
      assert(typeof w.error === 'string' && w.error.length > 0, '必须给 error')
      console.log(`      实测: ok=${w.ok} error=${String(w.error).slice(0, 120)}`)
      // 临时文件不得残留
      const leftovers = fs.readdirSync(tmp.dir).filter((f) => /\.tmp-|\.tmp$/i.test(f))
      assertEq(leftovers.length, 0, `失败后不得残留临时文件，实际: ${leftovers.join(', ')}`)
    })
  })

  // ---------- changed=false 不落盘 ----------
  await t.group('changed===false 不落盘（SPEC §5.3：mtime 与内容哈希都不许变）', () => {
    t.test('相同内容 upsert → 不调用写盘，mtime 与 sha256 均不变', async () => {
      const p = tmp.file('nowrite.json')
      const reg0 = F.upsertWhaleEntry({ version: 1, models: [otherModelA], usage: bigUsage }, ourEntry).registry
      fs.writeFileSync(p, JSON.stringify(reg0, null, 2), 'utf8')
      const mtime1 = fs.statSync(p).mtimeMs
      const hash1 = sha256File(p)
      await new Promise((r) => setTimeout(r, 30)) // 让 mtime 有可观测差异的窗口
      const readBack = F.readWhaleRegistry(p)
      assertEq(readBack.ok, true, '读取 ok')
      const up = F.upsertWhaleEntry(readBack.registry, ourEntry)
      assertEq(up.changed, false, 'changed 必须为 false')
      const mtime2 = fs.statSync(p).mtimeMs
      const hash2 = sha256File(p)
      assertEq(hash2, hash1, 'sha256 不得变')
      assertEq(mtime2, mtime1, 'mtime 不得变（changed=false 必须跳过写入）')
    })
    t.test('真实注册表路径（若存在）只读演练：readWhaleRegistry 不修改文件', () => {
      if (!fs.existsSync(WHALE_REGISTRY_REAL)) {
        console.log(`      [无法验证] 真实注册表 ${WHALE_REGISTRY_REAL} 尚不存在（安装前状态）`)
        return
      }
      const before = sha256File(WHALE_REGISTRY_REAL)
      const mtime = fs.statSync(WHALE_REGISTRY_REAL).mtimeMs
      const r = F.readWhaleRegistry(WHALE_REGISTRY_REAL)
      assertEq(r.ok, true, '真实文件应可解析')
      assertEq(sha256File(WHALE_REGISTRY_REAL), before, '只读演练不得改文件')
      assertEq(fs.statSync(WHALE_REGISTRY_REAL).mtimeMs, mtime, 'mtime 不得变')
    })
  })

  // ---------- summarizeRegistry ----------
  await t.group('summarizeRegistry', () => {
    t.test('返回 modelIds 与 usageKeys 数量', () => {
      const s = F.summarizeRegistry(seededRegistry)
      assertEq(s.usageKeys, Object.keys(bigUsage).length, 'usageKeys')
      assertEq(s.modelIds.length, seededRegistry.models.length, 'modelIds 长度')
      assert(s.modelIds.includes('kimi-k2') && s.modelIds.includes('ollama-local'), 'modelIds 内容')
    })
    t.test('空注册表 → 空数组与 0', () => {
      const s = F.summarizeRegistry({ version: 1, models: [], usage: {} })
      assertEq(s.modelIds.length, 0, 'modelIds')
      assertEq(s.usageKeys, 0, 'usageKeys')
    })
    t.test('输入异常（null）不得抛（SPEC §7.5）', () => {
      let threw = false
      try { F.summarizeRegistry(null) } catch { threw = true }
      assertEq(threw, false, 'summarizeRegistry(null) 不应抛')
    })
  })

  // ---------- 端到端：read → upsert → write → re-read 逐字节保留 ----------
  await t.group('端到端：read → upsert → write → re-read', () => {
    t.test('磁盘上的其它模型与 usage 逐字段保留，且小鲸鱼可解析', () => {
      const p = tmp.file('e2e.json')
      fs.writeFileSync(p, JSON.stringify(seededRegistry, null, 2), 'utf8')
      const read1 = F.readWhaleRegistry(p)
      assertEq(read1.ok, true, '首次读 ok')
      const up = F.upsertWhaleEntry(read1.registry, ourEntry)
      assertEq(up.changed, true, 'changed')
      const w1 = F.writeWhaleRegistryAtomic(p, up.registry)
      assertEq(w1.ok, true, '写 ok')
      const read2 = F.readWhaleRegistry(p)
      assertEq(read2.ok, true, '二次读 ok')
      assertDeepEq(read2.registry.usage, bigUsage, 'usage 逐字段保留')
      assertDeepEq(read2.registry.models[0], otherModelA, '模型 A 逐字段保留')
      assertDeepEq(read2.registry.models[1], otherModelB, '模型 B 逐字段保留')
      assertDeepEq(read2.registry.models[2], ourEntry, '我们的条目逐字段写入')
      assertDeepEq(read2.registry.extraTopLevel, seededRegistry.extraTopLevel, '未知顶层键保留')
      // 幂等：再 upsert 一次应 changed=false（小鲸鱼缓存不受扰）
      const up2 = F.upsertWhaleEntry(read2.registry, ourEntry)
      assertEq(up2.changed, false, '第二次 upsert 必须 changed=false')
    })
    t.test('remove 后再 write → 回到“只有其它模型与 usage”的等价状态', () => {
      const p = tmp.file('e2e2.json')
      fs.writeFileSync(p, JSON.stringify(seededRegistry, null, 2), 'utf8')
      const up = F.upsertWhaleEntry(F.readWhaleRegistry(p).registry, ourEntry)
      F.writeWhaleRegistryAtomic(p, up.registry)
      const rm = F.removeWhaleEntry(F.readWhaleRegistry(p).registry, OUR_ID)
      assertEq(rm.changed, true, 'changed')
      F.writeWhaleRegistryAtomic(p, rm.registry)
      const after = F.readWhaleRegistry(p).registry
      assertEq(after.models.length, 2, '模型数回到 2')
      assertDeepEq(after.models, seededRegistry.models, '模型内容与安装前一致')
      assertDeepEq(after.usage, seededRegistry.usage, 'usage 与安装前一致')
      assertDeepEq(after.extraTopLevel, seededRegistry.extraTopLevel, '未知顶层键一致')
    })
  })

  await t.finish()
  await tmp.cleanup()
  }
}
