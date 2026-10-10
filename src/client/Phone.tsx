// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The Studio on a phone.
 *
 * Two things, both to be taken away again once DSH's own page is at home on a
 * small screen. One: the Studio's page can lie over all of DSH's frame — its
 * sidebar, its bars — so that a phone's whole screen is the Studio; a button
 * uncovers DSH again (the conversations are there). It starts covered on a
 * small screen, and where the page was opened through the door. Two: the door
 * itself — an address on the local network through which a phone reaches the
 * page DSH serves on this computer (`host/remote.ts`), opened and closed here.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { qrPath } from '../shared/qr'
import type { RemoteStatus } from '../shared/rpc'
import { Button, Modal, Spinner, useAction, useLoad, useStudio, useT } from './ui'

const KEY = 'novel-studio:cover'
/** Narrower than this, DSH's sidebar leaves the Studio no room. */
const SMALL = 820

const read = (): boolean | undefined => {
  try {
    const kept = globalThis.sessionStorage?.getItem(KEY)
    return kept === '1' ? true : kept === '0' ? false : undefined
  } catch {
    return undefined
  }
}

/** Whether the page came through the door: the door marks its visitors with a cookie the page can read, naming the port it listens on. */
export const throughDoor = (): boolean => {
  try {
    const mark = /(?:^|;\s*)nv-phone=(\d+)(?:;|$)/u.exec(globalThis.document?.cookie ?? '')
    return mark !== null && mark[1] === globalThis.location?.port
  } catch {
    return false
  }
}

const small = (): boolean => (globalThis.innerWidth ?? 9999) < SMALL

/**
 * Whether the Studio's page lies over DSH's frame, and the switch for it. What the author chose holds for this tab of
 * the browser; before they chose, it is covered on a small screen and through the door.
 */
export function useCover(page: boolean): { cover: boolean; offered: boolean; set: (cover: boolean) => void } {
  const [chosen, setChosen] = useState(read)
  const [narrow, setNarrow] = useState(small)
  useEffect(() => {
    const onResize = (): void => { setNarrow(small()) }
    globalThis.addEventListener?.('resize', onResize)
    return () => { globalThis.removeEventListener?.('resize', onResize) }
  }, [])
  const door = useMemo(throughDoor, [])
  const set = useCallback((cover: boolean) => {
    setChosen(cover)
    try {
      globalThis.sessionStorage?.setItem(KEY, cover ? '1' : '0')
    } catch {
      // Without storage the choice holds until the page is loaded again.
    }
  }, [])
  const offered = page && (narrow || door || chosen === true)
  return { cover: page && (chosen ?? (narrow || door)), offered, set }
}

export type Cover = ReturnType<typeof useCover>

const CoverContext = createContext<Cover>({ cover: false, offered: false, set: () => {} })
export const CoverProvider = CoverContext.Provider
export const useCovering = (): Cover => useContext(CoverContext)

/** The switch between the Studio over all of the screen and DSH's own frame; shown where it is of use (a small screen, the door). */
export function CoverSwitch() {
  const cover = useCovering()
  const t = useT()
  if (!cover.offered) return null
  return cover.cover
    ? <Button variant="ghost" size="sm" icon="minimize" onClick={() => { cover.set(false) }} title={t('露出 DSH 自己的界面（对话在那里）', 'Uncover DSH\'s own frame (the conversations are there)')}>DSH</Button>
    : <Button variant="ghost" size="sm" icon="maximize" onClick={() => { cover.set(true) }} title={t('工坊铺满屏幕，盖住 DSH 的边栏', 'The Studio over the whole screen, DSH\'s sidebar covered')}>{t('铺满', 'Fill')}</Button>
}

/** The way to the door's dialog: an icon in a bar. Only on the Studio's own page — a tab beside a conversation is not what a phone opens. */
export function RemoteButton() {
  const { host } = useStudio()
  const t = useT()
  const [open, setOpen] = useState(false)
  if (host.where !== 'page') return null
  return (
    <>
      <Button variant="ghost" size="sm" icon="phone" onClick={() => { setOpen(true) }} title={t('在手机上操作工坊…', 'Work the Studio from a phone…')} />
      {open ? <RemoteDialog onClose={() => { setOpen(false) }} /> : null}
    </>
  )
}

function Code({ text }: { text: string }) {
  const drawn = useMemo(() => {
    try {
      return qrPath(text)
    } catch {
      return undefined
    }
  }, [text])
  if (drawn === undefined) return null
  return (
    <svg className="nv-qr" viewBox={`0 0 ${drawn.size} ${drawn.size}`} role="img" aria-label={text} shapeRendering="crispEdges">
      <rect width={drawn.size} height={drawn.size} fill="#ffffff" />
      <path d={drawn.path} fill="#000000" />
    </svg>
  )
}

/** The door for a phone: what it is, opening and closing it, and its address as a code to scan. */
export function RemoteDialog({ onClose }: { onClose: () => void }) {
  const { controller } = useStudio()
  const t = useT()
  // (A Host from before there was a door answers with an error: said as such.)
  const loaded = useLoad(signal => controller.api.call('remote.status', {}, signal), [])
  const [status, setStatus] = useState<RemoteStatus | undefined>(undefined)
  const { busy, run } = useAction()
  const now = status ?? loaded.data
  const [pick, setPick] = useState(0)
  const turn = (open: boolean): Promise<unknown> => run(async () => { setStatus(await controller.api.call(open ? 'remote.open' : 'remote.close', {})) })
  const url = now?.urls[Math.min(pick, Math.max(0, (now?.urls.length ?? 1) - 1))]
  const until = now?.until !== undefined ? new Date(now.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : undefined
  return (
    <Modal
      title={t('在手机上操作工坊', 'Work the Studio from a phone')}
      onClose={onClose}
      footer={now === undefined || !now.possible ? undefined : now.running
        ? <Button variant="outline" busy={busy} onClick={() => { turn(false) }}>{t('关闭入口', 'Close the door')}</Button>
        : <Button variant="primary" icon="phone" busy={busy} pending={t('正在打开…', 'Opening…')} onClick={() => { turn(true) }}>{t('打开入口', 'Open the door')}</Button>}
    >
      {loaded.loading && now === undefined ? <Spinner /> : null}
      {loaded.error !== undefined && now === undefined ? <p className="nv-note is-warn">{loaded.error}</p> : null}
      {now !== undefined && !now.possible ? (
        <>
          <p>{t('这要 DSH 以网页方式运行。桌面版没有网页可以转给手机。', 'This needs DSH running as a web page. The desktop app has no page to hand on to a phone.')}</p>
          <p className="nv-small">{t('在这台电脑上运行下面这条命令，在它打开的网页里进工坊，再从那里打开入口：', 'Run this on this computer, open the Studio in the page it opens, and open the door from there:')}</p>
          <pre className="nv-code">dsh web</pre>
        </>
      ) : null}
      {now !== undefined && now.possible && !now.running ? (
        <>
          <p>{t('同一个 Wi-Fi 下，用手机浏览器打开这台电脑上的 DSH，工坊铺满屏幕。', 'On the same Wi-Fi, a phone\'s browser opens the DSH of this computer, the Studio filling its screen.')}</p>
          <ul className="nv-plain-list nv-small">
            <li>{t('入口开着时，拿到链接的人能操作这台电脑上的整个 DSH（对话、工具、设置），不只是工坊——不要给别人。', 'While it is open, whoever has the link works all of DSH on this computer (conversations, tools, settings), not the Studio alone — give it to nobody.')}</li>
            <li>{t(`链接每次打开都换；${12} 小时后自己关，重启 DSH 也会关。`, 'The link is a new one each time; it closes by itself after 12 hours, and when DSH restarts.')}</li>
            <li>{t('局域网里不加密。', 'Nothing is encrypted on the local network.')}</li>
          </ul>
        </>
      ) : null}
      {now !== undefined && now.running && url !== undefined ? (
        <div className="nv-remote">
          <Code text={url} />
          <div className="nv-remote-side">
            <p>{t('用手机扫码，或在手机浏览器里打开：', 'Scan it with the phone, or open this in its browser:')}</p>
            <div className="nv-row">
              <code className="nv-remote-url">{url.replace(/\?k=.*$/u, '/?k=…')}</code>
              <Button size="sm" variant="ghost" icon="copy" onClick={() => { void navigator.clipboard?.writeText(url).then(() => { controller.toast('success', t('链接已复制', 'Link copied')) }).catch(() => {}) }}>{t('复制', 'Copy')}</Button>
            </div>
            {now.urls.length > 1 ? (
              <p className="nv-small nv-muted">
                {t('打不开就换一个地址：', 'If it does not open, try another address: ')}
                {now.urls.map((other, at) => <button key={other} type="button" className="nv-link nv-small" disabled={at === pick} onClick={() => { setPick(at) }}>{new URL(other).hostname}</button>)}
              </p>
            ) : null}
            <p className="nv-small nv-muted">{t(`开到 ${until ?? ''}。拿到链接的人能操作这台电脑上的整个 DSH。`, `Open until ${until ?? ''}. Whoever has the link works all of DSH on this computer.`)}</p>
          </div>
        </div>
      ) : null}
      {now?.error !== undefined ? <p className="nv-note is-warn">{now.error}</p> : null}
    </Modal>
  )
}
