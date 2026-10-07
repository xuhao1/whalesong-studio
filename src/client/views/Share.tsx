// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Reading on another device: switch the reader for phones and tablets on and
 * off for this book, and hand over its address — as a code to scan, and as
 * text to copy. Says plainly what switching it on means.
 */
import { useMemo, useState } from 'react'
import { qrPath } from '../../shared/qr'
import type { ShareStatus } from '../../shared/rpc'
import { Button, Chip, Field, Modal, Spinner, TextInput, useLoad, useProject, useStudio, useT } from '../ui'

function Code({ text }: { text: string }) {
  const drawn = useMemo(() => {
    try {
      return qrPath(text)
    } catch {
      return undefined
    }
  }, [text])
  if (drawn === undefined) return null
  // Always dark on white, whatever the theme: a camera reads contrast, not taste.
  return (
    <svg className="nv-qr" viewBox={`0 0 ${drawn.size} ${drawn.size}`} role="img" aria-label={text} shapeRendering="crispEdges">
      <rect width={drawn.size} height={drawn.size} fill="#ffffff" />
      <path d={drawn.path} fill="#000000" />
    </svg>
  )
}

export function ShareDialog({ onClose }: { onClose: () => void }) {
  const { controller } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const loaded = useLoad(signal => controller.api.call('share.status', {}, signal), [])
  const [picked, setPicked] = useState(0)
  const [port, setPort] = useState<string | undefined>()
  const status: ShareStatus | undefined = loaded.data
  const shared = status?.books.some(book => book.root === root) === true
  const on = status !== undefined && status.enabled && shared
  const update = (params: Parameters<typeof controller.api.call<'share.update'>>[1]): Promise<unknown> => controller.guard(async () => {
    loaded.set(await controller.api.call('share.update', params))
  })
  const url = status?.urls[Math.min(picked, Math.max(0, status.urls.length - 1))]
  // Straight to this book, rather than to the shelf of everything shared.
  const link = url !== undefined ? `${url}#/book/${encodeURIComponent(project.manifest.id)}` : undefined
  const copy = (): Promise<unknown> => controller.guard(async () => {
    if (link === undefined) return
    await navigator.clipboard.writeText(link)
    controller.toast('success', t('链接已复制', 'Link copied'))
  })
  const others = status?.books.filter(book => book.root !== root) ?? []
  const wanted = port !== undefined ? Number(port) : undefined
  return (
    <Modal title={t('在手机上读', 'Read on another device')} onClose={onClose} wide>
      {status === undefined ? <div className="nv-center">{loaded.error !== undefined ? <p className="nv-muted">{t('这个版本的工坊服务还不支持手机阅读——重启一次 Harness 就有了。', 'This Studio service does not offer reading on other devices yet — restart the Harness once.')}</p> : <Spinner />}</div> : (
        <div className="nv-share">
          <p>
            {t(`打开之后，和这台电脑连着同一个 Wi-Fi 的手机、平板，用浏览器打开下面的地址，就能读《${project.manifest.title}》，有配音的章节也能听。`, `Once on, a phone or tablet on the same Wi-Fi as this computer can open the address below in its browser and read "${project.manifest.title}" — and listen to the chapters that have a voice.`)}
          </p>
          <ul className="nv-share-facts">
            <li>{t('只读：那边不能改任何东西，也碰不到模型、密钥和没分享的书。', 'Read-only: nothing can be changed from there, and models, keys and books you have not shared are out of reach.')}</li>
            <li>{t('地址里带一段随机口令，拿到这个地址的人都能读——别发到不相干的地方。想让旧链接失效，点"换一个地址"。', 'The address carries a random token: whoever has it can read. To make links you gave out stop working, choose "New address".')}</li>
            <li>{t('电脑要开着、Harness 要开着才读得到；第一次打开时系统可能会问是否允许接入网络连接，选允许。', 'The computer and the Harness must be running; the first time, the system may ask whether to allow incoming connections — allow it.')}</li>
          </ul>
          <div className="nv-row-wrap">
            {on
              ? <Button variant="outline" icon="x" pending={t('正在关闭…', 'Turning off…')} onClick={() => update({ book: { root, shared: false } })}>{t('不再分享这本书', 'Stop sharing this book')}</Button>
              : <Button variant="primary" icon="phone" pending={t('正在开启…', 'Turning on…')} onClick={() => update({ enabled: true, book: { root, shared: true } })}>{t('开启：让手机读这本书', 'Turn on for this book')}</Button>}
            {status.enabled && status.books.length > 0 ? <Button variant="ghost" pending={t('正在关闭…', 'Turning off…')} onClick={() => update({ enabled: false })}>{t('全部关闭', 'Turn everything off')}</Button> : null}
            <span className="nv-spacer" />
            {on ? <Chip tone={status.running ? 'green' : 'red'}>{status.running ? t('已开启', 'On') : t('没能启动', 'Could not start')}</Chip> : <Chip>{t('未开启', 'Off')}</Chip>}
          </div>
          {status.error !== undefined && status.enabled ? <p className="nv-note is-warn">{/in use/.test(status.error) ? t('这台电脑上的端口都被别的程序占着，没能启动。在下面的"端口"里换一个再试。', 'The ports are taken by other programs on this computer. Choose another one under "Port" below.') : status.error}</p> : null}
          {status.running && status.instead !== undefined ? <p className="nv-note">{t(`端口 ${status.instead} 被这台电脑上的别的程序占用了（比如另一个开着的 Harness），这次改用 ${status.port}——地址里的端口随之不同。`, `Port ${status.instead} is held by another program on this computer (another Harness, perhaps); ${status.port} is used instead — the address differs accordingly.`)}</p> : null}
          {on && status.running && link !== undefined ? (
            <div className="nv-share-link">
              <Code text={link} />
              <div className="nv-share-how">
                <strong>{t('用手机相机扫这个码，或者在手机浏览器里输入：', 'Scan this with the phone\'s camera, or type into its browser:')}</strong>
                <code className="nv-share-url">{link}</code>
                <div className="nv-row-wrap">
                  <Button size="sm" icon="copy" onClick={copy}>{t('复制链接', 'Copy link')}</Button>
                  <Button size="sm" variant="ghost" icon="refresh" pending={t('正在更换…', 'Replacing…')} onClick={() => update({ renew: true })} title={t('换一段新的口令，之前给出去的链接全部失效', 'A new token; every link given out before stops working')}>{t('换一个地址', 'New address')}</Button>
                </div>
                {status.urls.length > 1 ? (
                  <div className="nv-share-hosts">
                    <span className="nv-muted nv-small">{t('这台电脑有几个地址，打不开就换一个试试：', 'This computer has several addresses; if one does not open, try another:')}</span>
                    <div className="nv-row-wrap">
                      {status.urls.map((candidate, index) => <Chip key={candidate} tone="blue" active={index === picked} onClick={() => { setPicked(index) }}>{new URL(candidate).hostname}</Chip>)}
                    </div>
                  </div>
                ) : status.urls.length === 0 ? <p className="nv-note is-warn">{t('这台电脑现在没有连到任何网络。', 'This computer is not on any network right now.')}</p> : null}
              </div>
            </div>
          ) : null}
          {others.length > 0 ? <p className="nv-muted nv-small">{t(`同一个地址还能读到：${others.map(book => `《${book.title}》`).join('、')}`, `The same address also serves: ${others.map(book => `"${book.title}"`).join(', ')}`)}</p> : null}
          <details className="nv-share-advanced">
            <summary>{t('端口', 'Port')}</summary>
            <div className="nv-keyrow">
              <Field label={t('监听端口', 'Port to listen on')} hint={t('默认 4319；被别的程序占用时换一个（1024–65535）', 'Default 4319; pick another (1024-65535) when something else uses it')}>
                <TextInput inputMode="numeric" value={port ?? String(status.port ?? 4319)} onChange={(event) => { setPort(event.target.value.replace(/\D/g, '')) }} />
              </Field>
              <Button size="sm" disabled={wanted === undefined || wanted === status.port || !Number.isInteger(wanted) || wanted < 1024 || wanted > 65535} pending={t('正在更换…', 'Changing…')} onClick={() => update({ port: wanted! })}>{t('换到这个端口', 'Use this port')}</Button>
            </div>
          </details>
        </div>
      )}
    </Modal>
  )
}
