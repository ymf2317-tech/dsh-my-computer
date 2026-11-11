// dsh-my-computer —— 整目录打包（零依赖、流式、边读边发）
//
// 为什么自己写：这个插件承诺零 npm 依赖（profile 里 pnpm prune 会干掉
// extraneous 包），为了一个 zip 引入 archiver / yazl 不划算，而 Node 自带
// 的 zlib.deflateRawSync 已经足够——zip 的「压缩」就是把 deflateRaw 的字节
// 塞进文件条目里。
//
// 策略（对手机远程下载友好）：
//   * 小文件（<= 8MB）先读进内存 → 试压 → 压不动的就 STORE，压得动的用 DEFLATE，
//     两种都能在写本地头之前知道大小和 CRC，不必用数据描述符；
//   * 大文件 STORE + 流式，靠数据描述符（bit 3）补 CRC/大小，内存恒定；
//   * 一律带 UTF-8 名字标志（bit 11），中文文件名解压不乱码；
//   * 目录条目带尾部 '/'，空目录也能还原；
//   * 打包前先扫一遍做上限检查（条目数 / 总字节），超了在发响应头之前就报错，
//     避免「下载了一半才失败」。
//
// 不支持（明确报错，不静默降级）：Zip64（>4GB 或 >65535 个条目）。真需要就分批。

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'

const MAX_ENTRIES = 20000
const MAX_TOTAL_BYTES = 3.9 * 1000 * 1000 * 1000 // 留出 Zip64 阈值的余量
const INLINE_LIMIT = 8 * 1024 * 1024 // 进内存试压的上限

/** 已经是压缩格式的扩展名，再 deflate 只是白烧 CPU。 */
const INCOMPRESSIBLE = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.heic', '.bmp', '.ico',
  '.mp4', '.mov', '.mkv', '.avi', '.webm', '.mp3', '.m4a', '.aac', '.ogg', '.flac', '.wav',
  '.zip', '.7z', '.rar', '.gz', '.bz2', '.xz', '.zst', '.tgz',
  '.pdf', '.docx', '.xlsx', '.pptx', '.odt', '.epub',
  '.apk', '.exe', '.dll', '.msi', '.iso', '.bin', '.pak',
  '.db', '.sqlite', '.sqlite3', '.woff', '.woff2', '.ttf', '.otf',
])

/* ------------------------------------------------------------------ *
 * CRC32（zip 用的多项式，查表法）
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[i] = c
  }
  return table
})()

function crc32(buffer) {
  let crc = -1
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff]
  }
  return (crc ^ -1) >>> 0
}

/* ------------------------------------------------------------------ *
 * 时间戳 → DOS 时间
 * ------------------------------------------------------------------ */

function dosDateTime(ms) {
  const d = ms ? new Date(ms) : new Date()
  const year = d.getFullYear()
  if (!Number.isFinite(year) || year < 1980) return { date: 0x21, time: 0 }
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)
  return { date: date & 0xffff, time: time & 0xffff }
}

/* ------------------------------------------------------------------ *
 * 扫描：先看清要打什么，才能在写响应头之前做上限判断
 * ------------------------------------------------------------------ */

async function scanDir(rootDir, { fail, onWarn }) {
  const items = []
  let totalBytes = 0

  async function walk(absDir, relDir) {
    let dirents
    try {
      dirents = await fsp.readdir(absDir, { withFileTypes: true })
    } catch (error) {
      // 读不动的子目录不要整个打包跟着失败，跳过并记一笔
      onWarn?.({ path: absDir, message: String(error?.message || error) })
      return
    }
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const dirent of dirents) {
      const abs = path.win32.join(absDir, dirent.name)
      const rel = relDir ? relDir + '/' + dirent.name : dirent.name
      const isLink = dirent.isSymbolicLink()
      let st
      try {
        // 快捷方式/链接按「不跟随」处理：跟随可能绕成环，也可能跨到别的盘
        st = isLink ? await fsp.lstat(abs) : await fsp.stat(abs)
      } catch (error) {
        onWarn?.({ path: abs, message: String(error?.message || error) })
        continue
      }
      if (isLink) {
        onWarn?.({ path: abs, message: '跳过符号链接/快捷方式（避免打包出环）' })
        continue
      }
      if (st.isDirectory()) {
        items.push({ kind: 'dir', abs, rel, size: 0, mtimeMs: st.mtimeMs })
        if (items.length > MAX_ENTRIES) fail('ZIP_TOO_MANY_ENTRIES', `目录内条目超过 ${MAX_ENTRIES} 个，请分批下载`, 413)
        await walk(abs, rel)
      } else if (st.isFile()) {
        totalBytes += st.size
        items.push({ kind: 'file', abs, rel, size: st.size, mtimeMs: st.mtimeMs })
        if (items.length > MAX_ENTRIES) fail('ZIP_TOO_MANY_ENTRIES', `目录内条目超过 ${MAX_ENTRIES} 个，请分批下载`, 413)
        if (totalBytes > MAX_TOTAL_BYTES) {
          fail('ZIP_TOO_LARGE', '目录内容超过 3.9GB（Zip64 未支持），请分批下载', 413)
        }
      } else {
        onWarn?.({ path: abs, message: '跳过非常规文件（设备/管道等）' })
      }
    }
  }

  await walk(rootDir, '')
  return { items, totalBytes }
}

/* ------------------------------------------------------------------ *
 * 结构体小工具
 * ------------------------------------------------------------------ */

function localHeader({ nameBuf, method, crc, compSize, size, dos, flags }) {
  const head = Buffer.alloc(30)
  head.writeUInt32LE(0x04034b50, 0)
  head.writeUInt16LE(20, 4) // version needed
  head.writeUInt16LE(flags, 6)
  head.writeUInt16LE(method, 8)
  head.writeUInt16LE(dos.time, 10)
  head.writeUInt16LE(dos.date, 12)
  head.writeUInt32LE(crc, 14)
  head.writeUInt32LE(compSize, 18)
  head.writeUInt32LE(size, 22)
  head.writeUInt16LE(nameBuf.length, 26)
  head.writeUInt16LE(0, 28) // extra
  return Buffer.concat([head, nameBuf])
}

function dataDescriptor({ crc, compSize, size }) {
  const buf = Buffer.alloc(16)
  buf.writeUInt32LE(0x08074b50, 0)
  buf.writeUInt32LE(crc, 4)
  buf.writeUInt32LE(compSize, 8)
  buf.writeUInt32LE(size, 12)
  return buf
}

function centralHeader(entry) {
  const head = Buffer.alloc(46)
  head.writeUInt32LE(0x02014b50, 0)
  head.writeUInt16LE(20, 4) // version made by
  head.writeUInt16LE(20, 6) // version needed
  head.writeUInt16LE(entry.flags, 8)
  head.writeUInt16LE(entry.method, 10)
  head.writeUInt16LE(entry.dos.time, 12)
  head.writeUInt16LE(entry.dos.date, 14)
  head.writeUInt32LE(entry.crc, 16)
  head.writeUInt32LE(entry.compSize, 20)
  head.writeUInt32LE(entry.size, 24)
  head.writeUInt16LE(entry.nameBuf.length, 28)
  head.writeUInt16LE(0, 30) // extra len
  head.writeUInt16LE(0, 32) // comment len
  head.writeUInt16LE(0, 34) // disk number start
  head.writeUInt16LE(0, 36) // internal attrs
  head.writeUInt32LE(entry.kind === 'dir' ? 0x10 : 0x20, 38) // external attrs
  head.writeUInt32LE(entry.offset, 42)
  return Buffer.concat([head, entry.nameBuf])
}

function endOfCentralDirectory({ count, cdSize, cdOffset }) {
  const buf = Buffer.alloc(22)
  buf.writeUInt32LE(0x06054b50, 0)
  buf.writeUInt16LE(0, 4)
  buf.writeUInt16LE(0, 6)
  buf.writeUInt16LE(count, 8)
  buf.writeUInt16LE(count, 10)
  buf.writeUInt32LE(cdSize, 12)
  buf.writeUInt32LE(cdOffset, 16)
  buf.writeUInt16LE(0, 20)
  return buf
}

const FLAG_UTF8 = 0x0800
const FLAG_DESCRIPTOR = 0x0008

async function* streamFile(abs, size) {
  const stream = fs.createReadStream(abs, { highWaterMark: 256 * 1024 })
  for await (const chunk of stream) {
    yield chunk
  }
  if (size === 0) yield Buffer.alloc(0)
}

/* ------------------------------------------------------------------ *
 * 主入口：返回 { parts, entries, bytes, skipped }
 *   parts —— 异步生成器，yield Buffer（可以直接 Readable.from 成响应体）
 * ------------------------------------------------------------------ */

export async function createZipArchive(rootDir, options = {}) {
  const { fail, onWarn } = options
  const mustFail = fail || ((code, message, status) => {
    const error = new Error(message)
    error.code = code
    error.status = status
    throw error
  })

  const rootName = path.win32.basename(rootDir) || 'archive'
  const { items, totalBytes } = await scanDir(rootDir, { fail: mustFail, onWarn })
  if (items.length === 0) {
    mustFail('ZIP_EMPTY', '这个目录是空的，没有可打包的内容', 400)
  }
  if (items.length >= 0xffff) {
    mustFail('ZIP_TOO_MANY_ENTRIES', `条目数 ${items.length} 超过 65535（Zip64 未支持）`, 413)
  }

  async function* parts() {
    let offset = 0
    const central = []
    const skipped = []

    for (const item of items) {
      const entryName = item.rel ? rootName + '/' + item.rel : rootName + '/'
      const nameForZip = item.kind === 'dir' ? entryName.replace(/\/?$/, '/') : entryName
      const nameBuf = Buffer.from(nameForZip, 'utf8')
      const dos = dosDateTime(item.mtimeMs)
      const entryOffset = offset

      if (item.kind === 'dir') {
        const header = localHeader({
          nameBuf,
          method: 0,
          crc: 0,
          compSize: 0,
          size: 0,
          dos,
          flags: FLAG_UTF8,
        })
        yield header
        offset += header.length
        central.push({ kind: 'dir', nameBuf, method: 0, crc: 0, compSize: 0, size: 0, dos, flags: FLAG_UTF8, offset: entryOffset })
        continue
      }

      let handled = false
      if (item.size <= INLINE_LIMIT) {
        let data
        try {
          data = await fsp.readFile(item.abs)
        } catch (error) {
          skipped.push({ path: item.abs, message: String(error?.message || error) })
          onWarn?.({ path: item.abs, message: String(error?.message || error) })
          continue
        }
        const crc = crc32(data)
        let method = 0
        let payload = data
        const ext = path.win32.extname(item.abs).toLowerCase()
        if (data.length > 0 && !INCOMPRESSIBLE.has(ext)) {
          const deflated = zlib.deflateRawSync(data, { level: 6 })
          if (deflated.length < data.length) {
            method = 8
            payload = deflated
          }
        }
        const header = localHeader({
          nameBuf,
          method,
          crc,
          compSize: payload.length,
          size: data.length,
          dos,
          flags: FLAG_UTF8,
        })
        yield header
        if (payload.length > 0) yield payload
        offset += header.length + payload.length
        central.push({
          kind: 'file',
          nameBuf,
          method,
          crc,
          compSize: payload.length,
          size: data.length,
          dos,
          flags: FLAG_UTF8,
          offset: entryOffset,
        })
        handled = true
      }

      if (!handled) {
        // 大文件：STORE + 数据描述符，内存恒定
        const flags = FLAG_UTF8 | FLAG_DESCRIPTOR
        const header = localHeader({ nameBuf, method: 0, crc: 0, compSize: 0, size: 0, dos, flags })
        yield header
        offset += header.length
        let crc = -1
        let written = 0
        try {
          for await (const chunk of streamFile(item.abs, item.size)) {
            if (chunk.length === 0) continue
            for (let i = 0; i < chunk.length; i += 1) {
              crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ chunk[i]) & 0xff]
            }
            written += chunk.length
            offset += chunk.length
            yield chunk
          }
        } catch (error) {
          // 已经写出去一半的文件没法撤回，只能在中央目录里标成 0 长度并记一笔
          skipped.push({ path: item.abs, message: String(error?.message || error) })
          onWarn?.({ path: item.abs, message: String(error?.message || error) })
          written = 0
          crc = -1
        }
        const finalCrc = (crc ^ -1) >>> 0
        const descriptor = dataDescriptor({ crc: finalCrc, compSize: written, size: written })
        yield descriptor
        offset += descriptor.length
        central.push({
          kind: 'file',
          nameBuf,
          method: 0,
          crc: finalCrc,
          compSize: written,
          size: written,
          dos,
          flags,
          offset: entryOffset,
        })
      }
    }

    const cdOffset = offset
    let cdSize = 0
    for (const entry of central) {
      const header = centralHeader(entry)
      yield header
      cdSize += header.length
    }
    const eocd = endOfCentralDirectory({ count: central.length, cdSize, cdOffset })
    yield eocd
  }

  return {
    filename: rootName + '.zip',
    entries: items.length,
    bytes: totalBytes,
    parts: parts(),
  }
}

export const internals = { crc32, dosDateTime, MAX_ENTRIES, MAX_TOTAL_BYTES, INLINE_LIMIT }
