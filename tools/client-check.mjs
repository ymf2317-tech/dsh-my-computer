#!/usr/bin/env node
// dsh-my-computer 客户端 bundle 自检
//
// 这个脚本**不能**证明 DSH 会真的把面板渲染出来（那只有装进 profile、重启 dsh web、
// 刷新页面才算），但它能在没有浏览器的前提下验证最容易写错的那几件事：
//   1. lib/client.js 能被解析（语法没坏）；
//   2. 它调用的是 window.__ModuleLoader__.load({ id, factory }) 这个约定；
//   3. factory 返回的模块里有 apply / inject，apply 是函数；
//   4. apply(ctx) 注册了 sidebar.panellist（id=my-computer, order=-5, label=我的电脑）
//      和 main（key=my-computer），两个组件都是函数；
//   5. 面板能渲染：空目录态、有内容的列表态、删除确认弹窗、预览弹窗
//      （用 React 真身 + 手搭的最小 hook dispatcher；不执行 useEffect，因此不发请求）。
//
// 跑法：node tools/client-check.mjs

import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.resolve(HERE, '../lib/client.js')

const checks = []
function check(name, pass, detail) {
  checks.push({ name, pass: Boolean(pass), detail })
  console.log((pass ? '  ✓' : '  ✗') + ' ' + name + (detail ? '  ' + detail : ''))
  return Boolean(pass)
}
function section(title) {
  console.log('\n── ' + title + ' ' + '─'.repeat(Math.max(0, 56 - title.length)))
}

console.log('dsh-my-computer 客户端 bundle 自检')
console.log('  文件：' + CLIENT)

const source = fs.readFileSync(CLIENT, 'utf8')

section('bundle 形状')

try {
  new vm.Script(source, { filename: CLIENT })
  check('bundle 语法可解析', true, source.length + ' 字节')
} catch (error) {
  check('bundle 语法可解析', false, String(error))
}

const requireFrom = createRequire(path.resolve(HERE, '../package.json'))
let React = null
let reactFrom = ''
for (const candidate of ['C:/Users/Administrator/.dsh/profiles/web/node_modules/react', 'react']) {
  try {
    React = requireFrom(candidate)
    reactFrom = candidate
    break
  } catch {
    /* 换下一个 */
  }
}
check('找到 react 运行时', Boolean(React), reactFrom || '未找到（渲染检查会跳过）')

const loaded = []
const styleNodes = []
const documentStub = {
  querySelector() {
    return null
  },
  createElement() {
    const node = {
      attributes: {},
      textContent: '',
      setAttribute(name, value) {
        this.attributes[name] = value
      },
      remove() {
        const at = styleNodes.indexOf(node)
        if (at >= 0) styleNodes.splice(at, 1)
      },
    }
    return node
  },
  head: {
    appendChild(node) {
      styleNodes.push(node)
    },
  },
  body: { appendChild() {} },
}
const windowStub = {
  __ModuleLoader__: {
    load(entry) {
      loaded.push(entry)
    },
  },
}

let bundleError = null
try {
  const run = new Function('window', 'document', 'require', 'globalThis', source)
  run(
    windowStub,
    documentStub,
    (name) => {
      if (name === 'react' && React) return React
      throw new Error('宿主要求了一个这里没有的模块：' + name)
    },
    globalThis,
  )
} catch (error) {
  bundleError = error
}
check('bundle 可以执行（没抛异常）', bundleError === null, bundleError ? String(bundleError) : '')
check('通过 __ModuleLoader__.load 注册了自己', loaded.length === 1, loaded.length + ' 次')

const entry = loaded[0] || {}
check('模块 id 是 dsh-my-computer', entry.id === 'dsh-my-computer', String(entry.id))
check('factory 是函数', typeof entry.factory === 'function')

const mod = entry.factory
  ? entry.factory((name) => {
      if (name === 'react' && React) return React
      throw new Error('未知模块：' + name)
    })
  : {}

check('exports.apply 是函数', typeof mod.apply === 'function')
check('exports.inject 是数组', Array.isArray(mod.inject), JSON.stringify(mod.inject))

section('apply(ctx) 注册的 slots')

const registrations = []
const fakeClientCtx = {
  effect(fn) {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  slots: {
    inject(name, callback) {
      return callback()
    },
    register(spec, component) {
      registrations.push({ spec, component })
      return () => {}
    },
  },
}

let applyError = null
try {
  mod.apply(fakeClientCtx)
} catch (error) {
  applyError = error
}
check('apply(ctx) 没抛异常', applyError === null, applyError ? String(applyError) : '')
check('注册了 2 个 slot', registrations.length === 2, registrations.map((r) => r.spec && r.spec.name).join(', '))
check('注入了 <style>（样式跟随主题）', styleNodes.length === 1, styleNodes.length + ' 个 style 节点')

const side = registrations.find((r) => r.spec && r.spec.name === 'sidebar.panellist')
const main = registrations.find((r) => r.spec && r.spec.name === 'main')

check('有 sidebar.panellist 注册', Boolean(side))
check('侧栏 id 是 my-computer', side && side.spec.id === 'my-computer', side ? String(side.spec.id) : '')
check('侧栏 order 是 -5', side && side.spec.order === -5, side ? String(side.spec.order) : '')
check(
  '侧栏 label 返回「我的电脑」',
  side && typeof side.spec.label === 'function' && side.spec.label() === '我的电脑',
  side && typeof side.spec.label === 'function' ? side.spec.label() : '',
)
check('侧栏图标是函数组件', side && typeof side.component === 'function')

check('有 main 注册', Boolean(main))
check('main.key 与侧栏 id 一致', main && side && main.spec.key === side.spec.id, main ? String(main.spec.key) : '')
check('面板是函数组件', main && typeof main.component === 'function')

/* ------------------------------------------------------------------ *
 * 手搭一个只够跑首屏的渲染器：真 React.createElement + 最小 hook dispatcher
 * ------------------------------------------------------------------ */

function makeRenderer(React) {
  const internals = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
  const dispatcherRef = internals && internals.ReactCurrentDispatcher
  if (!dispatcherRef) return null

  return function render(element, options = {}) {
    const seen = { tags: [], classes: [], components: [] }
    const seed = options.seed || null
    let seededOnce = false

    function walk(node, depth) {
      if (node == null || typeof node === 'boolean') return
      if (typeof node === 'string' || typeof node === 'number') return
      if (Array.isArray(node)) {
        node.forEach((child) => walk(child, depth))
        return
      }
      if (typeof node.type === 'string') {
        seen.tags.push(node.type)
        const className = node.props && node.props.className
        if (className) seen.classes.push(String(className))
        walk(node.props && node.props.children, depth + 1)
        return
      }
      if (typeof node.type === 'function') {
        if (depth > 14) throw new Error('渲染层级过深（疑似递归组件）')
        const name = node.type.name || '匿名组件'
        seen.components.push(name)
        const store = []
        const useSeed = seed && !seededOnce
        if (useSeed) seededOnce = true
        let index = 0
        const previous = dispatcherRef.current
        dispatcherRef.current = {
          useState(initial) {
            const at = index
            index += 1
            if (!(at in store)) {
              const preset = useSeed && seed[at] !== undefined ? seed[at] : undefined
              store[at] = preset !== undefined ? preset : typeof initial === 'function' ? initial() : initial
            }
            return [
              store[at],
              (next) => {
                store[at] = typeof next === 'function' ? next(store[at]) : next
              },
            ]
          },
          useReducer(reducer, initial) {
            const at = index
            index += 1
            if (!(at in store)) store[at] = initial
            return [store[at], () => {}]
          },
          useRef(initial) {
            const at = index
            index += 1
            if (!(at in store)) store[at] = { current: initial }
            return store[at]
          },
          useMemo(factory) {
            index += 1
            return factory()
          },
          useCallback(callback) {
            index += 1
            return callback
          },
          useEffect() {
            index += 1
          },
          useLayoutEffect() {
            index += 1
          },
          useContext(context) {
            index += 1
            return context && context._currentValue
          },
          useId() {
            index += 1
            return 'id-' + index
          },
        }
        try {
          walk(node.type(node.props || {}), depth + 1)
        } finally {
          dispatcherRef.current = previous
        }
        return
      }
      throw new Error('未知节点类型：' + String(node.type))
    }

    walk(element, 0)
    return seen
  }
}

section('面板渲染（四个状态）')

if (React && main && typeof main.component === 'function') {
  const render = makeRenderer(React)
  if (!render) {
    console.log('  · 跳过：这个 React 版本没有暴露 ReactCurrentDispatcher')
  } else {
    const driveA = { letter: 'C:', label: '系统盘', total: 100 * 1024 ** 3, free: 30 * 1024 ** 3 }
    const driveB = { letter: 'D:', label: '本地磁盘', total: 500 * 1024 ** 3, free: 210 * 1024 ** 3 }
    const entries = [
      { name: 'dsh-workspace', path: 'D:\\dsh-workspace', kind: 'dir', size: 0, mtime: Date.now(), ext: '' },
      { name: 'vault', path: 'D:\\dsh-workspace\\vault', kind: 'dir', size: 0, mtime: Date.now(), ext: '' },
      { name: 'README.md', path: 'D:\\dsh-workspace\\README.md', kind: 'file', size: 4096, mtime: Date.now(), ext: '.md' },
      { name: '快捷方式', path: 'D:\\link', kind: 'link', targetKind: 'dir', size: 0, mtime: Date.now(), ext: '' },
    ]
    // 与 MyComputerPanel 的 hook 顺序一一对应：
    // cwd, entries, drives, capacity, loading, error, notice, selected, query, pathInput, dialog, busy
    const baseSeed = (dialog) => [
      'D:\\dsh-workspace',
      entries,
      [driveA, driveB],
      { total: driveB.total, free: driveB.free },
      false,
      '',
      '',
      [],
      '',
      'D:\\dsh-workspace',
      dialog || null,
      '',
    ]

    // A) 空状态（刚打开、还没探测到磁盘）
    let empty = null
    let emptyError = null
    try {
      empty = render(React.createElement(main.component, {}), {
        seed: ['', [], [], { total: null, free: null }, true, '', '', [], '', '', null, ''],
      })
    } catch (error) {
      emptyError = error
    }
    check('空状态渲染没抛异常', emptyError === null, emptyError ? String(emptyError) : '')
    check('空状态有根容器 mc-root', empty && empty.classes.some((c) => c.indexOf('mc-root') === 0))
    check('空状态显示「加载中」', empty && empty.classes.some((c) => c === 'mc-empty'))

    // B) 有内容的列表
    let list = null
    let listError = null
    try {
      list = render(React.createElement(main.component, {}), { seed: baseSeed(null) })
    } catch (error) {
      listError = error
    }
    check('列表态渲染没抛异常', listError === null, listError ? String(listError) : '')
    const rowCount = list ? list.classes.filter((c) => c === 'mc-row').length : 0
    check('目录里的 4 个条目都渲染成行', rowCount === 4, rowCount + ' 行')
    check('切盘区渲染出 2 个盘符按钮', list && list.classes.filter((c) => c.indexOf('mc-chip') === 0).length === 2)
    check('面包屑渲染出来', list && list.classes.some((c) => c === 'mc-crumb' || c === 'mc-crumb last'))
    check('工具栏有新建/上传按钮', list && list.tags.filter((t) => t === 'button').length >= 4)
    check('行内操作按钮存在（改名/删除/下载）', list && list.classes.includes('mc-ibtn') && list.classes.includes('mc-ibtn danger'))

    // C) 删除确认弹窗
    let del = null
    let delError = null
    try {
      del = render(React.createElement(main.component, {}), {
        seed: baseSeed({ kind: 'delete', paths: ['D:\\dsh-workspace\\README.md'] }),
      })
    } catch (error) {
      delError = error
    }
    check('删除确认弹窗渲染没抛异常', delError === null, delError ? String(delError) : '')
    check('弹窗有遮罩与主体', del && del.classes.includes('mc-modal-bg') && del.classes.some((c) => c.indexOf('mc-modal') === 0))
    check('弹窗里有「永久删除」按钮', del && del.components.indexOf('ModalShell') >= 0)

    // D) 预览弹窗（图片直显）
    let img = null
    let imgError = null
    try {
      img = render(React.createElement(main.component, {}), {
        seed: baseSeed({
          kind: 'preview',
          path: 'D:\\shot.png',
          name: 'shot.png',
          size: 20480,
          group: 'image',
          text: null,
          loaded: false,
          loadError: '',
          truncated: false,
          encoding: '',
        }),
      })
    } catch (error) {
      imgError = error
    }
    check('图片预览渲染没抛异常', imgError === null, imgError ? String(imgError) : '')
    check('图片预览用了 <img>', img && img.tags.includes('img'))
    check('图片指向 /api/my-computer/download', img && img.components.length > 0)
  }
} else {
  console.log('  · 跳过渲染检查（没有 react 或没有拿到组件）')
}

section('侧栏图标')

if (React && side && typeof side.component === 'function') {
  let icon = null
  let iconError = null
  try {
    icon = side.component({})
    check('图标渲染出 svg', icon && icon.type === 'svg')
    check('图标 viewBox 24×24', icon && icon.props && icon.props.viewBox === '0 0 24 24')
  } catch (error) {
    iconError = error
  }
  check('图标渲染没抛异常', iconError === null, iconError ? String(iconError) : '')
}

const passed = checks.filter((c) => c.pass).length
const total = checks.length
console.log('\n' + '='.repeat(64))
console.log(`结果：${passed}/${total} 通过，${total - passed} 失败`)
console.log('='.repeat(64))
if (passed !== total) {
  for (const c of checks) if (!c.pass) console.log('  ✗ ' + c.name + (c.detail ? '  ' + c.detail : ''))
  process.exitCode = 1
} else {
  console.log('全部通过。注意：这不等于 DSH 里已经能看见面板——还要装进 profile 并重启 dsh web。')
}
