// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * How a picture came to be.
 *
 * Wherever a picture is opened large in the workshop — somebody's portrait or
 * design sheet, the design art of a place or a thing, anything in the gallery —
 * it is shown with all there is on record of its making: what its prompt was
 * put together from, part by part and in the order the parts were sent; the
 * pictures that went along as references (each opens its own record, so a
 * look can be followed back from picture to picture); what reached the image
 * service word for word; and how all of that stands against the book as it is
 * now — an anchor or an art direction changed since, a portrait drawn against
 * a sheet that has been drawn again.
 *
 * A look nobody asked for comes from somewhere: a word in the anchor, a
 * reference picture, the art direction — or from none of them, and then from
 * the model. This is where the author finds out which.
 *
 * It is the author's alone. Nothing of it goes to a reader: prompts do not
 * leave the book through the shared reader or a published site.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { lookWords, resolveArtStyle, tidyPart, type ArtSource, scenesOf, sceneWords } from '../shared/art'
import type { IllustrationInfo, IllustrationPiece } from '../shared/types'
import { Button, Chip, cx, Modal, Spinner, TextArea, TextInput, useAction, useConfirm, useLoad, useMediaUrl, useProject, useSnapshot, useStudio, useT } from './ui'
import { leftBehind } from './labels'
import { Icon } from './icons'

export const PICTURE_KIND: Record<IllustrationInfo['kind'], [string, string]> = {
  portrait: ['立绘', 'Portrait'],
  sheet: ['人设图', 'Design sheet'],
  scene: ['场景插图', 'Scene'],
  location: ['场景设定图', 'Place art'],
  item: ['物品设定图', 'Object art'],
  cover: ['封面', 'Cover'],
  panel: ['分镜', 'Panel'],
  background: ['幕间背景', 'Background'],
  sprite: ['表情差分', 'Sprite'],
}

const SOURCE: Record<ArtSource, [string, string]> = {
  book: ['本书设定', 'Set for this book'],
  studio: ['来自工坊设置', 'From the Studio settings'],
  default: ['内置默认', 'Built-in default'],
}

const SERVICE: Record<string, [string, string]> = {
  dashscope: ['阿里云百炼', 'Aliyun Bailian'],
  openai: ['OpenAI 兼容接口', 'OpenAI-compatible endpoint'],
  openrouter: ['OpenRouter', 'OpenRouter'],
  codex: ['ChatGPT 订阅', 'ChatGPT subscription'],
}

const PIECE: Record<Exclude<IllustrationPiece['of'], 'look'>, [string, string]> = {
  frame: ['画面要求', 'Kind of picture'],
  outfit: ['这套造型', 'This outfit'],
  expression: ['神态', 'Expression'],
  ask: ['这一张的要求', 'Asked of this one'],
  composed: ['导演写的画面', 'Composed by the director'],
  scene: ['名场面', 'Signature scene'],
}

/** Every picture on record in the open book, by its path. */
export interface Pictures {
  byPath: Map<string, IllustrationInfo>
  /** The records have arrived (a book without pictures has none, and that is known). */
  loaded: boolean
}

export function usePictures(): Pictures {
  const { controller } = useStudio()
  const { project, root } = useProject()
  const images = useLoad(signal => controller.api.call('image.list', { root }, signal), [root, project.revision])
  return useMemo(() => ({ byPath: new Map((images.data?.images ?? []).map(image => [image.path, image])), loaded: images.data !== undefined || images.error !== undefined }), [images.data, images.error])
}

/**
 * The way to take a picture out of the book, wherever one is shown: its file, its record, and off every card and
 * entry that holds it up — asked first, and said afterwards whose it was. One control for every picture: a portrait,
 * a design sheet, the art of a place, the picture of a moment.
 * @param onDone - called once it is gone (the dialog that showed it closes).
 * @param bare - the icon alone, for beside a thumbnail.
 */
export function DeletePicture({ path, onDone, bare, disabled }: { path: string; onDone?: ((released: string[]) => void) | undefined; bare?: boolean; disabled?: boolean }) {
  const { controller } = useStudio()
  const t = useT()
  const { root } = useProject()
  const confirm = useConfirm()
  const { busy, run } = useAction()
  return (
    <>
      <Button size={bare === true ? 'sm' : undefined} variant="ghost" icon="trash" busy={busy} disabled={disabled} title={t('删除这张图', 'Delete this picture')} onClick={() => {
        confirm.ask(t('删除这张图？用它的人物卡和条目会取下它；正文里插着它的地方不会自动移除。', 'Delete this picture? Cards and entries using it let go of it; where it sits in the text it is not removed.'), () => {
          void run(async () => {
            // By its path: a picture drawn before records were kept, or copied in, has no record to name it by.
            const done = await controller.api.call('image.delete', { root, path })
            await controller.refreshProject()
            const released = done.released ?? []
            controller.toast('info', released.length > 0 ? t(`已删除，并从 ${released.join('、')} 取下`, `Deleted, and taken off ${released.join(', ')}`) : t('已删除', 'Deleted'))
            onDone?.(released)
          })
        })
      }}>{bare === true ? null : t('删除', 'Delete')}</Button>
      {confirm.element}
    </>
  )
}

/**
 * A picture drawn again from where it is shown: its words rewritten, or the picture itself changed in one thing.
 * The new picture takes this one's place wherever it hangs; this one stays in the gallery.
 */
function RedrawPicture({ image, mode, onDone }: { image: IllustrationInfo; mode: 'words' | 'change'; onDone: () => void }) {
  const { controller } = useStudio()
  const t = useT()
  const { root } = useProject()
  const [words, setWords] = useState(image.parts?.subject ?? image.prompt)
  const [change, setChange] = useState('')
  const { busy, run } = useAction()
  const ready = mode === 'words' ? words.trim().length > 0 : change.trim().length > 0
  const go = (): void => {
    if (!ready || busy || !controller.need('image')) return
    void run(async () => {
      const job = await controller.run('image.redraw', { root, picture: image.id, ...(mode === 'words' ? { subject: words.trim() } : { change: change.trim() }) })
      await controller.refreshProject()
      const replaced = Array.isArray(job.result?.replaced) ? job.result.replaced.filter((name): name is string => typeof name === 'string') : []
      controller.toast('success', `${replaced.length > 0 ? t(`画好了，换到了 ${replaced.join('、')} 上；原来那张还在图库里`, `Drawn, and put in its place on ${replaced.join(', ')}; the one before is still in the gallery`) : t('画好了：新的一张在图库里', 'Drawn: the new picture is in the gallery')}${leftBehind(job, t)}`)
      onDone()
    })
  }
  return (
    <div className="nv-picture-redraw">
      {mode === 'words' ? (
        <>
          <TextArea autoFocus value={words} minRows={4} maxRows={14} onChange={(event) => { setWords(event.target.value) }} />
          <p className="nv-muted nv-small">{t('这张图的画面部分。画风、不要出现和它原来带的参考图照旧附上。', 'What the picture shows. The art direction, what to keep out and the references it had go along as before.')}</p>
        </>
      ) : (
        <>
          <TextInput autoFocus value={change} placeholder={t('改成什么样：背景换成雪夜；头发放下来', 'What to change: a snowy night behind her; her hair down')} onChange={(event) => { setChange(event.target.value) }} onKeyDown={(event) => { if (event.key === 'Enter') go() }} />
          <p className="nv-muted nv-small">{t('这张图会发给绘图模型，照着它重画，只改这一处。', 'The picture goes to the image model, to be drawn again with this one change.')}</p>
        </>
      )}
      <Button variant="primary" icon="image" busy={busy} disabled={!ready} pending={t('正在画…', 'Drawing…')} onClick={go}>{mode === 'words' ? t('照这段重画', 'Draw from these words') : t('照着它改', 'Draw it changed')}</Button>
    </div>
  )
}

/** Whose look a picture restates: somebody's, or that of a place or a thing. */
export interface LookOf {
  kind: 'character' | 'world'
  id: string
  /** Not the look itself but the moment a portrait shows, which is written on the same card. */
  what?: 'scene'
}

/** One thing that holds — or no longer holds — between a picture and the book as it is now. */
interface Standing {
  tone: 'ok' | 'warn' | 'info'
  text: string
  /** Something to do about it, or somewhere to look. */
  action?: { label: string; run: () => void }
}

/**
 * What is on record of one picture's making.
 * @param onOpen - open another picture's record (a reference, the picture that took this one's place).
 * @param onEditLook - go to where the words for how its subject looks are written: somebody's card, the entry of a place or a thing.
 */
export function PictureFacts({ image, pictures, natural, onOpen, onEditLook }: { image: IllustrationInfo; pictures: Pictures; natural?: { width: number; height: number } | undefined; onOpen?: ((path: string) => void) | undefined; onEditLook?: ((of: LookOf) => void) | undefined }) {
  const { controller } = useStudio()
  const t = useT()
  const { project } = useProject()
  const mediaUrl = useMediaUrl()
  const studio = useSnapshot(snapshot => snapshot.settings?.settings.image)
  const parts = image.parts
  const sent = image.sent
  const references = parts?.references ?? []
  // What it would have been held against, had the image service taken them: all of it, or what was over its measure.
  const left = parts?.left ?? []
  const leftNames = left.map(reference => reference.label).join(t('、', ', '))
  const card = image.kind === 'portrait' || image.kind === 'sheet' ? project.characters.find(candidate => candidate.id === image.target) : undefined
  const entry = image.kind === 'location' || image.kind === 'item' ? project.world.find(candidate => candidate.id === image.target) : undefined
  const chapter = image.kind === 'scene' ? project.chapters.find(candidate => candidate.id === image.target) ?? (project.lines ?? []).flatMap(line => line.chapters).find(candidate => candidate.id === image.target) : undefined
  const whose = card?.name ?? entry?.name ?? chapter?.title

  // Every picture somebody or something holds up as theirs right now: a reference that is none of these is an older one.
  const held = useMemo(() => {
    const paths = new Set<string>()
    for (const person of project.characters) {
      for (const path of [person.visual?.portrait, person.visual?.sheet, ...(person.visual?.looks ?? []).map(look => look.sheet)]) if (path !== undefined) paths.add(path)
    }
    for (const thing of project.world) {
      for (const path of [thing.visualImage, ...(thing.events ?? []).map(event => event.image)]) if (path !== undefined) paths.add(path)
    }
    return paths
  }, [project.characters, project.world])

  const look = parts?.pieces?.find(piece => piece.of === 'look')
  // Whose look a `look` is: somebody's — the person the picture is of, or the people a picture of the author's own
  // prompt names (a scene; a place or a thing has a picture of its own kind).
  const person = card !== undefined || image.kind === 'scene'
  // A sheet of a look (an outfit), not the main one: it is in use as one, its record has an outfit — or, from before
  // records had parts, its subject says what a look's always said.
  const worn = (card?.visual?.looks ?? []).find(candidate => candidate.sheet === image.path)
  const ofLook = image.kind === 'sheet' && (worn !== undefined || parts?.pieces?.some(piece => piece.of === 'outfit') === true || /与参考图是同一个人|the same person as in the reference/.test(parts?.subject ?? ''))
  const styleNow = resolveArtStyle(project.manifest, studio?.stylePrompt).text
  const of: LookOf | undefined = card !== undefined ? { kind: 'character', id: card.id } : entry !== undefined ? { kind: 'world', id: entry.id } : undefined
  const editLook = onEditLook !== undefined && of !== undefined ? () => { onEditLook(of) } : undefined

  // ── how it stands against the book as it is now ──
  const standing: Standing[] = []
  const open = (path: string | undefined, label: string): Standing['action'] | undefined => (path !== undefined && onOpen !== undefined ? { label, run: () => { onOpen(path) } } : undefined)
  const withAction = (item: Omit<Standing, 'action'>, action: Standing['action'] | undefined): Standing => (action !== undefined ? { ...item, action } : item)
  if (card !== undefined) {
    if (image.kind === 'portrait') {
      standing.push(card.visual?.portrait === image.path
        ? { tone: 'ok', text: t('这是现在的立绘。', 'This is the portrait in use now.') }
        : withAction({ tone: 'warn', text: t('这是以前的一张立绘，现在用的是另一张。', 'This is an earlier portrait; another one is in use now.') }, open(card.visual?.portrait, t('看现在的那张', 'See the one in use'))))
    } else if (worn !== undefined) {
      standing.push({ tone: 'ok', text: t(`这是造型「${worn.name}」现在的人设图。`, `This is the sheet in use for the look "${worn.name}".`) })
    } else if (ofLook) {
      standing.push({ tone: 'warn', text: t('这是某套造型以前的一张人设图，现在用的是另一张。', 'This is an earlier sheet of one of their looks; another one is in use now.') })
    } else {
      standing.push(card.visual?.sheet === image.path
        ? { tone: 'ok', text: t('这是现在的人设图：之后每一张有这个人的图，都照它画。', 'This is the design sheet in use now: every later picture of them is drawn against it.') }
        : withAction({ tone: 'warn', text: t('这是以前的一张人设图，现在用的是另一张。', 'This is an earlier design sheet; another one is in use now.') }, open(card.visual?.sheet, t('看现在的那张', 'See the one in use'))))
    }
    // The words for how they look: the same now as when this was drawn, or changed since.
    const now = tidyPart(lookWords(card))
    const then = look?.text
    const same = then !== undefined ? then === now : parts !== undefined && !parts.subject.endsWith('…') && now.length > 0 ? parts.subject.includes(now) : undefined
    const anchored = (card.visual?.prompt ?? '').length > 0
    if (same === true) standing.push({ tone: 'ok', text: anchored ? t('视觉锚点和现在的一样。', 'The visual anchor is the same as now.') : t('外貌和现在的一样。', 'The appearance is as it is now.') })
    else if (same === false) standing.push(withAction({ tone: 'warn', text: t('视觉锚点在这张图之后改过。', 'The visual anchor was changed after this picture.') }, editLook !== undefined ? { label: t('看现在的视觉锚点', 'See the anchor as it is'), run: editLook } : undefined))
    // The moment a portrait shows: the one on the card now, or another.
    const scenePiece = parts?.pieces?.find(piece => piece.of === 'scene')
    const shownScene = scenePiece?.text
    if (image.kind === 'portrait' && scenePiece?.from === 'asked') {
      standing.push({ tone: 'info', text: t('这一幕是导演按你当时的要求挑的，只用在这一张。', 'The director picked this scene by what you asked then; it serves this picture only.') })
    } else if (image.kind === 'portrait' && shownScene !== undefined) {
      const kept = scenesOf(card).map(scene => tidyPart(sceneWords(scene)))
      if (!kept.includes(shownScene)) standing.push(withAction({ tone: 'warn', text: kept.length > 0 ? t('这一幕在这张图之后改过，或已不在名场面里。', 'This moment was changed after the picture, or is no longer among their scenes.') : t('人物卡上现在没有名场面：这张画的是当时的那一幕。', 'The card keeps no scene now: this shows the one of that time.') }, onEditLook !== undefined ? { label: t('看现在的', 'See it as it is'), run: () => { onEditLook({ kind: 'character', id: card.id, what: 'scene' }) } } : undefined))
    }
    // A portrait is held against the sheet: against the one in use, an older one, or none.
    if (image.kind === 'portrait' && card.visual?.sheet !== undefined) {
      if (references.some(reference => reference.path === card.visual!.sheet)) standing.push({ tone: 'ok', text: t('照着现在这张人设图画的。', 'Drawn against the design sheet in use now.') })
      else if (references.length > 0) standing.push({ tone: 'warn', text: t('照着以前的一张人设图画的。', 'Drawn against an earlier design sheet.') })
      else standing.push({ tone: 'warn', text: left.length > 0 ? t('绘图服务没有收参考图，人设图没有带上。', 'The image service took no reference picture: the design sheet did not go along.') : t('画的时候没有带人设图。', 'Drawn without a design sheet.') })
    }
    if (image.kind === 'sheet' && !ofLook && references.length === 0 && left.length > 0) standing.push({ tone: 'warn', text: t('绘图服务没有收参考图，立绘没有带上：只照文字画的。', 'The image service took no reference picture: the portrait did not go along, and this came from the words alone.') })
    if (image.kind === 'sheet' && !ofLook && references.length > 0) {
      // Against their portrait: the portrait leads (or it was asked for this once). Against anything else: how sheets were redrawn once.
      const portraits = new Set([card.visual?.portrait, ...(card.stages ?? []).map(stage => stage.visual?.portrait), ...scenesOf(card).map(scene => scene.portrait)].filter((path): path is string => path !== undefined))
      if (references.some(reference => reference.path === card.visual?.portrait)) standing.push({ tone: 'ok', text: t('照着现在这张立绘画的。', 'Drawn against the portrait in use now.') })
      else if (references.some(reference => portraits.has(reference.path) || /^portrait-|\/portrait-/.test(reference.path))) standing.push({ tone: 'warn', text: t('照着以前的一张立绘画的。', 'Drawn against an earlier portrait.') })
      else standing.push({ tone: 'info', text: t('这张人设图是照着另一张图画的，所以和那张几乎一样。现在重画只照文字。', 'This sheet was drawn against another picture, so it is nearly the same. A redraw now goes by the words alone.') })
    }
  } else if (entry !== undefined) {
    const turn = (entry.events ?? []).find(event => event.image === image.path)
    standing.push(entry.visualImage === image.path
      ? { tone: 'ok', text: t('这是它现在的设定图。', 'This is its design art in use now.') }
      : turn !== undefined
        ? { tone: 'ok', text: t('这是它轨迹里一件事之后的样子。', 'This is how it looks from one turn of its course on.') }
        : withAction({ tone: 'warn', text: t('这是以前的一张，现在用的是另一张。', 'This is an earlier picture; another one is in use now.') }, open(entry.visualImage, t('看现在的那张', 'See the one in use'))))
    if (look?.from === 'anchor' && turn === undefined) {
      const now = tidyPart(entry.visualPrompt ?? '')
      if (now === look.text) standing.push({ tone: 'ok', text: t('条目上写的"样子"和现在的一样。', 'The look written on the entry is the same as now.') })
      else standing.push(withAction({ tone: 'warn', text: t('条目上写的"样子"在这张图之后改过。', 'The look written on the entry was changed after this picture.') }, editLook !== undefined ? { label: t('看现在写的', 'See it as it is'), run: editLook } : undefined))
    }
  }
  if (parts?.style !== undefined) {
    standing.push(tidyPart(parts.style) === tidyPart(styleNow)
      ? { tone: 'ok', text: t('画风和现在的一样。', 'The art direction is the same as now.') }
      : { tone: 'warn', text: t('这本书的画风在这张图之后改过：这张图带的是当时的画风。', 'The book\'s art direction was changed after this picture: it carries the one of that time.'), action: { label: t('看现在的画风', 'See the art direction'), run: () => { controller.openArt() } } })
  }

  // ── the pictures that went along ──
  const said = parts?.referenceNote
  const unsent = said !== undefined && references.length === 0

  const statusOf = (path: string): { label: string; tone: 'green' | 'amber' | 'neutral' } => {
    if (held.has(path)) return { label: t('现在还在用', 'In use now'), tone: 'green' }
    if (pictures.byPath.has(path)) return { label: t('旧的一张', 'An earlier one'), tone: 'amber' }
    return { label: t('已不在图库里', 'No longer in the gallery'), tone: 'neutral' }
  }

  const kept = parts?.avoid ?? []
  const wire = sent?.prompt ?? image.prompt
  const avoidHow = kept.length === 0 ? undefined
    : sent?.negative !== undefined ? t('作为"负面提示词"单独一栏发给了绘图模型。', 'Sent to the image model in a field of its own, the negative prompt.')
      : sent !== undefined ? (sent.prompt.includes('Avoid:') ? t('接在提示词最后（Avoid: …）。', 'Appended to the prompt (Avoid: …).') : t('提示词太长，这一段没能带上。', 'The prompt was too long: this part did not fit.'))
        : undefined
  const service = image.provider !== undefined ? SERVICE[image.provider] : undefined
  const copy = (): Promise<unknown> => controller.guard(async () => {
    await navigator.clipboard.writeText([wire, ...(sent?.negative !== undefined ? [`\n[negative]\n${sent.negative}`] : [])].join('\n'))
    controller.toast('success', t('已复制', 'Copied'))
  })

  return (
    <div className="nv-picture-record">
      <header className="nv-picture-head">
        <Chip>{t(...PICTURE_KIND[image.kind])}</Chip>
        {whose !== undefined ? <strong>{whose}</strong> : null}
        <span className="nv-muted nv-small">{new Date(image.createdAt).toLocaleString()}</span>
      </header>
      <p className="nv-picture-made nv-small">
        <span>{image.model ?? t('（没记下模型）', '(model not recorded)')}{service !== undefined ? ` · ${t(...service)}` : ''}</span>
        {sent?.sampling !== undefined ? <span>{t(`${sent.sampling.steps} 步 · 引导 ${sent.sampling.guidance} · ${sent.sampling.sampler}/${sent.sampling.scheduler}`, `${sent.sampling.steps} steps · guidance ${sent.sampling.guidance} · ${sent.sampling.sampler}/${sent.sampling.scheduler}`)}{sent.sampling.from === 'server' ? t('（照服务器上这个模型上次跑的）', ' (as the server last ran this model)') : sent.sampling.from === 'builtin' ? t('（内置的默认值）', ' (the built-in figures)') : ''}</span> : null}
        {sent?.seed !== undefined ? <span>{t(`种子 ${sent.seed}`, `seed ${sent.seed}`)}</span> : null}
        {sent?.compact !== undefined ? <span>{sent.compact.failed === true
          ? t(`提示词约 ${sent.compact.from} 个 token，这个模型只读 ${sent.compact.limit} 个；没压成，照原样发了`, `the prompt came to about ${sent.compact.from} tokens and this model reads ${sent.compact.limit}; it could not be fitted and went as it was`)
          : t(`导演把提示词从约 ${sent.compact.from} 个 token 压到了约 ${sent.compact.tokens ?? sent.compact.limit} 个（这个模型只读 ${sent.compact.limit} 个）${sent.compact.cut === true ? '；他写的仍超出一点，末尾放不下的截掉了' : ''}`, `the director brought the prompt from about ${sent.compact.from} tokens to about ${sent.compact.tokens ?? sent.compact.limit} (this model reads ${sent.compact.limit})${sent.compact.cut === true ? '; what he wrote was still a little over, and its end was left off' : ''}`)}</span> : null}
        {image.size !== undefined ? <span>{t(`要的尺寸 ${image.size}`, `asked for ${image.size}`)}{sent?.size !== undefined && sent.size.replace('*', 'x') !== image.size ? t(`（发给接口的是 ${sent.size}）`, ` (the service was sent ${sent.size})`) : ''}</span> : sent?.size !== undefined ? <span>{t(`发给接口的尺寸 ${sent.size}`, `the service was sent ${sent.size}`)}</span> : null}
        {natural !== undefined ? <span>{t(`画出来 ${natural.width}×${natural.height}`, `drawn at ${natural.width}×${natural.height}`)}</span> : null}
      </p>

      {standing.length > 0 ? (
        <section>
          <h4>{t('对照现在', 'Against the book as it is now')}</h4>
          <ul className="nv-picture-now">
            {standing.map((item, index) => (
              <li key={index} className={`is-${item.tone}`}>
                <Icon name={item.tone === 'ok' ? 'check' : item.tone === 'warn' ? 'alert' : 'info'} size={13} />
                <span>{item.text}{item.action !== undefined ? <> <button type="button" className="nv-link" onClick={item.action.run}>{item.action.label}</button></> : null}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <h4>{t('参考图', 'Reference pictures')}{references.length > 0 ? <span className="nv-muted"> · {t(`${references.length} 张，和提示词一起发给了绘图模型`, `${references.length}, sent to the image model with the prompt`)}</span> : null}</h4>
        {references.length > 0 ? (
          <div className="nv-parts-refs">
            {references.map((reference, index) => {
              const status = statusOf(reference.path)
              const known = pictures.byPath.has(reference.path)
              const body = (
                <>
                  <img alt={reference.label} loading="lazy" src={mediaUrl(reference.path)} />
                  <figcaption>{t(`第 ${index + 1} 张 · ${reference.label}`, `#${index + 1} · ${reference.label}`)}<Chip tone={status.tone}>{status.label}</Chip></figcaption>
                </>
              )
              return known && onOpen !== undefined
                ? <button key={reference.path} type="button" className="nv-parts-ref" onClick={() => { onOpen(reference.path) }} title={t('点开看这张参考图，和它自己是怎么来的', 'Open this reference, and how it came to be itself')}>{body}</button>
                : <figure key={reference.path} className="nv-parts-ref">{body}</figure>
            })}
            {left.length > 0 ? <p className="nv-picture-warn nv-small"><Icon name="alert" size={13} /><span>{t(`画这张图的绘图服务一次只收 ${references.length} 张参考图：${leftNames}的图没带上。`, `The image service this was drawn with takes ${references.length} reference picture${references.length === 1 ? '' : 's'} at a time: ${leftNames} stayed behind.`)}</span></p> : null}
          </div>
        ) : left.length > 0 ? (
          <p className="nv-picture-warn nv-small"><Icon name="alert" size={13} /><span>{parts?.leftWhy !== undefined
            ? t(`参考图发过去了，绘图服务没有收：${leftNames}的图没带上，改成只照文字画的。它的回答：${parts.leftWhy}`, `The reference pictures were sent and the image service would not take them: ${leftNames} stayed behind, and it was drawn from the words alone. It answered: ${parts.leftWhy}`)
            : t(`画这张图的绘图服务不收参考图：${leftNames}的图没有带，只照文字画的。`, `The image service this was drawn with takes no reference pictures: ${leftNames} stayed behind, and it came from the words alone.`)}</span></p>
        ) : unsent ? (
          <p className="nv-picture-warn nv-small"><Icon name="alert" size={13} /><span>{t('提示词里说了参考图，可绘图服务没有收图：这张图只照文字画的。', 'The prompt spoke of references, but the image service took none: this picture came from the words alone.')}</span></p>
        ) : (
          <p className="nv-muted nv-small">{image.kind === 'sheet' && !ofLook ? t('没有带参考图：人设图只照文字画。', 'No references: a design sheet is drawn from the words alone.') : t('没有带参考图：只照文字画的。', 'None: drawn from the words alone.')}</p>
        )}
      </section>

      <section>
        <h4>{t('提示词是这样拼起来的', 'What the prompt was put together from')}<span className="nv-muted"> · {t('按发出去的先后', 'in the order sent')}</span></h4>
        {parts !== undefined ? (
          <dl className="nv-parts">
            {parts.pieces !== undefined && parts.pieces.length > 0 ? parts.pieces.map((piece, index) => (
              <PieceRow key={index} label={piece.of === 'look' ? (person ? t('这个人的样子', 'How they look') : t('它的样子', 'How it looks')) : t(...PIECE[piece.of])} chip={piece.of === 'scene' ? (piece.from === 'asked' ? t('导演按这一张的要求挑的', 'picked by the director for this picture') : t('人物卡上的名场面', 'one of the card\'s signature scenes')) : piece.of !== 'look' ? undefined : person
                ? (piece.from === 'anchor' ? t('视觉锚点', 'visual anchor') : t('人物卡的外貌（还没有视觉锚点）', 'the card\'s appearance (no anchor yet)'))
                : (piece.from === 'anchor' ? t('条目上的"样子"', 'the entry\'s look') : t('条目的名字和概括', 'the entry\'s name and summary'))}
              >
                {piece.text}
                {piece.of === 'look' && editLook !== undefined ? <> <button type="button" className="nv-link nv-small" onClick={editLook}>{t('去改', 'Change it')}</button></> : null}
                {piece.of === 'scene' && piece.asked !== undefined ? <span className="nv-muted nv-small"> —— {t(`你当时写的要求：${piece.asked}`, `What you asked then: ${piece.asked}`)}</span> : null}
                {piece.of === 'scene' && onEditLook !== undefined && card !== undefined ? <> <button type="button" className="nv-link nv-small" onClick={() => { onEditLook({ kind: 'character', id: card.id, what: 'scene' }) }}>{piece.from === 'asked' ? t('看名场面', 'See their scenes') : t('去改', 'Change it')}</button></> : null}
              </PieceRow>
            )) : <PieceRow label={t('画面内容', 'Subject')}>{parts.subject}</PieceRow>}
            {parts.clipped === true ? <PieceRow label={t('注意', 'Note')}><span className="nv-picture-warn">{t('画面内容太长，被截短了。', 'The subject was too long and was cut short.')}</span></PieceRow> : null}
            {said !== undefined ? <PieceRow label={t('参考图怎么用', 'What the references are for')}>{said}</PieceRow> : null}
            {parts.style !== undefined ? (
              <PieceRow label={t('画风', 'Art direction')} chip={parts.styleSource !== undefined ? t(...SOURCE[parts.styleSource]) : undefined} tone={parts.styleSource === 'book' ? 'green' : 'amber'}>
                {parts.style} <button type="button" className="nv-link nv-small" onClick={() => { controller.openArt() }}>{t('去改', 'Change it')}</button>
              </PieceRow>
            ) : <PieceRow label={t('画风', 'Art direction')}>{t('没有带：这一张是原样发送的。', 'None: this one was sent as written.')}</PieceRow>}
            {kept.length > 0 ? (
              <PieceRow label={t('不要出现', 'Kept out')}>
                {kept.join(t('、', ', '))}
                {avoidHow !== undefined ? <span className="nv-muted nv-small"> —— {avoidHow}</span> : null}
              </PieceRow>
            ) : null}
          </dl>
        ) : <p className="nv-muted nv-small">{t('这张图没有记下各部分；完整的提示词在下面。', 'The parts of this prompt were not kept; the whole prompt is below.')}</p>}
      </section>

      <section>
        <h4>
          {t('发给绘图模型的原话', 'What the image model was sent, word for word')}
          <Button size="sm" variant="ghost" icon="copy" onClick={copy} title={t('复制', 'Copy')} />
        </h4>
        <pre className="nv-picture-sent">{wire}</pre>
        {sent?.negative !== undefined ? (
          <>
            <p className="nv-muted nv-small">{t('负面提示词（单独一栏）', 'Negative prompt (a field of its own)')}</p>
            <pre className="nv-picture-sent">{sent.negative}</pre>
          </>
        ) : null}
        {sent === undefined ? <p className="nv-muted nv-small">{t('这张图是在工坊开始记“原话”之前画的：上面是工坊拼好的提示词。', 'Drawn before the Studio kept the exact words sent: above is the prompt as the Studio composed it.')}</p> : null}
      </section>
      <p className="nv-muted nv-small nv-picture-file">{image.path}</p>
    </div>
  )
}

function PieceRow({ label, chip, tone = 'neutral', children }: { label: string; chip?: string | undefined; tone?: 'neutral' | 'green' | 'amber'; children: ReactNode }) {
  return (
    <>
      <dt>{label}{chip !== undefined ? <Chip tone={tone}>{chip}</Chip> : null}</dt>
      <dd>{children}</dd>
    </>
  )
}

/**
 * A picture opened large, with how it came to be beside it. A reference
 * picture opens in its place, with its own record, and there is a way back.
 * @param note - what this picture is to the page it was opened from, said under it.
 * @param footer - what can be done with the picture looked at (the gallery: make it the cover, delete it).
 * @param onEditLook - where the page that opened it has the words for a look itself; left out, the card or the entry is opened.
 */
/**
 * A picture opened large, with the record of its making beside it — and what can be done with a picture, the same
 * wherever one is shown: keep a copy of it, draw it again (its words rewritten, or the picture changed in one
 * thing), take it out of the book.
 * @param footer - what else the page that shows it can do with it, put before those.
 * @param onChanged - the picture was drawn again or removed: whatever lists pictures reads them anew.
 */
export function PictureViewer({ path, title, note, footer, onClose, onEditLook, onChanged }: { path: string; title?: string | undefined; note?: ReactNode; footer?: ((image: IllustrationInfo | undefined) => ReactNode) | undefined; onClose: () => void; onEditLook?: ((of: LookOf) => void) | undefined; onChanged?: (() => void) | undefined }) {
  const { controller } = useStudio()
  const t = useT()
  const { project } = useProject()
  const mediaUrl = useMediaUrl()
  const pictures = usePictures()
  // The pictures stepped through from the one that was opened: the last is the one looked at.
  const [trail, setTrail] = useState<string[]>([path])
  useEffect(() => { setTrail([path]) }, [path])
  const at = trail.at(-1) ?? path
  const image = pictures.byPath.get(at)
  const [natural, setNatural] = useState<{ path: string; width: number; height: number } | undefined>()
  const first = at === path
  // Drawing it again: which of the two ways is open under the picture.
  const [redraw, setRedraw] = useState<'words' | 'change' | undefined>()
  useEffect(() => { setRedraw(undefined) }, [at])
  const gone = (): void => {
    onChanged?.()
    onClose()
  }
  const nameOf = (record: IllustrationInfo): string | undefined => (record.target === undefined ? undefined
    : project.characters.find(card => card.id === record.target)?.name
      ?? project.world.find(entry => entry.id === record.target)?.name
      ?? project.chapters.find(chapter => chapter.id === record.target)?.title)
  // The words are on a page behind this one: it closes, and the page shows them.
  const editLook = (of: LookOf): void => {
    onClose()
    if (onEditLook !== undefined) onEditLook(of)
    else if (of.kind === 'character') controller.openCharacter(of.id)
    else controller.openWorld(of.id)
  }
  const heading = first && title !== undefined ? title : image !== undefined ? `${t(...PICTURE_KIND[image.kind])}${nameOf(image) !== undefined ? ` · ${nameOf(image)}` : ''}` : title ?? t('图片', 'Picture')
  return (
    <Modal wide className="nv-modal-picture" title={heading} onClose={onClose} footer={first ? (
      <>
        <a className="nv-link" href={controller.api.media(project.manifest.id, at, { download: true })}>{t('下载', 'Download')}</a>
        <span className="nv-spacer" />
        {footer !== undefined ? footer(image) : null}
        {image !== undefined && image.kind !== 'panel' ? (
          <>
            <Button variant={redraw === 'words' ? 'primary' : 'outline'} icon="type" onClick={() => { setRedraw(redraw === 'words' ? undefined : 'words') }} title={t('把这张图的提示词拿出来改，照改过的画一张', 'Rewrite this picture\'s words and draw it from them')}>{t('改提示词重画', 'Rewrite and redraw')}</Button>
            <Button variant={redraw === 'change' ? 'primary' : 'outline'} icon="wand" onClick={() => { setRedraw(redraw === 'change' ? undefined : 'change') }} title={t('把这张图发给绘图模型，照着它只改一处', 'Send this picture along and have one thing changed in it')}>{t('照着这张改', 'Change this picture')}</Button>
          </>
        ) : null}
        <DeletePicture path={at} onDone={gone} />
      </>
    ) : undefined}>
      <div className="nv-picture">
        <div className="nv-picture-stage">
          {!first ? <button type="button" className="nv-link nv-small nv-picture-back" onClick={() => { setTrail(previous => previous.slice(0, -1)) }}><Icon name="chevronLeft" size={12} />{t('回到上一张', 'Back to the picture before')}</button> : null}
          <img className="nv-picture-large" alt={heading} src={mediaUrl(at)} onLoad={(event) => { setNatural({ path: at, width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }) }} />
          {first && note !== undefined && redraw === undefined ? <div className="nv-muted nv-small">{note}</div> : null}
          {first && image !== undefined && redraw !== undefined ? <RedrawPicture key={redraw} image={image} mode={redraw} onDone={gone} /> : null}
        </div>
        <div className={cx('nv-picture-facts', image === undefined && 'is-bare')}>
          {image !== undefined
            ? <PictureFacts image={image} pictures={pictures} natural={natural?.path === at ? natural : undefined} onOpen={(next) => { setTrail(previous => (previous.at(-1) === next ? previous : [...previous, next])) }} onEditLook={editLook} />
            : pictures.loaded
              ? (
                  <>
                    <p className="nv-muted nv-small">{t('这张图没有留下记录。', 'No record was kept of this picture.')}</p>
                    <p className="nv-muted nv-small nv-picture-file">{at}</p>
                  </>
                )
              : <div className="nv-center"><Spinner /></div>}
        </div>
      </div>
    </Modal>
  )
}
