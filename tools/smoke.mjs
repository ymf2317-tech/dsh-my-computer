#!/usr/bin/env node
// dsh-my-computer 冒烟测试
//
// 不需要 dsh 宿主：伪造一个最小的 ctx（effect + connection.fetch.register），
// import lib/index.js 把它注册出来的 handler 一个个当成真 HTTP 请求打一遍。
// 跑法：node tools/smoke.mjs
//
// 覆盖：/drives /list /read /write /download /upload /mkdir /rename /delete /move
// 以及各类错误路径（非法路径、不存在、目录当文件读、二进制、409 冲突、
// 缺少 confirm、目录下载 422）。所有临时文件都在 TMP_DIR 里，跑完删干净。

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = path.resolve(HERE, '..')
const SMOKE_SELF = fileURLToPath(import.meta.url)

const HAS_D = fs.existsSync('D:\\')
const TMP_DIR = HAS_D
  ? 'D:\\dsh-workspace\\tmp\\mycomp-smoke'
  : path.join(PKG_ROOT, '.tmp-smoke')
const WORKSPACE = HAS_D ? 'D:\\dsh-workspace' : PKG_ROOT

/* ---------------- 断言框架 ---------------- */

const checks = []
function record(pass, name, detail) {
  checks.push({ pass, name, detail })
  const mark = pass ? '  ✓' : '  ✗'
  const tail = detail === undefined || detail === '' ? '' : '  ' + detail
  console.log(mark + ' ' + name + tail)
}
function check(name, condition, detail) {
  record(Boolean(condition), name, detail)
  return Boolean(condition)
}
function checkEqual(name, actual, expected) {
  const pass = actual === expected
  return check(name, pass, pass ? '' : `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}
function section(title) {
  console.log('\n── ' + title + ' ' + '─'.repeat(Math.max(0, 58 - title.length)))
}

/* ---------------- 伪造宿主 ---------------- */

const registered = []
// 只实现 lib/index.js 真正用到的那几样：effect / connection.fetch.register / logger
const fakeCtx = {
  effect(fn) {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  connection: {
    fetch: {
      register(route) {
        registered.push(route)
        return () => {
          const at = registered.indexOf(route)
          if (at >= 0) registered.splice(at, 1)
        }
      },
    },
  },
  logger: { info() {}, warn() {}, error() {} },
}

const mod = await import(new URL('../lib/index.js', import.meta.url).href)
await mod.apply(fakeCtx, {})

const byId = new Map()
for (const route of registered) {
  byId.set(route.path.slice(route.path.lastIndexOf('/') + 1), route)
}

/**
 * 打一个注册出来的 handler。
 * 走的是真实 Request：URL 与 DSH 桥接层一致（http://dsh.internal + 注册路径 + query）。
 */
async function call(id, options = {}) {
  const route = byId.get(id)
  if (!route) throw new Error('路由没注册：' + id)
  const method = options.method || route.methods[0]
  const url =
    'http://dsh.internal' + route.path + (options.query ? '?' + options.query : '')
  const headers = Object.assign({ host: 'dsh.internal' }, options.headers || {})
  const init = { method, headers }
  if (options.body !== undefined) {
    init.body = options.body
    if (options.contentType) headers['content-type'] = options.contentType
  }
  const request = new Request(url, init)
  const response = await route.fetch(request)
  if (options.raw) return response
  const text = await response.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = { __raw: text }
  }
  return { status: response.status, ok: response.ok, headers: response.headers, data, text }
}

function q(params) {
  return Object.keys(params)
    .map((key) => encodeURIComponent(key) + '=' + encodeURIComponent(String(params[key])))
    .join('&')
}

/* ---------------- 开始 ---------------- */

console.log('dsh-my-computer 冒烟测试')
console.log('  插件目录：' + PKG_ROOT)
console.log('  临时目录：' + TMP_DIR)

section('路由注册')

checkEqual('注册了 11 条路由', registered.length, 11)
for (const route of registered) {
  const name = route.path.slice(route.path.lastIndexOf('/') + 1)
  const bodyModeOk = route.requestBody === 'buffered' || route.requestBody === 'streaming'
  if (!route.path.startsWith('/api/my-computer/')) {
    check('前缀必须是 /api/my-computer/（' + route.path + '）', false)
  }
  if (!Array.isArray(route.methods) || route.methods.length === 0) {
    check('methods 不能为空（' + name + '）', false)
  }
  if (!bodyModeOk) check('requestBody 必须是 buffered/streaming（' + name + '）', false)
  if (typeof route.fetch !== 'function') check('fetch 必须是函数（' + name + '）', false)
}
check('每条路由都有 path/methods/requestBody/fetch', registered.every((r) => r.path && r.methods && r.requestBody && typeof r.fetch === 'function'))
checkEqual('上传路由声明 streaming（否则大文件会被整体缓冲）', byId.get('upload').requestBody, 'streaming')

section('GET /drives')

const drivesRes = await call('drives')
checkEqual('/drives 状态码 200', drivesRes.status, 200)
const driveLetters = (drivesRes.data.drives || []).map((d) => d.letter)
check('至少列出 C: 和 D:', driveLetters.includes('C:') && driveLetters.includes('D:'), '实际：' + driveLetters.join(' '))
const dDrive = (drivesRes.data.drives || []).find((d) => d.letter === 'D:')
check('D: 带容量信息（statfs）', dDrive && typeof dDrive.total === 'number' && dDrive.total > 0, dDrive ? `total=${dDrive.total} free=${dDrive.free}` : '没有 D:')
check('D: 标了可写', dDrive && dDrive.writable === true)
check('/drives 不包含不存在的盘符（E: 之类）', !driveLetters.includes('E:') || fs.existsSync('E:\\'))

section('GET /list')

const listWs = await call('list', { query: q({ path: WORKSPACE }) })
checkEqual('/list 状态码 200', listWs.status, 200)
check('/list 返回目录项', Array.isArray(listWs.data.entries) && listWs.data.entries.length > 0, '共 ' + (listWs.data.entries || []).length + ' 项')
check('parent 是盘符根', listWs.data.parent === (HAS_D ? 'D:\\' : path.dirname(WORKSPACE)), 'parent=' + listWs.data.parent)
check('返回 total/free', typeof listWs.data.total === 'number' && typeof listWs.data.free === 'number')

const dirs = listWs.data.entries.filter((e) => e.kind === 'dir')
const files = listWs.data.entries.filter((e) => e.kind === 'file')
check('目录排在文件前面', dirs.length === 0 || files.length === 0 || listWs.data.entries.indexOf(dirs[0]) < listWs.data.entries.indexOf(files[0]))

const firstEntry = listWs.data.entries[0]
check('条目字段齐全（name/path/kind/size/mtime/ext）',
  firstEntry && typeof firstEntry.name === 'string' && typeof firstEntry.path === 'string' &&
  ['dir', 'file', 'link', 'other'].includes(firstEntry.kind) && 'size' in firstEntry && 'mtime' in firstEntry && 'ext' in firstEntry,
  firstEntry ? firstEntry.name + ' → ' + firstEntry.kind : '')

const rootList = await call('list', { query: q({ path: HAS_D ? 'D:\\' : path.parse(PKG_ROOT).root }) })
checkEqual('盘符根的 parent 是 null', rootList.data.parent, null)

section('错误路径（必须返回 ok:false，绝不抛异常）')

const badPath = await call('list', { query: q({ path: 'foo/bar' }) })
checkEqual('相对路径 → 400', badPath.status, 400)
checkEqual('相对路径 → INVALID_PATH', badPath.data.error && badPath.data.error.code, 'INVALID_PATH')

const emptyPath = await call('list', {})
checkEqual('缺少 path → 400', emptyPath.status, 400)

const missing = await call('list', { query: q({ path: HAS_D ? 'D:\\dsh-workspace\\__不存在的目录__' : path.join(PKG_ROOT, '__nope__') }) })
checkEqual('不存在的路径 → 404', missing.status, 404)
checkEqual('不存在 → NOT_FOUND', missing.data.error && missing.data.error.code, 'NOT_FOUND')

const asDir = await call('read', { query: q({ path: HAS_D ? 'D:\\' : PKG_ROOT }) })
checkEqual('把目录当文件读 → 400', asDir.status, 400)
checkEqual('目录当文件读 → IS_DIRECTORY', asDir.data.error && asDir.data.error.code, 'IS_DIRECTORY')

const badJson = await call('mkdir', { body: '{不是 json', contentType: 'application/json' })
checkEqual('非法 JSON 体 → 400', badJson.status, 400)

const wrongType = await call('mkdir', { body: 'x=1', contentType: 'text/plain' })
checkEqual('非 application/json → 415', wrongType.status, 415)

const crossSite = await call('list', { query: q({ path: WORKSPACE }), headers: { origin: 'https://evil.example' } })
checkEqual('跨站 Origin → 403', crossSite.status, 403)

const sameSite = await call('list', { query: q({ path: WORKSPACE }), headers: { origin: 'http://dsh.internal' } })
checkEqual('同源 Origin 放行 → 200', sameSite.status, 200)

section('GET /read')

const readSelf = await call('read', { query: q({ path: SMOKE_SELF }) })
checkEqual('/read 状态码 200', readSelf.status, 200)
check('读到本文件开头', typeof readSelf.data.text === 'string' && readSelf.data.text.startsWith('#!/usr/bin/env node'))
checkEqual('编码识别为 utf-8', readSelf.data.encoding, 'utf-8')
checkEqual('没被截断', readSelf.data.truncated, false)

const truncated = await call('read', { query: q({ path: SMOKE_SELF, maxBytes: 12 }) })
checkEqual('maxBytes 生效 → truncated', truncated.data.truncated, true)
checkEqual('maxBytes 生效 → 只回 12 字节', await readByteLength(truncated.data.text), 12)

const skipped = await call('read', { query: q({ path: 'D:\\node24\\node.exe' }) })
if (fs.existsSync('D:\\node24\\node.exe')) {
  checkEqual('二进制文件 → 415', skipped.status, 415)
  checkEqual('二进制文件 → BINARY_FILE', skipped.data.error && skipped.data.error.code, 'BINARY_FILE')
}

section('文件操作闭环（mkdir → list → rename → delete）')

await fsp.rm(TMP_DIR, { recursive: true, force: true })
await fsp.mkdir(TMP_DIR, { recursive: true })

const mk = await call('mkdir', {
  body: JSON.stringify({ path: TMP_DIR, name: '测试 目录' }),
  contentType: 'application/json',
})
checkEqual('/mkdir 状态码 200', mk.status, 200)
const madeDir = path.join(TMP_DIR, '测试 目录')
check('磁盘上真的建出来了', fs.existsSync(madeDir))

const listTmp = await call('list', { query: q({ path: TMP_DIR }) })
check('list 能看到新建目录', (listTmp.data.entries || []).some((e) => e.name === '测试 目录' && e.kind === 'dir'))

const mkAgain = await call('mkdir', {
  body: JSON.stringify({ path: TMP_DIR, name: '测试 目录' }),
  contentType: 'application/json',
})
checkEqual('重名 mkdir → 409', mkAgain.status, 409)
checkEqual('重名 mkdir → ALREADY_EXISTS', mkAgain.data.error && mkAgain.data.error.code, 'ALREADY_EXISTS')

const renamed = await call('rename', {
  body: JSON.stringify({ path: madeDir, name: '改名后' }),
  contentType: 'application/json',
})
checkEqual('/rename 状态码 200', renamed.status, 200)
check('原路径已不存在', !fs.existsSync(madeDir))
check('新路径存在', fs.existsSync(path.join(TMP_DIR, '改名后')))

const listAfterRename = await call('list', { query: q({ path: TMP_DIR }) })
check('list 能看到改名结果', (listAfterRename.data.entries || []).some((e) => e.name === '改名后'))

const delNoConfirm = await call('delete', {
  body: JSON.stringify({ paths: [path.join(TMP_DIR, '改名后')] }),
  contentType: 'application/json',
})
checkEqual('删除不带 confirm → 400', delNoConfirm.status, 400)
checkEqual('删除不带 confirm → CONFIRMATION_REQUIRED', delNoConfirm.data.error && delNoConfirm.data.error.code, 'CONFIRMATION_REQUIRED')
check('没有 confirm 时文件还在', fs.existsSync(path.join(TMP_DIR, '改名后')))

const delOk = await call('delete', {
  body: JSON.stringify({ paths: [path.join(TMP_DIR, '改名后')], confirm: true }),
  contentType: 'application/json',
})
checkEqual('/delete 状态码 200', delOk.status, 200)
checkEqual('deleted 数组长度 1', (delOk.data.deleted || []).length, 1)
check('磁盘上真的删掉了', !fs.existsSync(path.join(TMP_DIR, '改名后')))

const delRootGuard = await call('delete', {
  body: JSON.stringify({ paths: [HAS_D ? 'D:\\' : 'C:\\'], confirm: true }),
  contentType: 'application/json',
})
check('拒绝删除磁盘根目录', delRootGuard.status === 207 && (delRootGuard.data.failed || []).length === 1, 'failed=' + JSON.stringify((delRootGuard.data.failed || []).map((f) => f.code)))

section('POST /write + GET /read 回读')

const textPath = path.join(TMP_DIR, '笔记.txt')
const written = await call('write', {
  body: JSON.stringify({ path: textPath, text: '你好，DSH\n第二行\n第三行' }),
  contentType: 'application/json',
})
checkEqual('/write 状态码 200', written.status, 200)
check('返回 mtime', typeof written.data.mtime === 'number' && written.data.mtime > 0)
checkEqual('返回字节数（UTF-8 中文 3 字节）', written.data.size, Buffer.byteLength('你好，DSH\n第二行\n第三行'))

const readBack = await call('read', { query: q({ path: textPath }) })
checkEqual('/read 回读内容一致', readBack.data.text, '你好，DSH\n第二行\n第三行')

// GB18030 兜底：老的中文 Windows 文本文件
const gbkPath = path.join(TMP_DIR, 'gbk.txt')
await fsp.writeFile(gbkPath, Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4]))
const gbkRead = await call('read', { query: q({ path: gbkPath }) })
checkEqual('GBK 文件识别为 gb18030', gbkRead.data.encoding, 'gb18030')
checkEqual('GBK 文件解码正确', gbkRead.data.text, '中文测试')

section('PUT /upload + GET /download')

const payload = Buffer.alloc(256)
for (let i = 0; i < 256; i += 1) payload[i] = i

const up1 = await call('upload', {
  method: 'PUT',
  query: q({ path: TMP_DIR, name: 'up.bin' }),
  body: payload,
  contentType: 'application/octet-stream',
})
checkEqual('/upload 状态码 200', up1.status, 200)
checkEqual('落盘大小正确', up1.data.size, 256)
checkEqual('overwritten=false', up1.data.overwritten, false)

const up2 = await call('upload', {
  method: 'PUT',
  query: q({ path: TMP_DIR, name: 'up.bin' }),
  body: payload,
  contentType: 'application/octet-stream',
})
checkEqual('同名再传一次 → 409', up2.status, 409)
checkEqual('同名再传一次 → ALREADY_EXISTS', up2.data.error && up2.data.error.code, 'ALREADY_EXISTS')

const up3 = await call('upload', {
  method: 'PUT',
  query: q({ path: TMP_DIR, name: 'up.bin', overwrite: '1' }),
  body: Buffer.from('覆盖后的内容'),
  contentType: 'application/octet-stream',
})
checkEqual('overwrite=1 覆盖成功', up3.status, 200)
checkEqual('overwritten=true', up3.data.overwritten, true)
checkEqual('覆盖后大小变化', up3.data.size, Buffer.byteLength('覆盖后的内容'))

const badName = await call('upload', {
  method: 'PUT',
  query: q({ path: TMP_DIR, name: '..\\逃逸.txt' }),
  body: payload,
})
checkEqual('文件名带 ..\\ → 400', badName.status, 400)

const dl = await call('download', { query: q({ path: SMOKE_SELF }), raw: true })
checkEqual('/download 状态码 200', dl.status, 200)
const dlBuffer = Buffer.from(await dl.arrayBuffer())
check('下载内容与磁盘一致', dlBuffer.equals(await fsp.readFile(SMOKE_SELF)), dlBuffer.length + ' 字节')
check('Content-Disposition 是 attachment',
  String(dl.headers.get('content-disposition') || '').startsWith('attachment;'),
  String(dl.headers.get('content-disposition') || ''))
check('Content-Type 有值', Boolean(dl.headers.get('content-type')), String(dl.headers.get('content-type')))

const dlDir = await call('download', { query: q({ path: TMP_DIR }) })
checkEqual('下载目录 → 422（MVP 不做 zip）', dlDir.status, 422)
checkEqual('下载目录 → DIRECTORY_NOT_SUPPORTED', dlDir.data.error && dlDir.data.error.code, 'DIRECTORY_NOT_SUPPORTED')

section('POST /move')

const destDir = path.join(TMP_DIR, '目标目录')
await fsp.mkdir(destDir, { recursive: true })
const moved = await call('move', {
  body: JSON.stringify({ sources: [textPath], targetDir: destDir }),
  contentType: 'application/json',
})
checkEqual('/move 状态码 200', moved.status, 200)
check('源文件已消失', !fs.existsSync(textPath))
check('目标文件存在', fs.existsSync(path.join(destDir, '笔记.txt')))

const movedMissing = await call('move', {
  body: JSON.stringify({ sources: [path.join(TMP_DIR, '没有这个.txt')], targetDir: destDir }),
  contentType: 'application/json',
})
checkEqual('移动不存在的源 → 207（部分失败）', movedMissing.status, 207)
check('失败项带 code', (movedMissing.data.failed || []).length === 1)

section('GET /health')

const health = await call('health')
checkEqual('/health 状态码 200', health.status, 200)
checkEqual('health 报插件名', health.data.plugin, 'dsh-my-computer')

/* ---------------- 收尾 ---------------- */

await fsp.rm(TMP_DIR, { recursive: true, force: true })
check('临时目录已清理', !fs.existsSync(TMP_DIR))

const passed = checks.filter((c) => c.pass).length
const total = checks.length
console.log('\n' + '='.repeat(64))
console.log(`结果：${passed}/${total} 通过，${total - passed} 失败`)
console.log('='.repeat(64))
if (passed !== total) {
  console.log('\n失败项：')
  for (const c of checks) {
    if (!c.pass) console.log('  ✗ ' + c.name + (c.detail ? '  ' + c.detail : ''))
  }
  process.exitCode = 1
} else {
  console.log('全部通过。')
}

/* ---------------- 辅助 ---------------- */

async function readByteLength(text) {
  return Buffer.byteLength(text, 'utf8')
}
