// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Showing a book to somebody else, two ways out of one dialog.
 *
 * On this network: switch the reader for phones and tablets on and off for
 * this book, and hand over its address — as a code to scan, and as text to
 * copy. As a site of its own: the same reader with the same book written out
 * as a folder any static host serves. Either way it says plainly what it
 * means: who can read, and what leaves the book.
 */
import { useMemo, useState } from 'react'
import { qrPath } from '../../shared/qr'
import type { ShareStatus, SiteDone } from '../../shared/rpc'
import { FFMPEG_INSTALL, formatCount } from '../../shared/text'
import { Icon } from '../icons'
import { readerSettings } from '../reader/parts'
import { Button, Chip, Field, Modal, Progress, Select, Spinner, Tabs, TextInput, useAction, useLoad, useProject, useRunningJob, useSnapshot, useStudio, useT } from '../ui'

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
  const mine = status?.books.find(book => book.root === root)
  const shared = mine !== undefined
  const on = status !== undefined && status.enabled && shared
  const mode = mine?.mode ?? 'read'
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
  const sealedHere = useSnapshot(snapshot => snapshot.workspaces.flatMap(workspace => workspace.projects).find(ref => ref.root === root)?.sealed) === true
  const wanted = port !== undefined ? Number(port) : undefined
  const [way, setWay] = useState<'network' | 'site'>('network')
  return (
    <Modal title={t('给别人看', 'Show it to somebody')} onClose={onClose} wide>
      <Tabs value={way} onChange={setWay} tabs={[
        { value: 'network', label: t('在手机上读（同一个 Wi-Fi）', 'On a phone (same network)'), icon: 'phone' },
        { value: 'site', label: t('发布成网站', 'Publish as a site'), icon: 'globe' },
      ]} />
      {way === 'site' ? <PublishSite /> : status === undefined ? <div className="nv-center">{loaded.error !== undefined ? <p className="nv-muted">{t('这个版本的工坊服务还不支持手机阅读——重启一次 DSH 就有了。', 'This Studio service does not offer reading on other devices yet — restart DSH once.')}</p> : <Spinner />}</div> : (
        <div className="nv-share">
          <p>
            {t(`同一个 Wi-Fi 下的手机、平板，用浏览器打开下面的地址就能读《${project.manifest.title}》。`, `Phones and tablets on the same Wi-Fi read "${project.manifest.title}" by opening the address below in a browser.`)}
          </p>
          {on ? (
            <div className="nv-share-mode">
              <span className="nv-muted nv-small">{t('在那边可以', 'From there one can')}</span>
              <div className="nv-seg" role="group">
                <button type="button" className={mode === 'read' ? 'is-active' : undefined} onClick={() => { void update({ book: { root, shared: true, mode: 'read' } }) }}><Icon name="eye" size={13} /><span>{t('仅阅读', 'Read only')}</span></button>
                <button type="button" className={mode === 'edit' ? 'is-active' : undefined} onClick={() => { void update({ book: { root, shared: true, mode: 'edit' } }) }}><Icon name="pen" size={13} /><span>{t('可编辑', 'Read and change')}</span></button>
              </div>
            </div>
          ) : null}
          <ul className="nv-share-facts">
            {mode === 'edit' && on
              ? <li>{t('可编辑：那边可以改正文、玩幕间，花的是你的模型用量。', 'Editing: the text can be changed there and interludes played, on your model usage.')}</li>
              : <li>{t('仅阅读：那边不能改任何东西。', 'Reading only: nothing can be changed from there.')}</li>}
            {mine?.sealed === true || sealedHere ? <li>{t('这本书加了密：每台设备第一次打开要输入密码。局域网里这一段不加密，只在信得过的网络里开。', 'This book is sealed: each device enters the password once. The hop across the local network is not encrypted — only on a network you trust.')}</li> : null}
            <li>{t('拿到这个地址的人都能读。想让旧链接失效，点“换一个地址”。', 'Whoever has the address can read. "New address" makes the old link stop working.')}</li>
            <li>{t('电脑和 DSH 要开着。', 'The computer and DSH must be running.')}</li>
          </ul>
          <div className="nv-row-wrap">
            {on
              ? <Button variant="outline" icon="x" pending={t('正在关闭…', 'Turning off…')} onClick={() => update({ book: { root, shared: false } })}>{t('不再分享这本书', 'Stop sharing this book')}</Button>
              : <Button variant="primary" icon="phone" pending={t('正在开启…', 'Turning on…')} onClick={() => update({ enabled: true, book: { root, shared: true } })}>{t('开启：让手机读这本书', 'Turn on for this book')}</Button>}
            {status.enabled && status.books.length > 0 ? <Button variant="ghost" pending={t('正在关闭…', 'Turning off…')} onClick={() => update({ enabled: false })}>{t('全部关闭', 'Turn everything off')}</Button> : null}
            <span className="nv-spacer" />
            {on ? <Chip tone={status.running ? 'green' : 'red'}>{status.running ? t('已开启', 'On') : t('没能启动', 'Could not start')}</Chip> : <Chip>{t('未开启', 'Off')}</Chip>}
          </div>
          {status.error !== undefined && status.enabled ? <p className="nv-note is-warn">{/in use/.test(status.error) ? t('端口都被占着，没能启动。换一个端口再试。', 'Every port was taken and it could not start. Try another port.') : status.error}</p> : null}
          {status.running && status.instead !== undefined ? <p className="nv-note">{t(`端口 ${status.instead} 被占用，这次改用 ${status.port}。`, `Port ${status.instead} was taken; ${status.port} is used this time.`)}</p> : null}
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
              <Field label={t('监听端口', 'Port to listen on')} hint={t('默认 4319', '4319 by default')}>
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

/** When a site was published, by this computer's clock; as it was written down when that is no date. */
const publishedWhen = (iso: string, locale: string): string => {
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString(locale, { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

const megabytes = (bytes: number): string => (bytes >= 1024 * 1024 * 1024 ? `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB` : bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`)

/**
 * The book as a site of its own: a folder with the reader and the book in it,
 * which any static host serves and which needs neither DSH nor this computer.
 */
function PublishSite() {
  const { controller, host, locale } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const [out, setOut] = useState('')
  const [listen, setListen] = useState(true)
  const [watch, setWatch] = useState(true)
  const [album, setAlbum] = useState(true)
  const [sides, setSides] = useState(true)
  // The finished videos: what a chapter has that weighs most, so what they come to is said beside the choice.
  const [video, setVideo] = useState(true)
  // The other ways the story goes: with the book unless the author keeps to the main line.
  const [lines, setLines] = useState(true)
  // A book published a part at a time: as far as one chapter; everything written when none is chosen.
  const [upto, setUpto] = useState('')
  const [mine, setMine] = useState(true)
  // Voices lie in the book uncompressed; on the way out they are made a quarter the size unless the author keeps them as they are.
  const [press, setPress] = useState(true)
  // Pictures lie in the book as the image model made them, megabytes each; on the way out they are made JPEG unless the author keeps them as they are.
  const [jpeg, setJpeg] = useState(true)
  const written = project.chapters.filter(chapter => chapter.hasText)
  const part = written.find(chapter => chapter.id === upto)
  const [sealedOk, setSealedOk] = useState(false)
  const [done, setDone] = useState<SiteDone | undefined>()
  const plan = useLoad(signal => controller.api.call('site.plan', { root, ...(out.trim().length > 0 ? { out: out.trim() } : {}) }, signal), [root, out, done])
  const running = useRunningJob(job => job.kind === 'export' && job.title === 'publish site')
  const { busy, run } = useAction()
  const data = plan.data
  const publish = (): Promise<unknown> => run(async () => {
    setDone(undefined)
    const finished = await controller.run('site.publish', { root, ...(out.trim().length > 0 ? { out: out.trim() } : {}), listen, watch, album, sides, ...(video ? {} : { video: false }), ...(lines ? {} : { lines: false }), ...(press ? {} : { press: false }), ...(jpeg ? {} : { jpeg: false }), ...(part !== undefined ? { upto: part.id } : {}), ...(mine ? { defaults: readerSettings() } : {}), ...(sealedOk ? { sealedOk: true } : {}) })
    const output = finished.result?.output as SiteDone | undefined
    if (output !== undefined) setDone(output)
  })
  const pick = (): void => {
    void controller.guard(async () => {
      const picked = await host.pickDirectory?.()
      if (typeof picked === 'string' && picked.length > 0) setOut(picked)
    })
  }
  if (data === undefined) return <div className="nv-center">{plan.error !== undefined ? <p className="nv-muted">{/unknown method/.test(plan.error) ? t('这个版本的工坊后台还不会发布网站——在顶上点"重启"换成新版本就有了。', 'This Studio backend cannot publish a site yet — press Restart at the top to change to the new version.') : plan.error}</p> : <Spinner size={18} />}</div>
  return (
    <div className="nv-share nv-site">
      <p>
        {t(`把《${project.manifest.title}》做成一个文件夹，放到任何静态网页托管上，别人打开网址就能读、听、看。`, `"${project.manifest.title}" as one folder: put it on any static host and people read, listen and watch at its address.`)}
      </p>
      <ul className="nv-share-facts">
        <li>{t(`会发布：有正文的 ${data.chapters} 章${data.voiced > 0 ? `，其中 ${data.voiced} 章有配音` : ''}${data.drawn > 0 ? `，${data.drawn} 章有有声漫` : ''}。`, `Published: the ${data.chapters} chapters with text${data.voiced > 0 ? `, ${data.voiced} of them voiced` : ''}${data.drawn > 0 ? `, ${data.drawn} with a motion comic` : ''}.`)}</li>
        <li>{t('只有读者看得到的东西会放进去；大纲、审校意见、提示词、模型和密钥都不在里面。', 'Only what a reader sees goes in; outlines, review notes, prompts, models and keys do not.')}</li>
        <li>{t('网站是只读的。', 'The site is read-only.')}</li>
        <li>{t('放到公开的地方，就是谁都能看。', 'Put somewhere public, it is there for anyone.')}</li>
      </ul>
      {written.length > 1 ? (
        <Field label={t('发布到哪一章', 'Publish as far as')} hint={t('连载时用：只发布到某一章为止，画册也只讲到那一章。', 'For a serial: publish up to one chapter, and the album tells only as far.')}>
          <Select value={part?.id ?? ''} options={[{ value: '', label: t(`全部已写的章节（${written.length} 章）`, `Everything written (${written.length} chapters)`) }, ...written.slice(0, -1).map(chapter => ({ value: chapter.id, label: t(`到第 ${chapter.index} 章《${chapter.title}》为止`, `As far as chapter ${chapter.index}, "${chapter.title}"`) }))]} onChange={setUpto} />
        </Field>
      ) : null}
      <div className="nv-site-options">
        <label className="nv-check"><input type="checkbox" checked={listen} disabled={data.voiced === 0} onChange={(event) => { setListen(event.target.checked) }} /><span>{t('带上有声版', 'With the audio edition')}{data.voiced === 0 ? t('——这本书还没有配过音', ' — nothing is voiced yet') : ''}</span></label>
        {data.press !== undefined && (data.voiced > 0 || (data.sides ?? 0) > 0) ? (
          <label className="nv-check nv-site-press">
            <input type="checkbox" checked={press && data.press} disabled={!data.press || (!listen && !sides)} onChange={(event) => { setPress(event.target.checked) }} />
            <span>
              {t('把配音和声音压缩成 AAC，体积约四分之一', 'Compress voices and sound to AAC, about a quarter the size')}
              {data.press
                ? <em className="nv-muted nv-small">{t(' 书里的原件不动。', ' The book\'s own files are left as they are.')}</em>
                : <em className="nv-site-press-missing">{t(`——这台电脑上没有 ffmpeg，压缩不了。${FFMPEG_INSTALL[0]}。`, ` — no ffmpeg on this computer, so nothing can be compressed. ${FFMPEG_INSTALL[1]}.`)}</em>}
            </span>
          </label>
        ) : null}
        <label className="nv-check"><input type="checkbox" checked={watch} disabled={data.drawn === 0} onChange={(event) => { setWatch(event.target.checked) }} /><span>{t('带上有声漫', 'With the motion comic')}{data.drawn === 0 ? t('——这本书还没有画过分镜', ' — no panel is drawn yet') : ''}</span></label>
        {data.videos !== undefined ? (
          <label className="nv-check">
            <input type="checkbox" checked={video} onChange={(event) => { setVideo(event.target.checked) }} />
            <span>
              {t(`带上成片视频：${data.videos.chapters} 章，共 ${megabytes(data.videos.bytes)}`, `With the finished videos: ${data.videos.chapters} chapter(s), ${megabytes(data.videos.bytes)}`)}
            </span>
          </label>
        ) : null}
        <label className="nv-check">
          <input type="checkbox" checked={album && data.album !== undefined} disabled={data.album === undefined} onChange={(event) => { setAlbum(event.target.checked) }} />
          <span>
            {t('带上人物和世界的画册', 'With the album of people and the world')}
            {data.album === undefined
              ? t('——这本书还没有人物和设定', ' — the book has no people or bible yet')
              : t(`——${data.album.people} 位人物、${data.album.places} 个地点、${data.album.factions} 个家族与组织、${data.album.items} 件物品、${data.album.ideas} 条世界观`, ` — ${data.album.people} people, ${data.album.places} places, ${data.album.factions} houses and groups, ${data.album.items} things, ${data.album.ideas} ideas`)}
            <em className="nv-muted nv-small">{t(' 动机、缺陷、弧光、秘密、备注和提示词不带出去。', ' Wants, flaws, arcs, secrets, notes and prompts stay behind.')}</em>
          </span>
        </label>
        {data.lines !== undefined ? (
          <label className="nv-check">
            <input type="checkbox" checked={lines && part === undefined} disabled={part !== undefined} onChange={(event) => { setLines(event.target.checked) }} />
            <span>
              {t(`带上其他剧情线：${data.lines.titles.slice(0, 4).join('、')}${data.lines.titles.length > 4 ? ' 等' : ''}，${data.lines.chapters} 章`, `With the other plot lines: ${data.lines.titles.slice(0, 4).join(', ')}${data.lines.titles.length > 4 ? ' …' : ''}, ${data.lines.chapters} chapter(s)`)}
              <em className="nv-muted nv-small">{part !== undefined
                ? t(' 只发布到某一章时发布的是主线的一段，不带别的线。', ' A book published as far as one chapter is a part of the main line, without the others.')
                : t(' 搁置的线、还没有正文的线不带。', ' Shelved lines and lines with no text are left out.')}</em>
            </span>
          </label>
        ) : null}
        {(data.sides ?? 0) > 0 ? (
          <label className="nv-check">
            <input type="checkbox" checked={sides} onChange={(event) => { setSides(event.target.checked) }} />
            <span>{t(`带上番外：${data.sides} 场`, `With the side stories: ${data.sides}`)}</span>
          </label>
        ) : null}
        {data.jpeg !== undefined ? (
          <label className="nv-check nv-site-press">
            <input type="checkbox" checked={jpeg && data.jpeg} disabled={!data.jpeg} onChange={(event) => { setJpeg(event.target.checked) }} />
            <span>
              {t('把图片压缩成 JPG，体积约五分之一到十分之一', 'Compress pictures to JPEG, a fifth to a tenth the size')}
              {data.jpeg
                ? <em className="nv-muted nv-small">{t(' 书里的原件不动；带透明的图不压。', ' The book\'s own files are left as they are; pictures with transparency are not compressed.')}</em>
                : <em className="nv-site-press-missing">{t(`——这台电脑上没有 ffmpeg，压缩不了。${FFMPEG_INSTALL[0]}。`, ` — no ffmpeg on this computer, so nothing can be compressed. ${FFMPEG_INSTALL[1]}.`)}</em>}
            </span>
          </label>
        ) : null}
      </div>
      <label className="nv-check nv-site-mine">
        <input type="checkbox" checked={mine} onChange={(event) => { setMine(event.target.checked) }} />
        <span>{t('访客第一次打开时，用我现在的阅读设置', 'Visitors start with my reading settings as they are now')}</span>
      </label>
      <Field label={t('发布到哪个文件夹', 'Folder to publish into')} hint={t('再次发布到同一个文件夹，只更新有变化的文件。', 'Publishing to the same folder again only updates what changed.')}>
        <div className="nv-keyrow">
          <TextInput value={out} placeholder={data.out} spellCheck={false} onChange={(event) => { setOut(event.target.value) }} />
          {host.pickDirectory !== undefined ? <Button size="sm" icon="folder" onClick={pick}>{t('选择…', 'Choose…')}</Button> : null}
        </div>
      </Field>
      {data.previous !== undefined
        ? <p className={data.previous.sameBook ? 'nv-note' : 'nv-note is-warn'}>{data.previous.sameBook
            ? t(`这个文件夹里已发布过这本书（${publishedWhen(data.previous.publishedAt, locale)}，${data.previous.files} 个文件）。`, `This book was published to this folder before (${publishedWhen(data.previous.publishedAt, locale)}, ${data.previous.files} files).`)
            : t('这个文件夹里是另一本书的网站，继续会把它换掉。', 'This folder holds another book\'s site; going on replaces it.')}</p>
        : data.occupied === true ? <p className="nv-note is-warn">{t('这个文件夹里已有别的东西，最好换一个空文件夹。', 'This folder already holds other things: an empty one is better.')}</p> : null}
      {data.sealed ? (
        <label className="nv-check nv-site-sealed">
          <input type="checkbox" checked={sealedOk} onChange={(event) => { setSealedOk(event.target.checked) }} />
          <span><Icon name="lock" size={12} /> {t('这本书是加密的，发布出去的是明文。我知道，仍然发布。', 'This book is sealed and what is published is plaintext. I know; publish anyway.')}</span>
        </label>
      ) : null}
      {running !== undefined ? <Progress done={running.progress?.done ?? 0} total={running.progress?.total ?? 0} label={running.progress?.label ?? t('正在写出网站…', 'Writing the site…')} /> : null}
      <div className="nv-row-wrap">
        <Button variant="primary" icon="globe" busy={busy || running !== undefined} pending={t('正在发布…', 'Publishing…')} disabled={data.chapters === 0 || (data.sealed && !sealedOk)} onClick={publish}>{data.previous?.sameBook === true ? t('再发布一次', 'Publish again') : t('发布成网站', 'Publish as a site')}</Button>
        {data.chapters === 0 ? <span className="nv-muted nv-small">{t('这本书还没有正文可发布。', 'There is no text to publish yet.')}</span> : null}
      </div>
      {done !== undefined ? (
        <div className="nv-note is-ok nv-site-done" role="status">
          <strong>{t('发布好了。', 'Published.')}</strong>
          <span>{t(`${done.chapters} 章${(done.sides ?? 0) > 0 ? `，${done.sides} 场番外` : ''}${(done.videos ?? 0) > 0 ? `，${done.videos} 章成片视频` : ''}${done.lines !== undefined ? `，另外 ${done.lines.lines} 条剧情线（它们自己的 ${done.lines.chapters} 章）` : ''}${done.album !== undefined ? `，画册里 ${done.album.people} 位人物、${done.album.places + done.album.factions + done.album.items + done.album.ideas} 条设定` : ''}，${formatCount(done.files, locale)} 个文件，共 ${megabytes(done.bytes)}；这一次写了 ${formatCount(done.written, locale)} 个${done.removed > 0 ? `，清掉上次留下而这次没有的 ${done.removed} 个` : ''}。`, `${done.chapters} chapters${(done.sides ?? 0) > 0 ? `, ${done.sides} side stories` : ''}${(done.videos ?? 0) > 0 ? `, ${done.videos} finished videos` : ''}${done.lines !== undefined ? `, ${done.lines.lines} other lines of the plot (${done.lines.chapters} chapters of their own)` : ''}${done.album !== undefined ? `, an album of ${done.album.people} people and ${done.album.places + done.album.factions + done.album.items + done.album.ideas} entries` : ''}, ${formatCount(done.files, locale)} files, ${megabytes(done.bytes)} in all; ${formatCount(done.written, locale)} written this time${done.removed > 0 ? `, ${done.removed} left from last time removed` : ''}.`)}</span>
          {done.sound !== undefined ? (
            <span>
              {t(`配音和声音：${formatCount(done.sound.files, locale)} 个文件压缩成了 AAC，${megabytes(done.sound.from)} → ${megabytes(done.sound.to)}。`, `Voices and sound: ${formatCount(done.sound.files, locale)} files went out as AAC, ${megabytes(done.sound.from)} → ${megabytes(done.sound.to)}.`)}
              {done.sound.failed.length > 0 ? t(`有 ${done.sound.failed.length} 个没能压缩，按原样（WAV）带上了：${done.sound.failed.slice(0, 3).join('、')}${done.sound.failed.length > 3 ? ' 等' : ''}${done.sound.reason !== undefined ? `（${done.sound.reason}）` : ''}`, ` ${done.sound.failed.length} could not be compressed and went out as WAV: ${done.sound.failed.slice(0, 3).join(', ')}${done.sound.failed.length > 3 ? '…' : ''}${done.sound.reason !== undefined ? ` (${done.sound.reason})` : ''}`) : ''}
            </span>
          ) : null}
          {done.pictures !== undefined ? (
            <span>
              {done.pictures.files > 0 ? t(`图片：${formatCount(done.pictures.files, locale)} 张压缩成了 JPG，${megabytes(done.pictures.from)} → ${megabytes(done.pictures.to)}。`, `Pictures: ${formatCount(done.pictures.files, locale)} went out as JPG, ${megabytes(done.pictures.from)} → ${megabytes(done.pictures.to)}.`) : null}
              {(done.pictures.kept ?? 0) > 0 ? t(`有 ${done.pictures.kept} 张带透明的，JPG 存不了透明，按原样（PNG）带上了。`, ` ${done.pictures.kept} are see-through somewhere, which a JPG cannot be, and went out as PNG.`) : null}
              {done.pictures.failed.length > 0 ? t(`有 ${done.pictures.failed.length} 张没能压缩，按原样（PNG）带上了：${done.pictures.failed.slice(0, 3).join('、')}${done.pictures.failed.length > 3 ? ' 等' : ''}${done.pictures.reason !== undefined ? `（${done.pictures.reason}）` : ''}`, ` ${done.pictures.failed.length} could not be compressed and went out as PNG: ${done.pictures.failed.slice(0, 3).join(', ')}${done.pictures.failed.length > 3 ? '…' : ''}${done.pictures.reason !== undefined ? ` (${done.pictures.reason})` : ''}`) : null}
            </span>
          ) : null}
          {done.unshrunk === true ? <span>{t(`图片按原样（PNG）带上了：这台电脑上没有 ffmpeg。${FFMPEG_INSTALL[0]}。`, `Pictures went out as they are (PNG): no ffmpeg on this computer. ${FFMPEG_INSTALL[1]}.`)}</span> : null}
          {done.unpressed === true ? <span>{t(`配音和声音按原样（WAV）带上了：这台电脑上没有 ffmpeg。${FFMPEG_INSTALL[0]}。`, `Voices and sound went out as they are (WAV): no ffmpeg on this computer. ${FFMPEG_INSTALL[1]}.`)}</span> : null}
          <code className="nv-share-url">{done.dir}</code>
          <div className="nv-row-wrap">
            <Button size="sm" icon="copy" onClick={() => controller.guard(async () => { await navigator.clipboard.writeText(done.dir); controller.toast('success', t('路径已复制', 'Path copied')) })}>{t('复制路径', 'Copy the path')}</Button>
          </div>
          <span className="nv-muted nv-small">{t('想先在本机看：在这个文件夹里开一个静态服务器（如 `npx serve`）。直接双击 index.html 不行。', 'To look at it here first: start a static server in the folder (`npx serve`, say). Opening index.html directly does not work.')}</span>
          {done.missing.length > 0 ? <span className="nv-small">{t(`有 ${done.missing.length} 个图片或声音文件书里提到了、磁盘上却没有，已跳过：${done.missing.slice(0, 3).join('、')}${done.missing.length > 3 ? ' 等' : ''}`, `${done.missing.length} pictures or sounds the book names are not on disk and were left out: ${done.missing.slice(0, 3).join(', ')}${done.missing.length > 3 ? '…' : ''}`)}</span> : null}
        </div>
      ) : null}
    </div>
  )
}
