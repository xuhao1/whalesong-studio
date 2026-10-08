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
import { formatCount } from '../../shared/text'
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
      {way === 'site' ? <PublishSite /> : status === undefined ? <div className="nv-center">{loaded.error !== undefined ? <p className="nv-muted">{t('这个版本的工坊服务还不支持手机阅读——重启一次 DSH 就有了。', 'This Studio service does not offer reading on other devices yet — restart the Harness once.')}</p> : <Spinner />}</div> : (
        <div className="nv-share">
          <p>
            {t(`打开之后，和这台电脑连着同一个 Wi-Fi 的手机、平板，用浏览器打开下面的地址，就能读《${project.manifest.title}》，有配音的章节能听，画好的有声漫也能看。`, `Once on, a phone or tablet on the same Wi-Fi as this computer can open the address below in its browser and read "${project.manifest.title}" — listen to the chapters that have a voice, and watch the motion comics that are drawn.`)}
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
              ? <li>{t('可编辑：那边可以改这本书的正文（每次保存前这边都会留一个版本，并记进"改动记录"），也可以玩幕间——每一回合会调用这台电脑上配置的模型，花的是你的用量。设置、密钥和没分享的书仍然碰不到。', 'Read and change: the text of this book can be edited from there (a version is kept here before each save, and the change goes on the record), and its interludes played — every turn calls the models set up on this computer, on your usage. Settings, keys and books you have not shared stay out of reach.')}</li>
              : <li>{t('仅阅读：那边不能改任何东西，也碰不到模型、密钥和没分享的书。想在手机上改稿、玩幕间，开启后选"可编辑"。', 'Read only: nothing can be changed from there, and models, keys and books you have not shared are out of reach. To edit or play interludes on the phone, choose "Read and change" once it is on.')}</li>}
            {mine?.sealed === true || sealedHere ? <li>{t('这本书加了密：每台设备第一次打开要输入它的密码，之后那台设备会被记住（在"加密与上锁"里可以逐台收回）。注意手机和电脑之间走的是局域网里的普通连接，密码和内容在这一段不加密——只在信得过的网络里开。', 'This book is sealed: every device is asked for its password the first time, and remembered afterwards (each can be withdrawn under "Seal and lock"). Mind that the link between phone and computer is an ordinary one inside the local network: the password and the content are not encrypted on that stretch — switch this on only on a network you trust.')}</li> : null}
            <li>{t('地址里带一段随机口令，拿到这个地址的人都能读——别发到不相干的地方。想让旧链接失效，点"换一个地址"。', 'The address carries a random token: whoever has it can read. To make links you gave out stop working, choose "New address".')}</li>
            <li>{t('电脑要开着、DSH 要开着才读得到；第一次打开时系统可能会问是否允许接入网络连接，选允许。', 'The computer and the Harness must be running; the first time, the system may ask whether to allow incoming connections — allow it.')}</li>
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
          {status.running && status.instead !== undefined ? <p className="nv-note">{t(`端口 ${status.instead} 被这台电脑上的别的程序占用了（比如另一个开着的 DSH），这次改用 ${status.port}——地址里的端口随之不同。`, `Port ${status.instead} is held by another program on this computer (another Harness, perhaps); ${status.port} is used instead — the address differs accordingly.`)}</p> : null}
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
  // A book published a part at a time: as far as one chapter; everything written when none is chosen.
  const [upto, setUpto] = useState('')
  const [mine, setMine] = useState(true)
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
    const finished = await controller.run('site.publish', { root, ...(out.trim().length > 0 ? { out: out.trim() } : {}), listen, watch, album, sides, ...(part !== undefined ? { upto: part.id } : {}), ...(mine ? { defaults: readerSettings() } : {}), ...(sealedOk ? { sealedOk: true } : {}) })
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
        {t(`把《${project.manifest.title}》做成一个文件夹：里面是和手机上一模一样的页面，加上这本书的正文、配音、有声漫、插图，和人物与世界的画册。把这个文件夹放到任何能放静态网页的地方（GitHub Pages、Cloudflare Pages、对象存储、自己的服务器……），别人打开网址就能读、听、看——不需要 DSH，也不需要这台电脑开着。`, `Turn "${project.manifest.title}" into a folder: the same pages a phone gets, with the book's text, voices, motion comic and pictures, and the album of its people and its world. Put the folder anywhere static pages are served (GitHub Pages, Cloudflare Pages, a bucket, your own server…) and whoever opens the address can read, listen and watch — without DSH, and without this computer.`)}
      </p>
      <ul className="nv-share-facts">
        <li>{t(`会发布：有正文的 ${data.chapters} 章${data.voiced > 0 ? `，其中 ${data.voiced} 章有配音` : ''}${data.drawn > 0 ? `，${data.drawn} 章有有声漫` : ''}。`, `Published: the ${data.chapters} chapters with text${data.voiced > 0 ? `, ${data.voiced} of them voiced` : ''}${data.drawn > 0 ? `, ${data.drawn} with a motion comic` : ''}.`)}</li>
        <li>{t('只有读者看得到的东西会放进去：正文、能听的声音、画好的画面、封面，以及（勾选时）人物和世界的画册。大纲、审校意见、提示词、模型和密钥都不在里面。', 'Only what a reader is given goes in: text, sound that plays, pictures that are drawn, the cover, and (when ticked) the album of the people and the world. The outline, review notes, prompts, models and keys do not.')}</li>
        <li>{t('发布出去的是只读的：不能在网站上改稿，也不能玩幕间（那要调用这台电脑上的模型）——您留作番外的幕间可以作为文字记录带上。', 'What is published is read-only: nothing can be edited on the site and no interlude can be played (that calls the models on this computer) — the ones you kept as side stories can go along as transcripts.')}</li>
        <li>{t('放到公开的地方，就是谁都能看。想只给几个人看，用"在手机上读"，或者把文件夹放到要登录的地方。', 'Put somewhere public, anyone can read it. To show it to a few people only, use reading on a phone, or host the folder behind a login.')}</li>
      </ul>
      {written.length > 1 ? (
        <Field label={t('发布到哪一章', 'Publish as far as')} hint={t('连载时用：只发布到某一章为止。画册也只讲到那一章——之后才登场的人、才成立的关系、才发生的死亡都不带。', 'For a book published a part at a time: as far as one chapter. The album is told up to it too — nobody who comes on later, no tie that begins later, no death that comes later.')}>
          <Select value={part?.id ?? ''} options={[{ value: '', label: t(`全部已写的章节（${written.length} 章）`, `Everything written (${written.length} chapters)`) }, ...written.slice(0, -1).map(chapter => ({ value: chapter.id, label: t(`到第 ${chapter.index} 章《${chapter.title}》为止`, `As far as chapter ${chapter.index}, "${chapter.title}"`) }))]} onChange={setUpto} />
        </Field>
      ) : null}
      <div className="nv-site-options">
        <label className="nv-check"><input type="checkbox" checked={listen} disabled={data.voiced === 0} onChange={(event) => { setListen(event.target.checked) }} /><span>{t('带上有声版（脚本、配音、环境声与音效）', 'With the audio drama (script, voices, ambience and effects)')}{data.voiced === 0 ? t('——这本书还没有配过音', ' — nothing is voiced yet') : ''}</span></label>
        <label className="nv-check"><input type="checkbox" checked={watch} disabled={data.drawn === 0} onChange={(event) => { setWatch(event.target.checked) }} /><span>{t('带上有声漫（分镜画面）', 'With the motion comic (its panels)')}{data.drawn === 0 ? t('——这本书还没有画过分镜', ' — no panel is drawn yet') : ''}</span></label>
        <label className="nv-check">
          <input type="checkbox" checked={album && data.album !== undefined} disabled={data.album === undefined} onChange={(event) => { setAlbum(event.target.checked) }} />
          <span>
            {t('带上人物和世界（画册）', 'With the people and the world (the album)')}
            {data.album === undefined
              ? t('——这本书还没有人物和设定', ' — the book has no people or bible yet')
              : t(`——已经写进正文的 ${data.album.people} 位人物、${data.album.places} 个地点、${data.album.factions} 个家族与组织、${data.album.items} 件物品，和 ${data.album.ideas} 条世界观`, ` — the ${data.album.people} people, ${data.album.places} places, ${data.album.factions} houses and ${data.album.items} things the text has come to, and ${data.album.ideas} ideas of the world`)}
            {part !== undefined ? t(`（这是全书的数；只发布到第 ${part.index} 章时，那一章之后才写到的不带，会更少）`, ` (of the whole book; published as far as chapter ${part.index}, what the text comes to after it is left out, so fewer)`) : ''}
            <em className="nv-muted nv-small">{t(' 每个人带：称呼、一句话身份、外貌、性格、来历、能力、履历、立绘和人设图、和谁是什么关系。动机、缺陷、人物弧光、秘密、备注、怎么画怎么配音——这些只在您的编辑页里，不带出去。地点和物品带：名字、概括、正文、设定图。', ' Of each person: names, who they are in a line, how they look, how they are, where they come from, what they can do, what they go through, portrait and design sheets, who they are to others. What they want and lack, the change planned for them, their secrets, your notes, how they are drawn and voiced — these stay on your editing pages. Of places and things: name, summary, what is written of them, design art.')}</em>
          </span>
        </label>
        {(data.sides ?? 0) > 0 ? (
          <label className="nv-check">
            <input type="checkbox" checked={sides} onChange={(event) => { setSides(event.target.checked) }} />
            <span>{t(`带上番外（${data.sides} 场留作番外的幕间：只带它们的文字记录，读者能读、不能玩）`, `With the side stories (${data.sides} interludes kept as side stories: their transcripts, to be read and not played)`)}</span>
          </label>
        ) : null}
      </div>
      <label className="nv-check nv-site-mine">
        <input type="checkbox" checked={mine} onChange={(event) => { setMine(event.target.checked) }} />
        <span>{t('访客第一次打开时，用我现在的阅读设置（字号、纸张、字体、声音注记、语速、音量、播完接下一章）——他们之后可以自己改，改了就按他们的', 'A visitor\'s first visit opens with my reading settings as they are now (type size, paper, typeface, sound notes, speed, volume, going on to the next chapter) — what they then change is theirs')}</span>
      </label>
      <Field label={t('发布到哪个文件夹', 'Folder to publish into')} hint={t('默认在这本书旁边新建一个文件夹；也可以填别处的路径。再次发布到同一个文件夹，只会更新有变化的文件。', 'By default a new folder beside the book; any other path can be given. Publishing into the same folder again writes only what changed.')}>
        <div className="nv-keyrow">
          <TextInput value={out} placeholder={data.out} spellCheck={false} onChange={(event) => { setOut(event.target.value) }} />
          {host.pickDirectory !== undefined ? <Button size="sm" icon="folder" onClick={pick}>{t('选择…', 'Choose…')}</Button> : null}
        </div>
      </Field>
      {data.previous !== undefined
        ? <p className={data.previous.sameBook ? 'nv-note' : 'nv-note is-warn'}>{data.previous.sameBook
            ? t(`这个文件夹里已经发布过这本书（${data.previous.publishedAt.slice(0, 16).replace('T', ' ')}，${data.previous.files} 个文件）。再发布一次只更新有变化的部分。`, `This book was published into this folder before (${data.previous.publishedAt.slice(0, 16).replace('T', ' ')}, ${data.previous.files} files). Publishing again writes only what changed.`)
            : t('这个文件夹里发布的是另一本书。继续的话，那本书的网站会被这本书的替换掉。', 'Another book was published into this folder. Going on replaces that book\'s site with this one\'s.')}</p>
        : data.occupied === true ? <p className="nv-note is-warn">{t('这个文件夹里已经有别的东西。网站的文件会写在它们旁边（不会删改不是这里发布的文件）——通常还是换一个空文件夹更好。', 'This folder already holds other things. The site\'s files are written beside them (nothing that was not published from here is changed or removed) — an empty folder is usually the better choice.')}</p> : null}
      {data.sealed ? (
        <label className="nv-check nv-site-sealed">
          <input type="checkbox" checked={sealedOk} onChange={(event) => { setSealedOk(event.target.checked) }} />
          <span><Icon name="lock" size={12} /> {t('这本书是加密的。发布出去的网站是明文：文件夹里的正文、图片和声音谁拿到都能看。我知道，仍然发布。', 'This book is sealed. A published site is not: whoever has the folder can read its text, pictures and sound. I know, publish it all the same.')}</span>
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
          <span>{t(`${done.chapters} 章${(done.sides ?? 0) > 0 ? `，${done.sides} 场番外` : ''}${done.album !== undefined ? `，画册里 ${done.album.people} 位人物、${done.album.places + done.album.factions + done.album.items + done.album.ideas} 条设定` : ''}，${formatCount(done.files, locale)} 个文件，共 ${megabytes(done.bytes)}；这一次写了 ${formatCount(done.written, locale)} 个${done.removed > 0 ? `，清掉上次留下而这次没有的 ${done.removed} 个` : ''}。`, `${done.chapters} chapters${(done.sides ?? 0) > 0 ? `, ${done.sides} side stories` : ''}${done.album !== undefined ? `, an album of ${done.album.people} people and ${done.album.places + done.album.factions + done.album.items + done.album.ideas} entries` : ''}, ${formatCount(done.files, locale)} files, ${megabytes(done.bytes)} in all; ${formatCount(done.written, locale)} written this time${done.removed > 0 ? `, ${done.removed} left from last time removed` : ''}.`)}</span>
          <code className="nv-share-url">{done.dir}</code>
          <div className="nv-row-wrap">
            <Button size="sm" icon="copy" onClick={() => controller.guard(async () => { await navigator.clipboard.writeText(done.dir); controller.toast('success', t('路径已复制', 'Path copied')) })}>{t('复制路径', 'Copy the path')}</Button>
          </div>
          <span className="nv-muted nv-small">{t('想先在这台电脑上看一眼：在这个文件夹里开一个本地的静态服务器（比如 `npx serve` 或 `python3 -m http.server`），用浏览器打开它给的地址。直接双击 index.html 不行——浏览器不让本地文件读旁边的数据。', 'To look at it on this computer first: start a local static server in the folder (`npx serve`, `python3 -m http.server`) and open the address it gives. Opening index.html by double-click does not work — a browser does not let a local file read the data beside it.')}</span>
          {done.missing.length > 0 ? <span className="nv-small">{t(`有 ${done.missing.length} 个图片或声音文件书里提到了、磁盘上却没有，已跳过：${done.missing.slice(0, 3).join('、')}${done.missing.length > 3 ? ' 等' : ''}`, `${done.missing.length} pictures or sounds the book names are not on disk and were left out: ${done.missing.slice(0, 3).join(', ')}${done.missing.length > 3 ? '…' : ''}`)}</span> : null}
        </div>
      ) : null}
    </div>
  )
}
