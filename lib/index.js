// dsh-my-computer —— host 半侧（cordis 宿主插件，ESM，零 npm 依赖）
//
// 职责：把「整台 Windows」的文件系统暴露成一组同源 HTTP 路由，给右栏的
// 「我的电脑」面板用。用户人不在电脑旁，只能用手机通过 DSH 网页远程管理文件，
// 所以这里刻意不设 workspace 门卫——路径只校验「绝对 Windows 路径 + 存在」，
// 其余交给 Windows 自己的 ACL（出错就报错，不静默降级）。
//
// 安全模型（重要，别随手放宽）：
//   1) 路由挂在 DSH 的 /api 共享 fetch 通道下。DSH 的 connection 服务在分发
//      之前会检查 peer.principal.kind === "owner"（见 dsh-client-connection
//      createSharedFetchHandler），也就是说没有通过 DSH 鉴权的请求根本到不了这里。
//      注意：不要改用 ctx.webServer.register 的原生前缀路由——那条路不查 cookie、
//      不查 Host/Origin（见 dsh-host-webserver readResource 注释），等于把全盘
//      裸奔在端口上。
//   2) 另外自己再挡一层跨站：带 Origin 的请求其 host 必须与 Host 头一致，
//      防止别的网站用 form 提交打到这台机器（DSH 的 cookie 是 SameSite 保护的，
//      这层是纵深防御）。
//   3) dsh web 只 bind 127.0.0.1，外部经 tailscale serve / --public-url 转发，
//      因此"本机 loopback"由监听地址保证，不在这里判断 socket 地址。

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createZipArchive } from './zip.js'

export const name = 'dsh-my-computer'

// connection：必须，取 connection.fetch.register
export const inject = ['connection']

/** 路由前缀。必须是 /api/... 开头：connection 的精确路由只在该通道下分发。 */
const PREFIX = '/api/my-computer'

const DEFAULT_READ_BYTES = 512 * 1024
const HARD_READ_CAP = 8 * 1024 * 1024
const MAX_JSON_BODY = 8 * 1024 * 1024

const VERSION = '0.2.0'

/* ------------------------------------------------------------------ *
 * 错误与响应
 * ------------------------------------------------------------------ */

class CodedError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'CodedError'
    this.code = code
    this.status = status
  }
}

function fail(code, message, status = 400) {
  throw new CodedError(code, message, status)
}

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })
}

/** 把任意异常收敛成 {code, message, status}，绝不把栈泄露给客户端。 */
function normalizeError(error) {
  if (error instanceof CodedError) {
    return { code: error.code, message: error.message, status: error.status }
  }
  const errno = typeof error?.code === 'string' ? error.code : ''
  const message = String(error?.message || error || '未知错误')
  switch (errno) {
    case 'ENOENT':
      return { code: 'NOT_FOUND', message, status: 404 }
    case 'EACCES':
    case 'EPERM':
      return { code: 'PERMISSION_DENIED', message, status: 403 }
    case 'EEXIST':
      return { code: 'ALREADY_EXISTS', message, status: 409 }
    case 'ENOTDIR':
      return { code: 'NOT_DIRECTORY', message, status: 400 }
    case 'EISDIR':
      return { code: 'IS_DIRECTORY', message, status: 400 }
    case 'ENOTEMPTY':
      return { code: 'NOT_EMPTY', message, status: 409 }
    case 'EBUSY':
      return { code: 'BUSY', message, status: 423 }
    case 'ENOSPC':
      return { code: 'NO_SPACE', message, status: 507 }
    case 'ENAMETOOLONG':
      return { code: 'INVALID_NAME', message, status: 400 }
    default:
      return { code: errno || 'IO_ERROR', message, status: 500 }
  }
}

function codeOf(error) {
  return normalizeError(error).code
}

function messageOf(error) {
  return normalizeError(error).message
}

/** 出错时把没读完的请求体丢弃，否则桥接层会因为 body 未读完而挂住连接。 */
async function drain(request) {
  try {
    await request.body?.cancel()
  } catch {
    /* 已读完或已关闭 */
  }
}

/* ------------------------------------------------------------------ *
 * 路径工具
 * ------------------------------------------------------------------ */

/** 校验：必须是绝对 Windows 路径（盘符根或 UNC）。用户要全盘权限，这里不做门卫。 */
function requirePath(raw, label = 'path') {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (!value) fail('INVALID_PATH', `缺少 ${label} 参数（需要绝对 Windows 路径，如 D:\\foo）`, 400)
  if (value.includes('\u0000')) fail('INVALID_PATH', `${label} 含 NUL 字符`, 400)
  const isDrive = /^[A-Za-z]:[\\/]/.test(value)
  const isUnc = /^\\\\[^\\]/.test(value)
  if (!isDrive && !isUnc) {
    fail('INVALID_PATH', `${label} 必须是绝对路径（如 D:\\foo 或 \\\\server\\share），收到 ${JSON.stringify(value)}`, 400)
  }
  const normalized = path.win32.normalize(value)
  // 盘符统一大写，避免 C: 与 c: 被当成两个位置
  if (isDrive) return normalized.charAt(0).toUpperCase() + normalized.slice(1)
  return normalized
}

function isDriveRoot(p) {
  return /^[A-Za-z]:\\$/.test(p)
}

/** 目录的上一级；盘符根（及 UNC 根）返回 null。 */
function parentOf(p) {
  const normalized = path.win32.normalize(p)
  if (isDriveRoot(normalized)) return null
  const dir = path.win32.dirname(normalized)
  if (dir === normalized) return null
  return dir
}

/** 取路径所属盘符的容量（拿不到就返回 null）。 */
function capacityOf(p) {
  let root = p.slice(0, 3)
  if (!/^[A-Za-z]:\\$/.test(root)) {
    const parsed = path.win32.parse(p)
    root = parsed.root
  }
  if (!root) return null
  try {
    const sfs = fs.statfsSync(root)
    return { total: sfs.bsize * sfs.blocks, free: sfs.bsize * sfs.bavail }
  } catch {
    return null
  }
}

async function statOrFail(p, label = '路径') {
  try {
    return await fsp.stat(p)
  } catch (error) {
    if (error?.code === 'ENOENT') fail('NOT_FOUND', `${label}不存在：${p}`, 404)
    throw error
  }
}

/* ------------------------------------------------------------------ *
 * 文件名 / MIME / Content-Disposition
 * ------------------------------------------------------------------ */

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

function sanitizeName(raw) {
  const name = typeof raw === 'string' ? raw.trim() : ''
  if (!name) fail('INVALID_NAME', '缺少文件名（name 参数）', 400)
  if (name === '.' || name === '..') fail('INVALID_NAME', '文件名不能是 . 或 ..', 400)
  if (/[\\/]/.test(name)) fail('INVALID_NAME', '文件名不能包含路径分隔符', 400)
  // Windows 非法字符 + 控制字符
  if (/[<>:"|?*\u0000-\u001f]/.test(name)) fail('INVALID_NAME', '文件名包含 Windows 不允许的字符', 400)
  if (/[. ]$/.test(name)) fail('INVALID_NAME', '文件名不能以点或空格结尾（Windows 会截断）', 400)
  if (WINDOWS_RESERVED.test(name)) fail('INVALID_NAME', `"${name}" 是 Windows 保留设备名`, 400)
  if (name.length > 200) fail('INVALID_NAME', '文件名过长（>200 字符）', 400)
  return name
}

const MIME_BY_EXT = {
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.toml': 'text/plain; charset=utf-8',
  '.ini': 'text/plain; charset=utf-8',
  '.cfg': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.tsx': 'text/plain; charset=utf-8',
  '.jsx': 'text/plain; charset=utf-8',
  '.py': 'text/plain; charset=utf-8',
  '.sh': 'text/plain; charset=utf-8',
  '.bat': 'text/plain; charset=utf-8',
  '.cmd': 'text/plain; charset=utf-8',
  '.ps1': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.zip': 'application/zip',
  '.7z': 'application/x-7z-compressed',
  '.rar': 'application/vnd.rar',
  '.gz': 'application/gzip',
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.dll': 'application/vnd.microsoft.portable-executable',
  '.db': 'application/vnd.sqlite3',
}

function mimeOf(filePath) {
  const ext = path.win32.extname(filePath).toLowerCase()
  return MIME_BY_EXT[ext] || 'application/octet-stream'
}

/** RFC 6266 / 5987：ASCII 兜底 + UTF-8 文件名，中文名下载才不会变成乱码。 */
function contentDisposition(fileName, kind = 'attachment') {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

/* ------------------------------------------------------------------ *
 * 请求体 / 同源校验
 * ------------------------------------------------------------------ */

async function readJson(request) {
  const contentType = String(request.headers.get('content-type') || '').toLowerCase()
  if (!contentType.startsWith('application/json')) {
    fail('INVALID_REQUEST', '需要 application/json 请求体', 415)
  }
  const declared = Number(request.headers.get('content-length') || 0)
  if (declared > MAX_JSON_BODY) fail('TOO_LARGE', '请求体过大', 413)
  const text = await request.text()
  if (text.length > MAX_JSON_BODY) fail('TOO_LARGE', '请求体过大', 413)
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    fail('INVALID_REQUEST', '请求体不是合法 JSON', 400)
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    fail('INVALID_REQUEST', '请求体必须是 JSON 对象', 400)
  }
  return payload
}

/** 统一比较用的 host 形态：小写、去掉默认端口（有的反代会给 Host 补 :443）。 */
function normalizeHost(value, protocol) {
  const lower = String(value || '').toLowerCase()
  if (protocol === 'https:' && lower.endsWith(':443')) return lower.slice(0, -4)
  if (protocol === 'http:' && lower.endsWith(':80')) return lower.slice(0, -3)
  return lower
}

/** 跨站防护：带 Origin 的请求，其 host 必须与 Host 头一致。 */
function assertSameOrigin(request) {
  // 兜底开关：万一某天反代改写了 Host 导致这里误判，可以设
  // DSH_MY_COMPUTER_ALLOW_CROSS_ORIGIN=1 关掉这一层（只影响跨站判断，鉴权仍在 /api 通道上）。
  if (String(process.env.DSH_MY_COMPUTER_ALLOW_CROSS_ORIGIN || '') === '1') return
  const origin = request.headers.get('origin')
  if (!origin) return // 同源 GET 不带 Origin；非浏览器客户端也不带
  let parsed
  try {
    parsed = new URL(origin)
  } catch {
    fail('FORBIDDEN', `Origin 头格式不合法：${origin}`, 403)
  }
  const host = request.headers.get('host')
  if (!host) return // 拿不到 Host（非 HTTP 桥接）时不阻塞
  const left = normalizeHost(parsed.host, parsed.protocol)
  const right = normalizeHost(host, parsed.protocol)
  if (left !== right) {
    fail('FORBIDDEN', `跨站请求被拒绝（Origin=${left}，Host=${right}）`, 403)
  }
}

/* ------------------------------------------------------------------ *
 * 各路由实现
 * ------------------------------------------------------------------ */

/** GET /drives —— 探测 A:–Z:，能访问的都列出来。 */
function handleDrives() {
  const systemDrive = String(process.env.SystemDrive || 'C:').toUpperCase()
  const drives = []
  for (let i = 0; i < 26; i += 1) {
    const letter = String.fromCharCode(65 + i) + ':'
    const root = letter + '\\'
    let st
    try {
      st = fs.statSync(root)
    } catch {
      continue // 没这个盘符 / 盘符没插介质
    }
    if (!st.isDirectory()) continue
    const drive = {
      letter,
      label: letter.toUpperCase() === systemDrive ? '系统盘' : '本地磁盘',
      ok: true,
    }
    try {
      const sfs = fs.statfsSync(root)
      drive.total = sfs.bsize * sfs.blocks
      drive.free = sfs.bsize * sfs.bavail
    } catch {
      drive.total = null
      drive.free = null
    }
    try {
      fs.accessSync(root, fs.constants.W_OK)
      drive.writable = true
    } catch {
      drive.writable = false
    }
    drives.push(drive)
  }
  return json({ ok: true, drives })
}

/** GET /list?path= —— 列目录，目录在前、按名字排序。 */
async function handleList(request) {
  const url = new URL(request.url)
  const target = requirePath(url.searchParams.get('path'))
  const st = await statOrFail(target)
  if (!st.isDirectory()) fail('NOT_DIRECTORY', `不是目录：${target}`, 400)

  let dirents
  try {
    dirents = await fsp.readdir(target, { withFileTypes: true })
  } catch (error) {
    throw error // 交给 normalizeError（EACCES 等）
  }

  const entries = []
  for (const dirent of dirents) {
    const full = path.win32.join(target, dirent.name)
    const base = {
      name: dirent.name,
      path: full,
      ext: path.win32.extname(dirent.name).toLowerCase(),
    }
    let info
    try {
      info = await fsp.lstat(full)
    } catch (error) {
      // 单个条目 stat 失败不能拖垮整个列表：标成 other 并把原因带上
      entries.push({ ...base, kind: 'other', size: null, mtime: null, statError: messageOf(error) })
      continue
    }
    let kind = 'other'
    if (info.isSymbolicLink()) kind = 'link'
    else if (info.isDirectory()) kind = 'dir'
    else if (info.isFile()) kind = 'file'

    let meta = info
    let targetKind = null
    if (kind === 'link') {
      // 符号链接 / junction：真实属性的 kind 决定面板能不能点进去
      try {
        const real = await fsp.stat(full)
        meta = real
        targetKind = real.isDirectory() ? 'dir' : real.isFile() ? 'file' : 'other'
      } catch {
        targetKind = 'unknown' // 断链
      }
    }

    entries.push({
      ...base,
      kind,
      targetKind,
      size: targetKind === 'unknown' ? null : meta.size,
      mtime: targetKind === 'unknown' ? null : meta.mtimeMs,
    })
  }

  const rankOf = (entry) => {
    const effective = entry.kind === 'link' ? entry.targetKind : entry.kind
    if (effective === 'dir') return 0
    if (effective === 'file') return 1
    if (effective === 'other') return 2
    return 3 // link 但目标未知（断链）
  }

  entries.sort((a, b) => {
    const ra = rankOf(a)
    const rb = rankOf(b)
    if (ra !== rb) return ra - rb
    return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' })
  })

  const capacity = capacityOf(target)
  return json({
    ok: true,
    path: target,
    parent: parentOf(target),
    entries,
    count: entries.length,
    total: capacity ? capacity.total : null,
    free: capacity ? capacity.free : null,
  })
}

const BOM_UTF8 = Buffer.from([0xef, 0xbb, 0xbf])

/** GET /read?path=&maxBytes= —— 文本预览，UTF-8 优先、GB18030 兜底、二进制明确拒绝。 */
async function handleRead(request) {
  const url = new URL(request.url)
  const target = requirePath(url.searchParams.get('path'))
  const rawMax = Number(url.searchParams.get('maxBytes'))
  const maxBytes = Number.isFinite(rawMax) && rawMax > 0
    ? Math.min(Math.floor(rawMax), HARD_READ_CAP)
    : DEFAULT_READ_BYTES

  const st = await statOrFail(target)
  if (st.isDirectory()) fail('IS_DIRECTORY', `这是目录，不能做文本预览：${target}`, 400)

  const take = Math.min(st.size, maxBytes)
  const handle = await fsp.open(target, 'r')
  let buffer
  try {
    buffer = Buffer.alloc(take)
    let offset = 0
    while (offset < take) {
      const { bytesRead } = await handle.read(buffer, offset, take - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset < take) buffer = buffer.subarray(0, offset)
  } finally {
    await handle.close()
  }

  // 二进制嗅探：前 8KB 里有 NUL 基本就不是文本
  const sniff = buffer.subarray(0, Math.min(buffer.length, 8192))
  if (sniff.includes(0)) {
    fail('BINARY_FILE', `这是二进制文件（${st.size} 字节），无法做文本预览，请用「下载」`, 415)
  }

  let encoding = 'utf-8'
  let text = null
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    try {
      // Node 24 自带 full-icu，GB18030 可直接解；中文 Windows 的老文件多半是它
      text = new TextDecoder('gb18030', { fatal: true }).decode(buffer)
      encoding = 'gb18030'
    } catch {
      fail('BINARY_FILE', '文件不是可识别的文本编码（既不是 UTF-8 也不是 GB18030），请用「下载」', 415)
    }
  }

  if (encoding === 'utf-8' && text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  else if (buffer.subarray(0, 3).equals(BOM_UTF8)) text = text.replace(/^\ufeff/, '')

  return json({
    ok: true,
    path: target,
    size: st.size,
    mtime: st.mtimeMs,
    maxBytes,
    truncated: st.size > take,
    encoding,
    text,
  })
}

/** 同目录临时文件名（隐藏前缀，避免和用户文件撞名）。 */
function tempNameNear(dir, tag) {
  const rand = Math.random().toString(36).slice(2, 10)
  return path.win32.join(dir, `.dsh-mc-${tag}-${Date.now()}-${rand}.tmp`)
}

/** POST /write {path, text} —— 先写临时文件再 rename，避免写一半断电留下半截文件。 */
async function handleWrite(request) {
  const payload = await readJson(request)
  const target = requirePath(payload.path)
  if (typeof payload.text !== 'string') fail('INVALID_TEXT', 'text 必须是字符串', 400)

  const dir = path.win32.dirname(target)
  const dirStat = await statOrFail(dir, '目标目录')
  if (!dirStat.isDirectory()) fail('NOT_DIRECTORY', `目标目录不是目录：${dir}`, 400)

  const tmp = tempNameNear(dir, 'write')
  try {
    await fsp.writeFile(tmp, payload.text, 'utf8')
    await fsp.rename(tmp, target)
  } catch (error) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    throw error
  }
  const st = await fsp.stat(target)
  return json({ ok: true, path: target, size: st.size, mtime: st.mtimeMs })
}

/** GET /download?path= —— 单文件流式下载；目录明确拒绝（MVP 不做 zip）。 */
async function handleDownload(request) {
  const url = new URL(request.url)
  const target = requirePath(url.searchParams.get('path'))
  const st = await statOrFail(target)
  if (st.isDirectory()) {
    fail('IS_DIRECTORY', '这是目录，单文件下载不支持；整目录请用 /download-dir 打包成 zip', 400)
  }

  const headers = {
    'content-type': mimeOf(target),
    'content-length': String(st.size),
    'content-disposition': contentDisposition(path.win32.basename(target)),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  }
  const stream = fs.createReadStream(target)
  return new Response(Readable.toWeb(stream), { status: 200, headers })
}

/**
 * GET /download-dir?path= —— 整目录打包成 zip 流式下发（不落临时文件）。
 *
 * 发响应头之前已经把目录扫了一遍（条目数 / 总字节 / 可读性），所以「太大」
 * 「空目录」这类问题会以 JSON 错误体正常返回，而不是下载到一半断掉。
 * 中间读失败的文件会跳过，并把清单打在宿主日志里（压缩包本身仍然完整）。
 */
async function handleDownloadDir(request) {
  const url = new URL(request.url)
  const target = requirePath(url.searchParams.get('path'))
  const st = await statOrFail(target)
  if (!st.isDirectory()) {
    fail('NOT_DIRECTORY', `不是目录：${target}（单文件请用 /download）`, 400)
  }
  if (isDriveRoot(target)) {
    fail('FORBIDDEN', '整盘打包请进入具体目录后再下载（盘符根通常几十万文件）', 403)
  }

  const warnings = []
  const archive = await createZipArchive(target, {
    fail,
    onWarn: (info) => {
      warnings.push(info)
      if (warnings.length <= 20) {
        console.warn(`[dsh-my-computer] zip 跳过 ${info.path}：${info.message}`)
      }
    },
  })

  const headers = {
    'content-type': 'application/zip',
    'content-disposition': contentDisposition(archive.filename),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    // 面板拿来显示进度提示（非标准头，纯提示；跨站读不到也无所谓）
    'x-zip-entries': String(archive.entries),
    'x-zip-bytes': String(archive.bytes),
    'x-zip-skipped': String(warnings.length),
  }
  return new Response(Readable.toWeb(Readable.from(archive.parts)), { status: 200, headers })
}

/** PUT /upload?path=<目录>&name=<文件名>[&overwrite=1] —— 原始二进制流式落盘。 */
async function handleUpload(request) {
  const url = new URL(request.url)
  const dir = requirePath(url.searchParams.get('path'))
  const name = sanitizeName(url.searchParams.get('name'))
  const overwrite = url.searchParams.get('overwrite') === '1'

  const dirStat = await statOrFail(dir, '目标目录')
  if (!dirStat.isDirectory()) fail('NOT_DIRECTORY', `目标不是目录：${dir}`, 400)

  const target = path.win32.join(dir, name)
  let existing = null
  try {
    existing = await fsp.lstat(target)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (existing) {
    if (existing.isDirectory()) fail('ALREADY_EXISTS', `同名目录已存在：${name}`, 409)
    if (!overwrite) {
      fail('ALREADY_EXISTS', `同名文件已存在：${name}（覆盖请带 ?overwrite=1）`, 409)
    }
  }
  if (!request.body) fail('INVALID_REQUEST', '上传请求体为空', 400)

  const tmp = tempNameNear(dir, 'upload')
  try {
    await pipeline(Readable.fromWeb(request.body), fs.createWriteStream(tmp))
    if (existing) await fsp.rm(target, { force: true })
    await fsp.rename(tmp, target)
  } catch (error) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    throw error
  }
  const st = await fsp.stat(target)
  return json({
    ok: true,
    path: target,
    name,
    size: st.size,
    mtime: st.mtimeMs,
    overwritten: Boolean(existing),
  })
}

/** POST /mkdir {path, name} —— path 是父目录。 */
async function handleMkdir(request) {
  const payload = await readJson(request)
  const dir = requirePath(payload.path)
  const name = sanitizeName(payload.name)
  const dirStat = await statOrFail(dir, '父目录')
  if (!dirStat.isDirectory()) fail('NOT_DIRECTORY', `父路径不是目录：${dir}`, 400)

  const target = path.win32.join(dir, name)
  try {
    await fsp.mkdir(target) // 不带 recursive：已存在要报错，不能静默成功
  } catch (error) {
    if (error?.code === 'EEXIST') fail('ALREADY_EXISTS', `同名文件或文件夹已存在：${name}`, 409)
    throw error
  }
  const st = await fsp.stat(target)
  return json({ ok: true, path: target, name, mtime: st.mtimeMs })
}

/** POST /rename {path, name} —— 同目录改名（不做跨目录移动，那是 /move）。 */
async function handleRename(request) {
  const payload = await readJson(request)
  const source = requirePath(payload.path)
  const name = sanitizeName(payload.name)
  if (isDriveRoot(source)) fail('FORBIDDEN', '不能重命名磁盘根目录', 403)

  await statOrFail(source)
  const target = path.win32.join(path.win32.dirname(source), name)
  if (target === source) return json({ ok: true, path: target, name, unchanged: true })

  let targetExists = false
  try {
    await fsp.lstat(target)
    targetExists = true
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (targetExists) fail('ALREADY_EXISTS', `目标已存在：${name}`, 409)

  await fsp.rename(source, target)
  return json({ ok: true, path: target, name, from: source })
}

/** POST /delete {paths:[...], confirm:true} —— 递归删除，必须显式确认。 */
async function handleDelete(request) {
  const payload = await readJson(request)
  if (payload.confirm !== true) {
    fail('CONFIRMATION_REQUIRED', '删除是不可逆操作，需要 confirm:true 才执行', 400)
  }
  const rawList = Array.isArray(payload.paths) ? payload.paths : payload.path ? [payload.path] : []
  if (rawList.length === 0) fail('INVALID_REQUEST', 'paths 不能为空', 400)

  const deleted = []
  const failed = []
  for (const raw of rawList) {
    try {
      const target = requirePath(raw)
      if (isDriveRoot(target)) fail('FORBIDDEN', '拒绝删除整个磁盘根目录', 403)
      await fsp.rm(target, { recursive: true, force: false, maxRetries: 2 })
      deleted.push(target)
    } catch (error) {
      failed.push({ path: String(raw), code: codeOf(error), message: messageOf(error) })
    }
  }
  return json(
    { ok: failed.length === 0, deleted, failed },
    failed.length === 0 ? 200 : 207,
  )
}

/** POST /move {sources:[...], targetDir} —— 剪切粘贴；跨盘自动退化成 复制+删除。 */
async function handleMove(request) {
  const payload = await readJson(request)
  const sources = Array.isArray(payload.sources) ? payload.sources : []
  if (sources.length === 0) fail('INVALID_REQUEST', 'sources 不能为空', 400)
  const targetDir = requirePath(payload.targetDir, 'targetDir')
  const dirStat = await statOrFail(targetDir, '目标目录')
  if (!dirStat.isDirectory()) fail('NOT_DIRECTORY', `目标不是目录：${targetDir}`, 400)

  const moved = []
  const failed = []
  for (const raw of sources) {
    try {
      const source = requirePath(raw)
      if (isDriveRoot(source)) fail('FORBIDDEN', '拒绝移动整个磁盘根目录', 403)
      const name = path.win32.basename(source)
      const target = path.win32.join(targetDir, name)
      if (path.win32.dirname(source).toLowerCase() === targetDir.toLowerCase() && name === path.win32.basename(source)) {
        // 同目录"移动"= 什么都不做
        moved.push({ from: source, to: target, unchanged: true })
        continue
      }
      let targetExists = false
      try {
        await fsp.lstat(target)
        targetExists = true
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      if (targetExists) fail('ALREADY_EXISTS', `目标已存在：${target}`, 409)
      // 目标不能是自己的子目录
      if (target.toLowerCase().startsWith(source.toLowerCase() + '\\')) {
        fail('SELF_DESCENDANT', '不能把目录移动到它自己里面', 400)
      }
      try {
        await fsp.rename(source, target)
      } catch (error) {
        if (error?.code !== 'EXDEV') throw error
        await fsp.cp(source, target, { recursive: true, errorOnExist: true, force: false })
        await fsp.rm(source, { recursive: true, force: false })
      }
      moved.push({ from: source, to: target })
    } catch (error) {
      failed.push({ path: String(raw), code: codeOf(error), message: messageOf(error) })
    }
  }
  return json({ ok: failed.length === 0, moved, failed }, failed.length === 0 ? 200 : 207)
}

/** GET /health —— 面板自检用（也方便人工 curl 确认插件活着）。 */
function handleHealth() {
  return json({
    ok: true,
    plugin: 'dsh-my-computer',
    version: VERSION,
    platform: process.platform,
    node: process.versions.node,
    root: '整盘（无 workspace 限制）',
    at: Date.now(),
  })
}

/* ------------------------------------------------------------------ *
 * 路由表
 * ------------------------------------------------------------------ */

const ROUTES = [
  { id: 'health', path: PREFIX + '/health', methods: ['GET'], requestBody: 'buffered', run: handleHealth },
  { id: 'drives', path: PREFIX + '/drives', methods: ['GET'], requestBody: 'buffered', run: handleDrives },
  { id: 'list', path: PREFIX + '/list', methods: ['GET'], requestBody: 'buffered', run: handleList },
  { id: 'read', path: PREFIX + '/read', methods: ['GET'], requestBody: 'buffered', run: handleRead },
  { id: 'download', path: PREFIX + '/download', methods: ['GET'], requestBody: 'buffered', run: handleDownload },
  { id: 'downloadDir', path: PREFIX + '/download-dir', methods: ['GET'], requestBody: 'buffered', run: handleDownloadDir },
  { id: 'write', path: PREFIX + '/write', methods: ['POST'], requestBody: 'buffered', run: handleWrite },
  { id: 'upload', path: PREFIX + '/upload', methods: ['PUT'], requestBody: 'streaming', run: handleUpload },
  { id: 'mkdir', path: PREFIX + '/mkdir', methods: ['POST'], requestBody: 'buffered', run: handleMkdir },
  { id: 'rename', path: PREFIX + '/rename', methods: ['POST'], requestBody: 'buffered', run: handleRename },
  { id: 'delete', path: PREFIX + '/delete', methods: ['POST'], requestBody: 'buffered', run: handleDelete },
  { id: 'move', path: PREFIX + '/move', methods: ['POST'], requestBody: 'buffered', run: handleMove },
]

/** 把单个路由包成「永不抛异常」的 fetch handler。 */
function wrap(route) {
  return async (request) => {
    try {
      assertSameOrigin(request)
      return await route.run(request)
    } catch (error) {
      await drain(request)
      const problem = normalizeError(error)
      // 只有真正意外（5xx）才往宿主日志里写一行；400/404/409 这类是面板的正常
      // 交互结果，不该把 dsh.log 刷满。
      if (problem.status >= 500) {
        try {
          console.warn(`[dsh-my-computer] ${route.id} 失败：${problem.code} ${problem.message}`)
        } catch {
          /* 日志本身失败也不管 */
        }
      }
      return json({ ok: false, error: { code: problem.code, message: problem.message }, route: route.id }, problem.status)
    }
  }
}

/* ------------------------------------------------------------------ *
 * 插件入口
 * ------------------------------------------------------------------ */

export async function apply(ctx, config) {
  const enabled = config?.enabled === false ? false : true
  if (!enabled) {
    ctx.logger?.info?.('[dsh-my-computer] 配置 enabled=false，跳过注册')
    return
  }

  for (const route of ROUTES) {
    const registration = {
      path: route.path,
      methods: route.methods,
      requestBody: route.requestBody,
      fetch: wrap(route),
    }
    ctx.effect(() => ctx.connection.fetch.register(registration))
  }

  const label = ROUTES.map((r) => `${r.methods.join('/')} ${r.path}`).join(', ')
  ctx.logger?.info?.(`[dsh-my-computer] 已注册 ${ROUTES.length} 条路由：${label}`)
}

/** 给 tools/smoke.mjs 复用：直接拿到未包壳的 handler 也能测。 */
export const internals = { ROUTES, wrap, PREFIX, VERSION, requirePath, parentOf, sanitizeName }
