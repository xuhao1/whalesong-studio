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
    controller.toast('success', t('画风已保存', 'Art direction saved'))
  })
  const derive = (): Promise<unknown> => asking.run(async () => {
    await controller.api.call('ai.artDirection', { root, ...(ask.trim().length > 0 ? { direction: ask.trim() } : {}) })
    await controller.refreshJobs()
    setAsk('')
    controller.toast('info', t('导演正在定画风…', 'The director is settling the art direction…'))
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
        <p className="nv-muted nv-small">{t('这本书的每一张图都带着这段话。', 'Every picture of this book carries these words.')}</p>
        <Field
          label={t('画风', 'Art direction')}
          hint={resolved.source === 'book'
            ? t('接在每张图的提示词后面。可以定年代和形制（如“明制”），人物和地点的样子以它为准。', 'Appended to every picture\'s prompt. It may fix a period and its forms ("Ming dress"); the looks of people and places then follow it.')
            : resolved.source === 'studio'
              ? t('这本书还没有自己的画风，这是以前全局设置里的那段。', 'This book has no art direction of its own; this is the one from the old global settings.')
              : t('这本书还没有自己的画风，这是内置的起点。', 'This book has no art direction of its own; this is the built-in start.')}
        >
          <TextArea value={style} minRows={3} onChange={(event) => { setStyle(event.target.value) }} />
        </Field>
        <Field label={t('任何一张图里都不要出现', 'Never in any picture')} hint={t('逗号分隔，作为负面提示词随每张图发送。', 'Comma-separated; sent with every picture as its negative prompt.')}>
          <TextInput value={avoid} placeholder={t('如：现代服饰、电线杆、十字架', 'e.g. modern clothing, telegraph poles, crosses')} onChange={(event) => { setAvoid(event.target.value) }} />
        </Field>
        {legacyAvoid.length > 0 ? <p className="nv-muted nv-small">{t(`全局设置里还有一份仍在生效：${legacyAvoid.join('、')}。`, `The global settings still add: ${legacyAvoid.join(', ')}.`)}</p> : null}
        <div className="nv-form-actions">
          <Button variant="primary" busy={busy} disabled={!dirty && resolved.source === 'book'} onClick={save}>{resolved.source === 'book' ? t('保存', 'Save') : t('定为这本书的画风', 'Make it this book\'s look')}</Button>
        </div>
        {anchored.length + looked.length > 0 ? (
          <details className="nv-art-written">
            <summary>{t(`已写下的形象不会跟着变：${anchored.length} 人、${looked.length} 处`, `Looks already written do not follow: ${anchored.length} people, ${looked.length} places and things`)}</summary>
            <p className="nv-muted nv-small">{t('改了年代、形制之后，点名字过去让导演重写，再重画。', 'After changing a period or its forms, open each one, have the director rewrite it, and redraw.')}</p>
            <div className="nv-chips">
              {anchored.map(card => <Chip key={card.id} onClick={() => { controller.openCharacter(card.id) }} title={card.visual?.prompt}>{card.name}</Chip>)}
              {looked.map(entry => <Chip key={entry.id} tone="blue" onClick={() => { controller.openWorld(entry.id) }} title={entry.visualPrompt}>{entry.name}</Chip>)}
            </div>
          </details>
        ) : null}
      </section>

      <section className="nv-card">
        <SectionTitle>{t('让导演来定', 'Have the director settle it')}</SectionTitle>
        <p className="nv-muted nv-small">{t('导演读这本书，给出画风和“不要出现”清单。', 'The director reads the book and gives an art direction and a list to keep out.')}</p>
        <div className="nv-assist">
          <TextInput value={ask} placeholder={t('想要的方向，如：工笔淡彩，不要日系', 'A direction, e.g. fine-line ink with light colour, nothing anime')} onChange={(event) => { setAsk(event.target.value) }} />
          <Button icon="sparkles" busy={asking.busy || deriving} pending={deriving ? t('导演在定…', 'The director is at it…') : t('正在开始…', 'Starting…')} disabled={dirty} title={dirty ? t('先保存或撤掉上面的修改', 'Save or undo your edits above first') : undefined} onClick={() => { void derive() }}>{resolved.source === 'book' ? t('重新定一版', 'Settle it anew') : t('按这本书来定', 'Settle it from the book')}</Button>
        </div>
      </section>

      <section className="nv-card">
        <p className="nv-muted nv-small">{t('尺寸与比例在工坊设置的“图像”里（对所有书）：', 'Sizes and shapes are under Images in the Studio\'s settings (for every book): ')}{kinds.map(([kind, label]) => `${t(...label)} ${pictureSize(studio, kind).replace('x', '×')}`).join(t('，', ', '))}。 <button type="button" className="nv-link" onClick={() => { controller.openSettings('image') }}>{t('去改', 'Change them')}</button></p>
      </section>
    </div>
  )
}
