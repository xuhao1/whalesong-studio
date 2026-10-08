// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The look of a book's pictures, as a page of its bible. Every book has a look
 * of its own — it belongs with who is in the book and how the book is written,
 * not among the Studio's settings. Here the author reads it, changes it, or
 * has the director settle it from the book itself.
 */
import { useEffect, useState } from 'react'
import { mergeAvoid, pictureSize, resolveArtStyle, splitAvoid, type ArtSource, type PictureKind } from '../shared/art'
import { Button, Chip, Field, SectionTitle, TextArea, TextInput, useAction, useProject, useRunningJob, useSnapshot, useStudio, useT } from './ui'

const SOURCE: Record<ArtSource, [string, string]> = {
  book: ['这本书自己的', 'This book\'s own'],
  studio: ['沿用以前的全局设置', 'Carried over from the old Studio-wide setting'],
  default: ['内置的起点', 'The built-in starting point'],
}

export function ArtPage() {
  const { controller } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const studio = useSnapshot(snapshot => snapshot.settings?.settings.image)
  const settings = useSnapshot(snapshot => snapshot.settings)
  useEffect(() => { if (settings === undefined) void controller.loadSettings().catch(() => {}) }, [controller, settings])
  const manifest = project.manifest
  const resolved = resolveArtStyle(manifest, studio?.stylePrompt)
  const bookAvoid = (manifest.artAvoid ?? []).join(t('、', ', '))
  const legacyAvoid = splitAvoid(studio?.negativePrompt)
  const [style, setStyle] = useState(resolved.text)
  const [avoid, setAvoid] = useState(bookAvoid)
  const [ask, setAsk] = useState('')
  const { busy, run } = useAction()
  const asking = useAction()
  const deriving = useRunningJob(job => job.kind === 'bible' && job.title === 'art direction') !== undefined
  useEffect(() => { setStyle(resolved.text) }, [resolved.text])
  useEffect(() => { setAvoid(bookAvoid) }, [bookAvoid])
  const dirty = style.trim() !== resolved.text || splitAvoid(avoid).join('\n') !== (manifest.artAvoid ?? []).join('\n')
  const save = (): Promise<unknown> => run(async () => {
    await controller.api.call('project.update', { root, patch: { artStyle: style.trim(), artAvoid: splitAvoid(avoid) } })
    await controller.refreshProject()
    controller.toast('success', t('画风已保存到这本书里。之后画的每一张图都按它来。', 'The look is saved in this book. Every picture drawn from now on follows it.'))
  })
  const derive = (): Promise<unknown> => asking.run(async () => {
    await controller.api.call('ai.artDirection', { root, ...(ask.trim().length > 0 ? { direction: ask.trim() } : {}) })
    await controller.refreshJobs()
    setAsk('')
    controller.toast('info', t('导演正在读这本书来定画风；定好后会直接写在这一页上，并记进改动记录。', 'The director is reading the book to settle its look; the result is written onto this page and into the record of changes.'))
  })
  const everything = mergeAvoid(legacyAvoid, manifest.artAvoid)
  // Whose look is already written down: a changed art direction does not reach these by itself.
  const anchored = project.characters.filter(card => (card.visual?.prompt ?? '').trim().length > 0)
  const looked = project.world.filter(entry => (entry.visualPrompt ?? '').trim().length > 0)
  const kinds: [PictureKind, [string, string]][] = [['cover', ['封面', 'cover']], ['portrait', ['立绘', 'portraits']], ['sheet', ['人设图', 'design sheets']], ['location', ['地点', 'places']], ['scene', ['章节插图', 'scenes']], ['panel', ['分镜', 'panels']]]
  return (
    <div className="nv-art-page">
      <section className="nv-card">
        <SectionTitle actions={<Chip tone={resolved.source === 'book' ? 'green' : 'amber'}>{t(...SOURCE[resolved.source])}</Chip>}>{t('这本书的画风', 'The look of this book\'s pictures')}</SectionTitle>
        <p className="nv-muted nv-small">{t('封面、人物立绘、人设图、地点设定图、章节插图、有声漫的分镜——这本书的每一张图都带着下面这段话，所以它们看得出是同一本书。', 'Cover, portraits, design sheets, places, chapter scenes, the panels of the motion comic — every picture of this book carries the words below, which is why they are recognisably of one book.')}</p>
        <Field
          label={t('画风', 'Art direction')}
          hint={resolved.source === 'book'
            ? t('原样接在每张图的画面内容后面。写“怎么画”：画种、线条、用色、光线、质感。也可以定下年代和形制（比如“服饰、建筑是明制”）——导演写人物的视觉锚点、地点和物品的样子时以它为准，哪怕原文写的是另一种。', 'Appended as it is to the subject of every picture. Say how to paint: medium, line, palette, light, texture. It may also fix a period and its forms ("dress and buildings of the Ming") — the director then writes every visual anchor and every look of a place or a thing in that form, also where the source text has another.')
            : resolved.source === 'studio'
              ? t('这本书还没有自己的画风，现在显示的是以前填在全局设置里的那一段。改成这本书要的样子再保存，或者让导演按这本书来定。', 'This book has no look of its own yet; what you see was once entered in the Studio-wide settings. Change it to what this book wants and save, or have the director settle it from the book.')
              : t('这本书还没有自己的画风，现在显示的是内置的起点。让导演按这本书来定，或者自己写。', 'This book has no look of its own yet; what you see is the built-in starting point. Have the director settle it from the book, or write your own.')}
        >
          <TextArea value={style} minRows={3} onChange={(event) => { setStyle(event.target.value) }} />
        </Field>
        <Field label={t('任何一张图里都不要出现', 'Never in any picture')} hint={t('逗号分隔。作为负面提示词随每一张图发送，写画面描述的导演也会绕开它们——比如书里的“教会”不是现实里的教堂，就写：十字架、哥特式教堂、彩绘玻璃。', 'Comma-separated. Sent as the negative prompt with every picture, and the director who writes picture descriptions steers round them — if the "church" of the book is no real-world church, write: crosses, gothic cathedral, stained glass.')}>
          <TextInput value={avoid} placeholder={t('如：现代服饰、电线杆、十字架', 'e.g. modern clothing, telegraph poles, crosses')} onChange={(event) => { setAvoid(event.target.value) }} />
        </Field>
        {legacyAvoid.length > 0 ? <p className="nv-muted nv-small">{t(`以前的全局设置里对所有书另有一份“不要出现”：${legacyAvoid.join('、')}（仍然生效；可以在工坊设置的“图像”里清掉）。`, `The old Studio-wide setting adds for every book: ${legacyAvoid.join(', ')} (still in force; it can be cleared under Images in the Studio's settings).`)}</p> : null}
        <div className="nv-form-actions">
          <Button variant="primary" busy={busy} disabled={!dirty && resolved.source === 'book'} onClick={save}>{resolved.source === 'book' ? t('保存', 'Save') : t('定为这本书的画风', 'Make it this book\'s look')}</Button>
        </div>
        {anchored.length + looked.length > 0 ? (
          <details className="nv-art-written">
            <summary>{t(`已经写下的形象不会自己跟着画风变：${anchored.length} 个人的视觉锚点、${looked.length} 处的“样子”`, `Looks already written do not follow a changed art direction by themselves: ${anchored.length} visual anchors, ${looked.length} looks of places and things`)}</summary>
            <p className="nv-muted nv-small">{t('画风接在提示词最后，压不过形象里写明的东西：锚点里写着辫子，画出来就是辫子。所以在这里改了年代、形制之后，要让导演把受影响的形象重写一遍——点名字过去，在“形象”里点“让导演重写”（地点、物品是“样子”旁边的“让导演重写”），它会照现在的画风写，不冲突的地方保留；然后重画人设图 / 设定图。你手改过的形象，不点就不会被动。', 'The art direction comes last in a prompt and cannot overrule what a look says outright: an anchor that says "a queue" is drawn with a queue. So after changing a period or a form here, have the director write the looks it touches again — follow a name, press "Have the director rewrite" under Looks (for a place or a thing, beside its look): it writes in the form the art direction has now and keeps what does not conflict; then draw the sheet or the design art again. A look you wrote by hand is not touched unless you press it.')}</p>
            <div className="nv-chips">
              {anchored.map(card => <Chip key={card.id} onClick={() => { controller.openCharacter(card.id) }} title={card.visual?.prompt}>{card.name}</Chip>)}
              {looked.map(entry => <Chip key={entry.id} tone="blue" onClick={() => { controller.openWorld(entry.id) }} title={entry.visualPrompt}>{entry.name}</Chip>)}
            </div>
          </details>
        ) : null}
      </section>

      <section className="nv-card">
        <SectionTitle>{t('让导演来定', 'Have the director settle it')}</SectionTitle>
        <p className="nv-muted nv-small">{t('导演会读这本书——题材、时代与地点、文字的气质、主要人物和标志性的地方——给出一份只属于它的画风和“不要出现”清单，并说明为什么。导入书稿、起草设定的时候已经自动做过一遍；想换个方向就在这里再做。', 'The director reads the book — its genre, its period and place, the temper of its prose, its leads and its places — and writes a look that is this book\'s alone, with what to keep out, and why. This is done once by itself when a manuscript is imported or a bible is drafted; do it again here to go another way.')}</p>
        <div className="nv-assist">
          <TextInput value={ask} placeholder={t('想要什么方向？（可不填）例如：工笔淡彩，不要日系', 'Which way? (optional) e.g. fine-line with light colour, nothing anime')} onChange={(event) => { setAsk(event.target.value) }} />
          <Button icon="sparkles" busy={asking.busy || deriving} pending={deriving ? t('导演在定…', 'The director is at it…') : t('正在开始…', 'Starting…')} disabled={dirty} title={dirty ? t('先保存或撤掉上面的修改', 'Save or undo your edits above first') : undefined} onClick={() => { void derive() }}>{resolved.source === 'book' ? t('重新定一版', 'Settle it anew') : t('按这本书来定', 'Settle it from the book')}</Button>
        </div>
      </section>

      <section className="nv-card">
        <SectionTitle>{t('一张图的提示词由什么组成', 'What the prompt of a picture is made of')}</SectionTitle>
        <ol className="nv-plain-list nv-small">
          <li>{t('画面内容：导演按这一张要画的东西写的描述（人物用各自人物卡上的“视觉锚点”，地点用设定里它的样子）。', 'The subject: what the director writes for this one picture (people by the visual anchor on their card, a place by how the bible says it looks).')}</li>
          <li>{t('画风：上面那一段，原样附上。', 'The look: the words above, as they are.')} <em>{resolved.text}</em></li>
          <li>{t('不要出现：', 'Kept out: ')}{everything.length > 0 ? everything.join(t('、', ', ')) : t('（没有）', '(nothing)')}{t('，加上画面里各个人物自己的“不要出现”。', ', and what each person in the picture has on their own list.')}</li>
          <li>{t('参考图：画面里人物的人设图、地点的设定图。', 'References: the design sheets of the people in it, the art of its place.')}</li>
        </ol>
        <p className="nv-muted nv-small">{t('尺寸与比例在工坊设置的“图像”里（对所有书）：', 'Sizes and shapes are under Images in the Studio\'s settings (for every book): ')}{kinds.map(([kind, label]) => `${t(...label)} ${pictureSize(studio, kind).replace('x', '×')}`).join(t('，', ', '))}。 <button type="button" className="nv-link" onClick={() => { controller.openSettings('image') }}>{t('去改', 'Change them')}</button></p>
      </section>
    </div>
  )
}
