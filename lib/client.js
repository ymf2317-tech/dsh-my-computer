// dsh-my-computer —— 浏览器半侧（DSH client bundle）
//
// 格式照 DSH 的 __ModuleLoader__ 约定：整文件是一个 load({ id, factory })，
// factory 里拿到宿主提供的 require，能取到 react；返回值就是这个插件模块的
// exports（{ apply, inject }），apply(ctx) 里往 slots 注册两个东西：
//   · sidebar.panellist → 右栏图标入口「我的电脑」
//   · main             → 点开后渲染的面板本体（key 必须与图标 id 一致）
//
// 注意：全部用 React.createElement 手写，不用 JSX、不用构建步骤。
// 所有请求走同源相对路径 /api/my-computer/*（DSH 的鉴权就在 /api 通道上）。
try {
  window.__ModuleLoader__.load({
    id: 'dsh-my-computer',
    factory: function (require) {
      var module = { exports: {} }
      var exports = module.exports

      var React = null
      try {
        React = require('react')
      } catch (error) {
        React = null
      }
      if (!React) React = globalThis.React
      if (!React) throw new Error('dsh-my-computer: 拿不到 React 运行时')

      var h = React.createElement
      var useState = React.useState
      var useEffect = React.useEffect
      var useRef = React.useRef
      var useCallback = React.useCallback
      var useMemo = React.useMemo

      // 面板 id 必须与侧栏图标 id 一致，点图标才会切到这个面板
      var PANEL_ID = 'my-computer'
      // DSH 的精确 fetch 路由挂在 /api 共享通道下（鉴权在那一层做），所以真实前缀是 /api/my-computer
      var BASE = '/api/my-computer'
      // 与 package.json 同步；宿主 /health 会报它自己的版本，两边不一致说明
      // 「客户端已经更新、宿主还没重启」，这时不能放用户去点新路由（会 404）
      var CLIENT_VERSION = '0.2.0'
      var LS_KEY = 'dsh-my-computer:last-path'

      /* ------------------------------------------------------------ *
       * 小工具
       * ------------------------------------------------------------ */

      function enc(value) {
        return encodeURIComponent(String(value == null ? '' : value))
      }

      function fmtSize(bytes) {
        if (bytes == null || !isFinite(bytes)) return ''
        if (bytes < 1024) return bytes + ' B'
        var units = ['KB', 'MB', 'GB', 'TB', 'PB']
        var value = bytes
        var index = -1
        while (value >= 1024 && index < units.length - 1) {
          value = value / 1024
          index += 1
        }
        return (value < 10 ? value.toFixed(1) : String(Math.round(value))) + ' ' + units[index]
      }

      function pad2(n) {
        return n < 10 ? '0' + n : String(n)
      }

      function fmtTime(ms) {
        if (!ms) return ''
        var d = new Date(ms)
        var now = new Date()
        var sameYear = d.getFullYear() === now.getFullYear()
        var head = sameYear ? '' : d.getFullYear() + '-'
        return head + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
      }

      function isRoot(p) {
        return /^[A-Za-z]:\\$/.test(String(p || ''))
      }

      function parentOf(p) {
        var s = String(p || '').replace(/\\+$/, '')
        if (!s || /^[A-Za-z]:$/.test(s)) return null
        var cut = s.lastIndexOf('\\')
        if (cut < 0) return null
        if (cut === 2) return s.slice(0, 3) + '\\'
        return s.slice(0, cut)
      }

      function join(dir, name) {
        var d = String(dir || '')
        return d.endsWith('\\') ? d + name : d + '\\' + name
      }

      /** D:\a\b → [{label:'D:',path:'D:\'},{label:'a',path:'D:\a'},{label:'b',path:'D:\a\b'}] */
      function crumbsOf(p) {
        var s = String(p || '')
        var out = []
        if (!/^[A-Za-z]:[\\/]/.test(s)) return out
        var root = s.slice(0, 2).toUpperCase() + '\\'
        out.push({ label: s.slice(0, 2).toUpperCase(), path: root })
        var rest = s.slice(3).split('\\').filter(function (x) { return x.length > 0 })
        var acc = root
        for (var i = 0; i < rest.length; i += 1) {
          acc = join(acc, rest[i])
          out.push({ label: rest[i], path: acc })
        }
        return out
      }

      var IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.avif', '.svg']
      var TEXT_EXT = [
        '.txt', '.md', '.markdown', '.log', '.json', '.jsonl', '.yml', '.yaml', '.toml', '.ini',
        '.cfg', '.conf', '.csv', '.tsv', '.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.ts',
        '.tsx', '.jsx', '.py', '.sh', '.bat', '.cmd', '.ps1', '.xml', '.env', '.gitignore', '.vue',
        '.java', '.c', '.h', '.cpp', '.hpp', '.rs', '.go', '.rb', '.php', '.sql', '.lua', '.kt',
      ]

      function extOf(name) {
        var lower = String(name || '').toLowerCase()
        var dot = lower.lastIndexOf('.')
        return dot <= 0 ? '' : lower.slice(dot)
      }

      function kindOfExt(name) {
        var ext = extOf(name)
        if (IMAGE_EXT.indexOf(ext) >= 0) return 'image'
        if (TEXT_EXT.indexOf(ext) >= 0) return 'text'
        return 'other'
      }

      function iconFor(entry) {
        var effective = entry.kind === 'link' ? entry.targetKind : entry.kind
        if (effective === 'dir') return '📁'
        if (entry.kind === 'link') return '🔗'
        var group = kindOfExt(entry.name)
        if (group === 'image') return '🖼️'
        if (group === 'text') return '📄'
        return '📦'
      }

      /* ------------------------------------------------------------ *
       * HTTP
       * ------------------------------------------------------------ */

      function parseResponse(res) {
        return res.text().then(function (raw) {
          var data = null
          try {
            data = raw ? JSON.parse(raw) : null
          } catch (error) {
            throw new Error('服务端返回的不是 JSON（HTTP ' + res.status + '）：' + raw.slice(0, 160))
          }
          if (data && Array.isArray(data.failed) && data.failed.length > 0) {
            var detail = data.failed
              .map(function (item) {
                return item.path + '（' + (item.message || item.code) + '）'
              })
              .join('；')
            throw new Error('部分操作失败：' + detail)
          }
          if (!res.ok || (data && data.ok === false)) {
            var problem = data && data.error
            var code = problem && problem.code ? problem.code + ': ' : ''
            throw new Error(code + ((problem && problem.message) || 'HTTP ' + res.status))
          }
          return data
        })
      }

      function apiGet(pathWithQuery) {
        return fetch(BASE + pathWithQuery, { credentials: 'same-origin' }).then(parseResponse)
      }

      function apiPost(pathName, body) {
        return fetch(BASE + pathName, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body || {}),
        }).then(parseResponse)
      }

      function apiUpload(dir, file, overwrite) {
        var query =
          '?path=' + enc(dir) + '&name=' + enc(file.name) + (overwrite ? '&overwrite=1' : '')
        return fetch(BASE + '/upload' + query, {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/octet-stream' },
          body: file,
        }).then(parseResponse)
      }

      function downloadUrl(p) {
        return BASE + '/download?path=' + enc(p)
      }

      function downloadDirUrl(p) {
        return BASE + '/download-dir?path=' + enc(p)
      }

      /* 用隐藏 <a> 触发浏览器原生下载：走 cookie 鉴权、直接落盘，
         不用 fetch+blob（手机上几百 MB 的包塞进内存会直接崩标签页）。 */
      function triggerAnchor(url) {
        var anchor = document.createElement('a')
        anchor.href = url
        anchor.setAttribute('download', '')
        anchor.rel = 'noopener'
        document.body.appendChild(anchor)
        anchor.click()
        setTimeout(function () {
          anchor.remove()
        }, 0)
      }

      function triggerDownload(p) {
        triggerAnchor(downloadUrl(p))
      }

      function triggerDirDownload(p) {
        triggerAnchor(downloadDirUrl(p))
      }

      /* ------------------------------------------------------------ *
       * 样式：跟随宿主主题变量（--dsw-alias-*），拿不到时退到明/暗两套兜底
       * ------------------------------------------------------------ */

      var CSS = [
        '.mc-root{display:flex;flex-direction:column;width:100%;box-sizing:border-box;height:100%;',
        '  min-height:calc(100dvh - 96px);color:var(--mc-fg);background:var(--mc-bg);font-size:13px;',
        '  --mc-bg:var(--dsw-alias-bg-layer-1,#fff);--mc-bg2:var(--dsw-alias-bg-layer-2,#f6f7f9);',
        '  --mc-fg:var(--dsw-alias-label-primary,#1a1a1a);--mc-fg2:var(--dsw-alias-label-secondary,#6b6b6b);',
        '  --mc-line:var(--dsw-alias-border-l1,rgba(0,0,0,.12));--mc-hover:var(--dsw-alias-bg-hover,rgba(0,0,0,.05));',
        '  --mc-accent:var(--dsw-alias-brand-primary,#2f6fed);--mc-danger:#e5484d;}',
        '@media (prefers-color-scheme:dark){.mc-root{',
        '  --mc-bg:var(--dsw-alias-bg-layer-1,#161616);--mc-bg2:var(--dsw-alias-bg-layer-2,#202020);',
        '  --mc-fg:var(--dsw-alias-label-primary,#e9e9e9);--mc-fg2:var(--dsw-alias-label-secondary,#9b9b9b);',
        '  --mc-line:var(--dsw-alias-border-l1,rgba(255,255,255,.14));--mc-hover:var(--dsw-alias-bg-hover,rgba(255,255,255,.08));',
        '  --mc-accent:var(--dsw-alias-brand-primary,#5b8cff);}}',
        '.mc-head{flex:none;display:flex;flex-direction:column;gap:6px;padding:8px 10px 6px;}',
        '.mc-line{display:flex;align-items:center;gap:6px;min-width:0;}',
        '.mc-drives{display:flex;gap:6px;overflow-x:auto;flex:1 1 auto;padding-bottom:2px;',
        '  scrollbar-width:none;-ms-overflow-style:none;}',
        '.mc-drives::-webkit-scrollbar{display:none;}',
        '.mc-chip{flex:none;border:1px solid var(--mc-line);background:transparent;color:var(--mc-fg);',
        '  border-radius:999px;padding:3px 11px;font-size:12px;line-height:1.6;cursor:pointer;white-space:nowrap;}',
        '.mc-chip:hover{background:var(--mc-hover);}',
        '.mc-chip.on{background:var(--mc-accent);border-color:transparent;color:#fff;}',
        '.mc-chip small{opacity:.7;font-size:10.5px;margin-left:4px;}',
        '.mc-crumbs{display:flex;align-items:center;gap:2px;overflow-x:auto;flex:1 1 auto;min-width:0;',
        '  white-space:nowrap;scrollbar-width:none;font-size:12.5px;}',
        '.mc-crumbs::-webkit-scrollbar{display:none;}',
        '.mc-crumb{appearance:none;border:0;background:transparent;color:var(--mc-fg2);cursor:pointer;',
        '  padding:2px 4px;border-radius:5px;font-size:12.5px;max-width:42vw;overflow:hidden;',
        '  text-overflow:ellipsis;white-space:nowrap;}',
        '.mc-crumb:hover{background:var(--mc-hover);color:var(--mc-fg);}',
        '.mc-crumb.last{color:var(--mc-fg);font-weight:600;}',
        '.mc-sep{color:var(--mc-fg2);opacity:.55;font-size:11px;}',
        '.mc-input{width:100%;box-sizing:border-box;background:var(--mc-bg2);color:var(--mc-fg);',
        '  border:1px solid var(--mc-line);border-radius:8px;padding:7px 9px;font-size:12.5px;font-family:inherit;}',
        '.mc-input:focus{outline:none;border-color:var(--mc-accent);}',
        '.mc-tools{flex:none;display:flex;align-items:center;gap:6px;padding:0 10px 8px;flex-wrap:wrap;}',
        '.mc-btn{appearance:none;border:1px solid var(--mc-line);background:transparent;color:var(--mc-fg);',
        '  border-radius:8px;padding:4px 10px;font-size:12px;line-height:1.6;cursor:pointer;white-space:nowrap;}',
        '.mc-btn:hover{background:var(--mc-hover);}',
        '.mc-btn:disabled{opacity:.45;cursor:default;}',
        '.mc-btn.primary{background:var(--mc-accent);border-color:transparent;color:#fff;}',
        '.mc-btn.danger{color:var(--mc-danger);border-color:rgba(229,72,77,.45);}',
        '.mc-btn.danger.solid{background:var(--mc-danger);color:#fff;border-color:transparent;}',
        '.mc-flex{flex:1 1 auto;}',
        '.mc-search{flex:1 1 130px;min-width:110px;}',
        '.mc-list{flex:1 1 auto;min-height:240px;overflow:auto;border-top:1px solid var(--mc-line);',
        '  -webkit-overflow-scrolling:touch;}',
        '.mc-row{display:flex;align-items:center;gap:8px;padding:7px 10px;cursor:pointer;',
        '  border-bottom:1px solid var(--mc-line);}',
        '.mc-row:hover{background:var(--mc-hover);}',
        '.mc-row.on{background:rgba(47,111,237,.13);}',
        '.mc-check{flex:none;width:16px;height:16px;margin:0;accent-color:var(--mc-accent);}',
        '.mc-ico{flex:none;width:20px;text-align:center;font-size:15px;line-height:1;}',
        '.mc-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px;}',
        '.mc-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
        '.mc-sub{font-size:11px;color:var(--mc-fg2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
        '.mc-acts{flex:none;display:flex;gap:1px;}',
        '.mc-ibtn{appearance:none;border:0;background:transparent;color:var(--mc-fg2);cursor:pointer;',
        '  font-size:14px;line-height:1;padding:5px;border-radius:6px;}',
        '.mc-ibtn:hover{background:var(--mc-hover);color:var(--mc-fg);}',
        '.mc-ibtn.danger:hover{color:var(--mc-danger);}',
        '.mc-foot{flex:none;display:flex;align-items:center;gap:10px;padding:6px 10px;font-size:11.5px;',
        '  color:var(--mc-fg2);border-top:1px solid var(--mc-line);}',
        '.mc-err{flex:none;margin:0 10px 6px;padding:7px 9px;border-radius:8px;font-size:12px;',
        '  color:#c9343b;background:rgba(229,72,77,.12);border:1px solid rgba(229,72,77,.35);',
        '  overflow-wrap:anywhere;}',
        '.mc-ok{flex:none;margin:0 10px 6px;padding:7px 9px;border-radius:8px;font-size:12px;',
        '  color:#1a7f4b;background:rgba(26,127,75,.12);border:1px solid rgba(26,127,75,.3);',
        '  overflow-wrap:anywhere;}',
        '@media (prefers-color-scheme:dark){.mc-err{color:#ff8f94;}.mc-ok{color:#6ddba0;}}',
        '.mc-empty{padding:26px 12px;text-align:center;color:var(--mc-fg2);font-size:12.5px;}',
        '.mc-modal-bg{position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,.45);display:flex;',
        '  align-items:center;justify-content:center;padding:14px;}',
        '.mc-modal{width:min(520px,100%);max-height:86dvh;overflow:auto;box-sizing:border-box;',
        '  background:var(--mc-bg);color:var(--mc-fg);border:1px solid var(--mc-line);border-radius:12px;',
        '  padding:14px;display:flex;flex-direction:column;gap:10px;box-shadow:0 14px 44px rgba(0,0,0,.4);}',
        '.mc-modal.wide{width:min(780px,100%);}',
        '.mc-modal h3{margin:0;font-size:14px;font-weight:600;}',
        '.mc-modal p{margin:0;font-size:12.5px;color:var(--mc-fg2);overflow-wrap:anywhere;}',
        '.mc-modal-acts{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;}',
        '.mc-editor{width:100%;box-sizing:border-box;min-height:260px;max-height:62dvh;resize:vertical;',
        '  background:var(--mc-bg2);color:var(--mc-fg);border:1px solid var(--mc-line);border-radius:8px;',
        '  padding:9px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;',
        '  line-height:1.55;white-space:pre;overflow:auto;tab-size:2;}',
        '.mc-img{max-width:100%;max-height:62dvh;object-fit:contain;border-radius:8px;',
        '  background:var(--mc-bg2);display:block;margin:0 auto;}',
        '.mc-hint{font-size:11.5px;color:var(--mc-fg2);}',
        '@media (max-width:420px){',
        '  .mc-root{min-height:calc(100dvh - 72px);font-size:12.5px;}',
        '  .mc-head{padding:6px 8px 4px;}',
        '  .mc-tools{padding:0 8px 6px;}',
        '  .mc-btn{padding:4px 8px;font-size:11.5px;}',
        '  .mc-row{padding:8px;}',
        '  .mc-foot{padding:5px 8px;}}',
      ].join('\n')

      function ensureStyle() {
        if (typeof document === 'undefined') return function () {}
        var existing = document.querySelector('style[data-dsh-my-computer]')
        if (existing) return function () {}
        var styleEl = document.createElement('style')
        styleEl.setAttribute('data-dsh-my-computer', '')
        styleEl.textContent = CSS
        document.head.appendChild(styleEl)
        return function () {
          styleEl.remove()
        }
      }

      /* ------------------------------------------------------------ *
       * 面板
       * ------------------------------------------------------------ */

      function MyComputerPanel() {
        var _cwd = useState('')
        var cwd = _cwd[0]
        var setCwd = _cwd[1]

        var _entries = useState([])
        var entries = _entries[0]
        var setEntries = _entries[1]

        var _drives = useState([])
        var drives = _drives[0]
        var setDrives = _drives[1]

        var _cap = useState({ total: null, free: null })
        var capacity = _cap[0]
        var setCapacity = _cap[1]

        var _loading = useState(false)
        var loading = _loading[0]
        var setLoading = _loading[1]

        var _error = useState('')
        var errorText = _error[0]
        var setErrorText = _error[1]

        var _notice = useState('')
        var notice = _notice[0]
        var setNotice = _notice[1]

        var _sel = useState([])
        var selected = _sel[0]
        var setSelected = _sel[1]

        var _query = useState('')
        var query = _query[0]
        var setQuery = _query[1]

        var _pathInput = useState('')
        var pathInput = _pathInput[0]
        var setPathInput = _pathInput[1]

        var _dialog = useState(null)
        var dialog = _dialog[0]
        var setDialog = _dialog[1]

        var _busy = useState('')
        var busy = _busy[0]
        var setBusy = _busy[1]

        // 剪切板：{ paths: [...], label: '文件名' }，只活在内存里（刷新就没，避免误粘）
        var _clip = useState(null)
        var clip = _clip[0]
        var setClip = _clip[1]

        var _hostVer = useState('')
        var hostVersion = _hostVer[0]
        var setHostVersion = _hostVer[1]

        var fileInputRef = useRef(null)
        var mountedRef = useRef(true)

        useEffect(function () {
          mountedRef.current = true
          return function () {
            mountedRef.current = false
          }
        }, [])

        function reportError(error) {
          setErrorText(String((error && error.message) || error || '未知错误'))
        }

        function clearMessages() {
          setErrorText('')
          setNotice('')
        }

        /* ---- 加载 ---- */

        var navigate = useCallback(function (target) {
          if (!target) return Promise.resolve()
          clearMessages()
          setLoading(true)
          return apiGet('/list?path=' + enc(target))
            .then(function (data) {
              if (!mountedRef.current) return
              setCwd(data.path)
              setEntries(data.entries || [])
              setCapacity({ total: data.total, free: data.free })
              setSelected([])
              setQuery('')
              setPathInput(data.path)
              try {
                window.localStorage.setItem(LS_KEY, data.path)
              } catch (error) {
                /* 隐私模式下 localStorage 可能不可用 */
              }
            })
            .catch(function (error) {
              if (mountedRef.current) reportError(error)
            })
            .then(function () {
              if (mountedRef.current) setLoading(false)
            })
        }, [])

        function pasteClip() {
          if (!clip || !clip.paths || clip.paths.length === 0) return
          var target = cwd
          if (!target) return
          clearMessages()
          setBusy('正在移动 ' + clip.paths.length + ' 项…')
          apiPost('/move', { sources: clip.paths, targetDir: target })
            .then(function (data) {
              if (!mountedRef.current) return
              var count = (data.moved || []).length
              var skipped = (data.failed || []).length
              setClip(null)
              return navigate(target).then(function () {
                if (!mountedRef.current) return
                setNotice('已移动 ' + count + ' 项到 ' + target + (skipped ? '（' + skipped + ' 项失败）' : ''))
              })
            })
            .catch(function (error) {
              if (mountedRef.current) reportError(error)
            })
            .then(function () {
              if (mountedRef.current) setBusy('')
            })
        }

        function setClipFrom(paths, label) {
          if (!paths || paths.length === 0) return
          setClip({ paths: paths.slice(), label: label })
          setSelected([])
          clearMessages()
          setNotice('已剪切：' + label + '。到目标目录后点「粘贴到此处」')
        }

        useEffect(function () {
          apiGet('/health')
            .then(function (data) {
              if (mountedRef.current && data && data.version) setHostVersion(String(data.version))
            })
            .catch(function () {
              /* 探不到就当未知，不做任何限制 */
            })
        }, [])

        var loadDrives = useCallback(function () {
          return apiGet('/drives')
            .then(function (data) {
              if (!mountedRef.current) return []
              var list = data.drives || []
              setDrives(list)
              return list
            })
            .catch(function (error) {
              if (mountedRef.current) reportError(error)
              return []
            })
        }, [])

        // 首屏：先探测盘符，再跳到最后一次待过的目录（没有就 D:\，再没有就用第一个盘）
        useEffect(function () {
          var startPath = ''
          try {
            startPath = window.localStorage.getItem(LS_KEY) || ''
          } catch (error) {
            startPath = ''
          }
          loadDrives().then(function (list) {
            if (!mountedRef.current) return
            var preferred = ['D:', 'C:']
            var chosen = ''
            if (startPath) chosen = startPath
            if (!chosen) {
              for (var i = 0; i < preferred.length; i += 1) {
                for (var j = 0; j < list.length; j += 1) {
                  if (list[j].letter.toUpperCase() === preferred[i]) chosen = list[j].letter + '\\'
                }
                if (chosen) break
              }
            }
            if (!chosen && list.length > 0) chosen = list[0].letter + '\\'
            if (!chosen) {
              setErrorText('没有探测到任何可用的磁盘')
              return
            }
            navigate(chosen)
          })
        }, [loadDrives, navigate])

        /* ---- 导航动作 ---- */

        function goUp() {
          var up = parentOf(cwd)
          if (up) navigate(up)
        }

        function switchDrive(letter) {
          navigate(letter + '\\')
        }

        function submitPath(event) {
          event.preventDefault()
          var target = String(pathInput || '').trim()
          if (!target) return
          navigate(target)
        }

        function refresh() {
          if (cwd) navigate(cwd)
          loadDrives()
        }

        /* ---- 选择 ---- */

        function isSelected(p) {
          return selected.indexOf(p) >= 0
        }

        function toggleSelect(p) {
          setSelected(function (prev) {
            var at = prev.indexOf(p)
            if (at >= 0) {
              var next = prev.slice()
              next.splice(at, 1)
              return next
            }
            return prev.concat([p])
          })
        }

        function toggleSelectAll() {
          var visible = visibleEntries.map(function (entry) {
            return entry.path
          })
          var allSelected =
            visible.length > 0 &&
            visible.every(function (p) {
              return isSelected(p)
            })
          setSelected(allSelected ? [] : visible)
        }

        /* ---- 行内动作 ---- */

        function openEntry(entry) {
          var effective = entry.kind === 'link' ? entry.targetKind : entry.kind
          if (effective === 'dir') {
            navigate(entry.path)
            return
          }
          if (entry.kind === 'link' && entry.targetKind === 'unknown') {
            setErrorText('这是一个断链（目标不存在）：' + entry.path)
            return
          }
          setDialog({
            kind: 'preview',
            path: entry.path,
            name: entry.name,
            size: entry.size,
            mtime: entry.mtime,
            group: kindOfExt(entry.name),
            text: null,
            original: '',
            truncated: false,
            encoding: '',
            loaded: false,
            loadError: '',
          })
        }

        function removePaths(paths) {
          if (!paths || paths.length === 0) return
          setDialog({ kind: 'delete', paths: paths.slice() })
        }

        /* ---- 上传 ---- */

        function pickFiles() {
          if (fileInputRef.current) fileInputRef.current.click()
        }

        function uploadFiles(files, overwrite) {
          if (!files || files.length === 0) return Promise.resolve()
          setBusy('上传中 0/' + files.length)
          clearMessages()
          var conflicts = []
          var done = 0
          var failed = []
          var chain = Promise.resolve()
          files.forEach(function (file) {
            chain = chain.then(function () {
              return apiUpload(cwd, file, Boolean(overwrite))
                .then(function () {
                  done += 1
                  if (mountedRef.current) setBusy('上传中 ' + done + '/' + files.length)
                })
                .catch(function (error) {
                  var message = String((error && error.message) || error)
                  if (!overwrite && message.indexOf('ALREADY_EXISTS') === 0) conflicts.push(file)
                  else failed.push(file.name + '：' + message)
                })
            })
          })
          return chain.then(function () {
            if (mountedRef.current) setBusy('')
            if (failed.length > 0) {
              setErrorText('上传失败 ' + failed.length + ' 个：' + failed.join('；'))
            } else if (done > 0) {
              setNotice('已上传 ' + done + ' 个文件')
            }
            if (conflicts.length > 0) {
              setDialog({ kind: 'overwrite', files: conflicts })
            }
            return navigate(cwd)
          })
        }

        function onFilesPicked(event) {
          var files = event.target.files ? Array.prototype.slice.call(event.target.files) : []
          event.target.value = ''
          uploadFiles(files, false)
        }

        /* ---- 计算可见列表 ---- */

        var visibleEntries = useMemo(function () {
          var keyword = query.trim().toLowerCase()
          if (!keyword) return entries
          return entries.filter(function (entry) {
            return String(entry.name || '').toLowerCase().indexOf(keyword) >= 0
          })
        }, [entries, query])

        var crumbList = useMemo(function () {
          return crumbsOf(cwd)
        }, [cwd])

        var currentDrive = cwd ? cwd.slice(0, 2).toUpperCase() : ''
        var allVisibleSelected =
          visibleEntries.length > 0 &&
          visibleEntries.every(function (entry) {
            return isSelected(entry.path)
          })

        /* ---- 渲染 ---- */

        var header = h(
          'div',
          { className: 'mc-head' },
          h(
            'div',
            { className: 'mc-line' },
            h(
              'div',
              { className: 'mc-drives' },
              drives.length === 0
                ? h('span', { className: 'mc-hint' }, '正在探测磁盘…')
                : drives.map(function (drive) {
                    var active = drive.letter.toUpperCase() === currentDrive
                    return h(
                      'button',
                      {
                        key: drive.letter,
                        type: 'button',
                        className: 'mc-chip' + (active ? ' on' : ''),
                        onClick: function () {
                          switchDrive(drive.letter)
                        },
                        title: (drive.label || '') + (drive.total ? ' · 可用 ' + fmtSize(drive.free) : ''),
                      },
                      drive.letter,
                      drive.total
                        ? h('small', null, fmtSize(drive.free) + ' 可用')
                        : null,
                    )
                  }),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'mc-btn',
                onClick: refresh,
                disabled: loading,
                title: '刷新当前目录',
              },
              loading ? '…' : '刷新',
            ),
          ),
          h(
            'div',
            { className: 'mc-line' },
            h(
              'button',
              {
                type: 'button',
                className: 'mc-btn',
                onClick: goUp,
                disabled: !parentOf(cwd),
                title: '回到上级目录',
              },
              '↑ 上级',
            ),
            h(
              'div',
              { className: 'mc-crumbs' },
              crumbList.length === 0
                ? h('span', { className: 'mc-hint' }, cwd || '未选择位置')
                : crumbList.map(function (crumb, index) {
                    var nodes = []
                    if (index > 0) nodes.push(h('span', { key: 'sep' + index, className: 'mc-sep' }, '›'))
                    nodes.push(
                      h(
                        'button',
                        {
                          key: 'crumb' + index,
                          type: 'button',
                          className: 'mc-crumb' + (index === crumbList.length - 1 ? ' last' : ''),
                          onClick: function () {
                            navigate(crumb.path)
                          },
                          title: crumb.path,
                        },
                        crumb.label,
                      ),
                    )
                    return nodes
                  }),
            ),
          ),
          h(
            'form',
            { className: 'mc-line', onSubmit: submitPath },
            h('input', {
              className: 'mc-input',
              value: pathInput,
              placeholder: '粘贴绝对路径后回车，例如 D:\\dsh-workspace\\vault',
              spellCheck: false,
              autoCapitalize: 'off',
              autoCorrect: 'off',
              onChange: function (event) {
                setPathInput(event.target.value)
              },
            }),
          ),
        )

        var tools = h(
          'div',
          { className: 'mc-tools' },
          h(
            'button',
            { type: 'button', className: 'mc-btn', onClick: function () { setDialog({ kind: 'mkdir', value: '' }) } },
            '＋ 新建文件夹',
          ),
          h('button', { type: 'button', className: 'mc-btn', onClick: pickFiles }, '⬆ 上传'),
          selected.length > 0
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'mc-btn',
                  title: '剪切选中项，去别的目录粘贴',
                  onClick: function () {
                    setClipFrom(selected, selected.length + ' 项')
                  },
                },
                '✂ 剪切 ' + selected.length + ' 项',
              )
            : null,
          clip
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'mc-btn solid',
                  title: '把剪切板里的内容移动到当前目录：' + cwd,
                  onClick: pasteClip,
                },
                '📋 粘贴「' + clip.label + '」到此处',
              )
            : null,
          clip
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'mc-btn',
                  title: '清空剪切板',
                  onClick: function () {
                    setClip(null)
                    clearMessages()
                  },
                },
                '取消剪切',
              )
            : null,
          h(
            'button',
            { type: 'button', className: 'mc-btn', onClick: toggleSelectAll, disabled: visibleEntries.length === 0 },
            allVisibleSelected ? '取消全选' : '全选',
          ),
          selected.length > 0
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'mc-btn danger solid',
                  onClick: function () {
                    removePaths(selected)
                  },
                },
                '删除 ' + selected.length + ' 项',
              )
            : null,
          h('input', {
            className: 'mc-input mc-search',
            value: query,
            placeholder: '筛选当前目录',
            spellCheck: false,
            onChange: function (event) {
              setQuery(event.target.value)
            },
          }),
          h('input', {
            type: 'file',
            multiple: true,
            ref: fileInputRef,
            style: { display: 'none' },
            onChange: onFilesPicked,
          }),
        )

        var rows = visibleEntries.map(function (entry) {
          var effective = entry.kind === 'link' ? entry.targetKind : entry.kind
          var metaParts = []
          if (effective === 'dir') metaParts.push('文件夹')
          else if (entry.size != null) metaParts.push(fmtSize(entry.size))
          else metaParts.push('—')
          if (entry.kind === 'link') metaParts.push('快捷方式')
          if (entry.statError) metaParts.push('无法读取：' + entry.statError)
          else if (entry.mtime) metaParts.push(fmtTime(entry.mtime))

          return h(
            'div',
            {
              key: entry.path,
              className: 'mc-row' + (isSelected(entry.path) ? ' on' : ''),
              onClick: function () {
                openEntry(entry)
              },
              title: entry.path,
            },
            h('input', {
              type: 'checkbox',
              className: 'mc-check',
              checked: isSelected(entry.path),
              onClick: function (event) {
                event.stopPropagation()
              },
              onChange: function () {
                toggleSelect(entry.path)
              },
            }),
            h('span', { className: 'mc-ico' }, iconFor(entry)),
            h(
              'div',
              { className: 'mc-main' },
              h('div', { className: 'mc-name' }, entry.name),
              h('div', { className: 'mc-sub' }, metaParts.join(' · ')),
            ),
            h(
              'div',
              {
                className: 'mc-acts',
                onClick: function (event) {
                  event.stopPropagation()
                },
              },
              effective === 'file'
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'mc-ibtn',
                      title: '下载',
                      onClick: function () {
                        triggerDownload(entry.path)
                      },
                    },
                    '⤓',
                  )
                : null,
              effective === 'dir' && !entry.statError
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'mc-ibtn',
                      title: '打包下载这个目录（zip）',
                      onClick: function () {
                        if (hostVersion && hostVersion !== CLIENT_VERSION) {
                          clearMessages()
                          setNotice(
                            '宿主侧还是 v' + hostVersion + '，「打包下载」要重启 dsh web 后才生效（本面板 v' + CLIENT_VERSION + '）',
                          )
                          return
                        }
                        triggerDirDownload(entry.path)
                      },
                    },
                    '🗜',
                  )
                : null,
              h(
                'button',
                {
                  type: 'button',
                  className: 'mc-ibtn',
                  title: '剪切（到别的目录粘贴）',
                  onClick: function () {
                    setClipFrom([entry.path], entry.name)
                  },
                },
                '✂',
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'mc-ibtn',
                  title: '重命名',
                  onClick: function () {
                    setDialog({ kind: 'rename', path: entry.path, value: entry.name })
                  },
                },
                '✎',
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'mc-ibtn danger',
                  title: '删除',
                  onClick: function () {
                    removePaths([entry.path])
                  },
                },
                '🗑',
              ),
            ),
          )
        })

        var listBody =
          loading && entries.length === 0
            ? h('div', { className: 'mc-empty' }, '加载中…')
            : rows.length === 0
              ? h(
                  'div',
                  { className: 'mc-empty' },
                  query.trim() ? '没有匹配「' + query.trim() + '」的条目' : '这个目录是空的',
                )
              : rows

        var footer = h(
          'div',
          { className: 'mc-foot' },
          h('span', null, '共 ' + visibleEntries.length + ' 项' + (query.trim() ? '（已筛选）' : '')),
          capacity.total != null
            ? h(
                'span',
                null,
                '可用 ' + fmtSize(capacity.free) + ' / ' + fmtSize(capacity.total),
              )
            : null,
          selected.length > 0 ? h('span', null, '已选 ' + selected.length) : null,
          busy ? h('span', { className: 'mc-hint' }, busy) : null,
        )

        return h(
          'div',
          { className: 'mc-root' },
          header,
          tools,
          errorText ? h('div', { className: 'mc-err' }, errorText) : null,
          notice ? h('div', { className: 'mc-ok' }, notice) : null,
          h('div', { className: 'mc-list' }, listBody),
          footer,
          dialog ? renderDialog(dialog, setDialog, navigate, cwd, uploadFiles, reportError, setNotice, setBusy) : null,
        )
      }

      /* ------------------------------------------------------------ *
       * 弹窗（新建 / 改名 / 删除确认 / 覆盖确认 / 预览）
       * ------------------------------------------------------------ */

      function ModalShell(props) {
        return h(
          'div',
          {
            className: 'mc-modal-bg',
            onClick: function (event) {
              if (event.target === event.currentTarget && props.onCancel) props.onCancel()
            },
          },
          h(
            'div',
            { className: 'mc-modal' + (props.wide ? ' wide' : '') },
            h('h3', null, props.title),
            props.children,
          ),
        )
      }

      function NameDialog(props) {
        var _value = useState(props.initial || '')
        var value = _value[0]
        var setValue = _value[1]
        var _busy = useState(false)
        var busy = _busy[0]
        var setBusy = _busy[1]
        var inputRef = useRef(null)

        useEffect(function () {
          if (inputRef.current) inputRef.current.focus()
        }, [])

        function submit(event) {
          if (event) event.preventDefault()
          var name = String(value || '').trim()
          if (!name || busy) return
          setBusy(true)
          props
            .onSubmit(name)
            .catch(function (error) {
              props.onError(error)
              setBusy(false)
            })
        }

        return h(
          ModalShell,
          { title: props.title, onCancel: busy ? null : props.onCancel },
          h('p', null, props.hint || ''),
          h('form', { onSubmit: submit },
            h('input', {
              className: 'mc-input',
              ref: inputRef,
              value: value,
              placeholder: '名称',
              spellCheck: false,
              onChange: function (event) {
                setValue(event.target.value)
              },
            }),
          ),
          h(
            'div',
            { className: 'mc-modal-acts' },
            h('button', { type: 'button', className: 'mc-btn', onClick: props.onCancel, disabled: busy }, '取消'),
            h('button', { type: 'button', className: 'mc-btn primary', onClick: submit, disabled: busy }, busy ? '处理中…' : '确定'),
          ),
        )
      }

      function PreviewDialog(props) {
        var _state = useState({
          text: props.text || '',
          original: props.text || '',
          loaded: props.loaded,
          loadError: props.loadError || '',
          truncated: props.truncated,
          encoding: props.encoding,
          saving: false,
        })
        var state = _state[0]
        var setState = _state[1]

        useEffect(function () {
          if (state.loaded || state.loadError) return
          apiGet('/read?path=' + enc(props.path) + '&maxBytes=' + String(512 * 1024))
            .then(function (data) {
              setState(function (prev) {
                return Object.assign({}, prev, {
                  text: data.text,
                  original: data.text,
                  loaded: true,
                  truncated: data.truncated,
                  encoding: data.encoding,
                })
              })
            })
            .catch(function (error) {
              setState(function (prev) {
                return Object.assign({}, prev, {
                  loaded: true,
                  loadError: String((error && error.message) || error),
                })
              })
            })
        }, [])

        var dirty = state.loaded && state.text !== state.original

        function save() {
          setState(function (prev) {
            return Object.assign({}, prev, { saving: true })
          })
          apiPost('/write', { path: props.path, text: state.text })
            .then(function () {
              setState(function (prev) {
                return Object.assign({}, prev, { saving: false, original: prev.text })
              })
              props.onSaved('已保存 ' + props.name)
            })
            .catch(function (error) {
              setState(function (prev) {
                return Object.assign({}, prev, { saving: false })
              })
              props.onError(error)
            })
        }

        var body
        if (props.group === 'image') {
          body = h('img', { className: 'mc-img', src: downloadUrl(props.path), alt: props.name })
        } else if (props.group === 'text') {
          if (state.loadError) {
            body = h(
              'div',
              null,
              h('p', null, state.loadError),
              h(
                'button',
                {
                  type: 'button',
                  className: 'mc-btn primary',
                  onClick: function () {
                    triggerDownload(props.path)
                  },
                },
                '下载文件',
              ),
            )
          } else if (!state.loaded) {
            body = h('p', null, '读取中…')
          } else {
            body = h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
              h('textarea', {
                className: 'mc-editor',
                value: state.text,
                spellCheck: false,
                onChange: function (event) {
                  var next = event.target.value
                  setState(function (prev) {
                    return Object.assign({}, prev, { text: next })
                  })
                },
              }),
              h(
                'div',
                { className: 'mc-modal-acts' },
                h(
                  'span',
                  { className: 'mc-hint', style: { marginRight: 'auto' } },
                  (state.encoding || 'utf-8') +
                    (state.truncated ? ' · 已截断（大于 512KB，只能看前缀，保存会覆盖全文件）' : '') +
                    (dirty ? ' · 已修改' : ''),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'mc-btn',
                    onClick: function () {
                      triggerDownload(props.path)
                    },
                  },
                  '下载',
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'mc-btn primary',
                    disabled: !dirty || state.saving,
                    onClick: save,
                  },
                  state.saving ? '保存中…' : '保存',
                ),
              ),
            )
          }
        } else {
          body = h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
            h('p', null, '这种文件不支持在线预览，可以直接下载到手机/电脑。'),
            h(
              'button',
              {
                type: 'button',
                className: 'mc-btn primary',
                onClick: function () {
                  triggerDownload(props.path)
                },
              },
              '下载 ' + props.name,
            ),
          )
        }

        return h(
          ModalShell,
          { title: props.name, wide: true, onCancel: props.onCancel },
          h(
            'p',
            { className: 'mc-hint' },
            props.path + (props.size != null ? ' · ' + fmtSize(props.size) : ''),
          ),
          body,
          props.group === 'image' || props.group === 'other'
            ? h(
                'div',
                { className: 'mc-modal-acts' },
                h('button', { type: 'button', className: 'mc-btn', onClick: props.onCancel }, '关闭'),
              )
            : h(
                'div',
                { className: 'mc-modal-acts' },
                h('button', { type: 'button', className: 'mc-btn', onClick: props.onCancel }, '关闭'),
              ),
        )
      }

      function renderDialog(dialog, setDialog, navigate, cwd, uploadFiles, reportError, setNotice, setBusy) {
        function close() {
          setDialog(null)
        }

        if (dialog.kind === 'mkdir') {
          return h(NameDialog, {
            title: '新建文件夹',
            hint: '将在 ' + cwd + ' 下创建',
            initial: '',
            onCancel: close,
            onError: reportError,
            onSubmit: function (name) {
              return apiPost('/mkdir', { path: cwd, name: name }).then(function () {
                setDialog(null)
                setNotice('已创建文件夹 ' + name)
                return navigate(cwd)
              })
            },
          })
        }

        if (dialog.kind === 'rename') {
          return h(NameDialog, {
            title: '重命名',
            hint: dialog.path,
            initial: dialog.value,
            onCancel: close,
            onError: reportError,
            onSubmit: function (name) {
              return apiPost('/rename', { path: dialog.path, name: name }).then(function () {
                setDialog(null)
                setNotice('已重命名为 ' + name)
                return navigate(cwd)
              })
            },
          })
        }

        if (dialog.kind === 'delete') {
          var preview = dialog.paths
            .slice(0, 4)
            .map(function (p) {
              return p.split('\\').pop()
            })
            .join('、')
          var more = dialog.paths.length > 4 ? ' 等 ' + dialog.paths.length + ' 项' : ''
          return h(
            ModalShell,
            { title: '确认删除', onCancel: close },
            h('p', null, '将永久删除：' + preview + more + '。'),
            h('p', null, '删除是递归且不可恢复的（不进回收站），请确认路径没有写错。'),
            h(
              'div',
              { className: 'mc-modal-acts' },
              h('button', { type: 'button', className: 'mc-btn', onClick: close }, '取消'),
              h(
                'button',
                {
                  type: 'button',
                  className: 'mc-btn danger solid',
                  onClick: function () {
                    setBusy('正在删除…')
                    apiPost('/delete', { paths: dialog.paths, confirm: true })
                      .then(function () {
                        setBusy('')
                        setDialog(null)
                        setNotice('已删除 ' + dialog.paths.length + ' 项')
                        return navigate(cwd)
                      })
                      .catch(function (error) {
                        setBusy('')
                        setDialog(null)
                        reportError(error)
                        return navigate(cwd)
                      })
                  },
                },
                '永久删除',
              ),
            ),
          )
        }

        if (dialog.kind === 'overwrite') {
          return h(
            ModalShell,
            { title: '同名文件已存在', onCancel: close },
            h(
              'p',
              null,
              dialog.files.length + ' 个文件在目标目录里已有同名文件：' +
                dialog.files
                  .slice(0, 4)
                  .map(function (file) {
                    return file.name
                  })
                  .join('、'),
            ),
            h('p', null, '覆盖会直接替换原文件，不可恢复。'),
            h(
              'div',
              { className: 'mc-modal-acts' },
              h('button', { type: 'button', className: 'mc-btn', onClick: close }, '跳过'),
              h(
                'button',
                {
                  type: 'button',
                  className: 'mc-btn danger solid',
                  onClick: function () {
                    var files = dialog.files
                    setDialog(null)
                    uploadFiles(files, true)
                  },
                },
                '覆盖上传',
              ),
            ),
          )
        }

        if (dialog.kind === 'preview') {
          return h(PreviewDialog, {
            path: dialog.path,
            name: dialog.name,
            size: dialog.size,
            group: dialog.group,
            text: dialog.text,
            loaded: dialog.loaded,
            loadError: dialog.loadError,
            truncated: dialog.truncated,
            encoding: dialog.encoding,
            onCancel: close,
            onError: reportError,
            onSaved: function (message) {
              setNotice(message)
              close()
              navigate(cwd)
            },
          })
        }

        return null
      }

      /* ------------------------------------------------------------ *
       * 侧栏图标
       * ------------------------------------------------------------ */

      function MyComputerIcon() {
        return h(
          'svg',
          {
            xmlns: 'http://www.w3.org/2000/svg',
            width: 20,
            height: 20,
            viewBox: '0 0 24 24',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.7,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': 'true',
          },
          h('rect', { key: 'screen', x: 2.5, y: 4, width: 19, height: 12.5, rx: 2 }),
          h('path', { key: 'stand', d: 'M9 20.5h6' }),
          h('path', { key: 'neck', d: 'M12 16.5v4' }),
          h('path', { key: 'drive', d: 'M5.5 8h4' }),
        )
      }

      /* ------------------------------------------------------------ *
       * 插件入口
       * ------------------------------------------------------------ */

      function PanelTitle() {
        return h(
          'span',
          { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
          h(MyComputerIcon, { size: 14 }),
          h('span', null, '我的电脑'),
        )
      }

      function apply(ctx) {
        var disposeStyle = ensureStyle()
        ctx.effect(function () {
          return disposeStyle
        }, 'dsh-my-computer: styles')

        /* ---- 1) 右侧栏 tab 类型（这才是用户看到的「+」菜单里的那一项） ----
         * 契约见 @deepseek-ai/dsh-client-ui-sidebar-right：
         *   ctx.sidebarRightTabs.register({ id, kind, title, guide })
         *   正文 ctx.slots.register({ name:'sidebar.right.pane.tab', key:id })
         *   chip 标题 ctx.slots.register({ name:'sidebar.right.pane.tab.title', key:id })
         * guide 数组是「添加 tab」菜单里的入口框，不给就不出现在菜单里。
         */
        ctx.inject(['sidebarRightTabs'], function (c) {
          var disposers = []
          function keep(d) {
            if (typeof d === 'function') disposers.push(d)
          }
          function release() {
            while (disposers.length) {
              try {
                disposers.pop()()
              } catch (e) {}
            }
          }
          try {
            if (!c || !c.sidebarRightTabs || typeof c.sidebarRightTabs.register !== 'function') {
              return release
            }
            keep(
              c.sidebarRightTabs.register({
                id: PANEL_ID,
                kind: PANEL_ID,
                title: function () {
                  return '我的电脑'
                },
                guide: [
                  {
                    id: PANEL_ID,
                    order: 5,
                    title: function () {
                      return '我的电脑'
                    },
                    description: function () {
                      return '浏览本机全部磁盘（C: / D: …），可上传、下载、改名、删除、编辑'
                    },
                    icon: MyComputerIcon,
                  },
                ],
              }),
            )
            keep(
              c.slots.inject('sidebar.right.pane.tab', function () {
                return c.slots.register({ name: 'sidebar.right.pane.tab', key: PANEL_ID }, MyComputerPanel)
              }),
            )
            keep(
              c.slots.inject('sidebar.right.pane.tab.title', function () {
                return c.slots.register({ name: 'sidebar.right.pane.tab.title', key: PANEL_ID }, PanelTitle)
              }),
            )
          } catch (error) {
            try {
              window.__MYCOMP_ERR = String((error && error.message) || error)
            } catch (e) {}
            release()
            return
          }
          return release
        })

        /* ---- 2) 左侧栏面板入口（手机上是整屏打开，桌面在主栏） ---- */
        ctx.slots.inject('sidebar.panellist', function () {
          return ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: -5,
              label: function () {
                return '我的电脑'
              },
            },
            MyComputerIcon,
          )
        })
        ctx.slots.inject('main', function () {
          return ctx.slots.register({ name: 'main', key: PANEL_ID }, MyComputerPanel)
        })
      }

      exports.apply = apply
      exports.inject = ['slots']
      exports.PANEL_ID = PANEL_ID
      return module.exports
    },
  })
} catch (error) {
  var text = String((error && error.message) || error)
  if (!/duplicate factory registration/.test(text)) throw error
}
