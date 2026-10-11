// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Pictures to steer by.
 *
 * A few pictures the author gives to a stretch of plot being planned or a
 * chapter being written — or to one picture being drawn, a design sheet or
 * the design art of a thing: chosen among the pictures the book already has,
 * or brought in from the computer; each may have a word said of it. One
 * control wherever pictures are given — beside the planner's direction,
 * beside the writer's brief, beside the button that draws.
 */
import { useCallback, useRef, useState } from 'react'
import type { PictureGuide, PicturesRead, ReferencesLooked } from '../shared/types'
import { encoded } from './ImportPicture'
import { PickPicture } from './PlacePicture'
import { Button, Chip, cx, Modal, plainEnter, ProjectImage, TextInput, useProject, useStudio, useT } from './ui'

/** Somebody whose design sheet can be given to the drawing of another person's: one of their family is drawn by it. */
export interface SheetLender {
  name: string
  /** The sheet that is theirs now. */
  sheet: string
  /** What the cards say they are to whoever is drawn ("姐妹", "father"). */
  tie?: string
  /** Every picture kept of them: one of these among the pictures given is theirs, whichever way it was chosen. */
  pictures: readonly string[]
}

/** The most one piece of work is given; the Host holds to the same. */
const MOST = 12

/**
 * The pictures given to the drawing of one thing — somebody's design sheet, the art of a place or a thing — by what
 * they are given to. Kept while the Studio is open: they are for every picture of it drawn from its page until taken
 * off again, and a look at another card and back does not lose them. (Each picture drawn keeps on its record which
 * ones went with it.)
 */
const givenTo = new Map<string, PictureGuide[]>()
const NONE: PictureGuide[] = []

/**
 * The pictures given to the drawing of one thing, and the way to say which.
 * @param key - what they are given to: the book, and whose picture.
 */
export function useGiven(key: string): [PictureGuide[], (next: PictureGuide[]) => void] {
  const [, changed] = useState(0)
  const set = useCallback((next: PictureGuide[]): void => {
    if (next.length > 0) givenTo.set(key, next)
    else givenTo.delete(key)
    changed(count => count + 1)
  }, [key])
  return [givenTo.get(key) ?? NONE, set]
}

/**
 * The pictures given to a piece of work, and the ways to add one.
 * @param chapter - the chapter in hand, whose own pictures the chooser lists first.
 * @param label - what they are called here, where "pictures to go by" does not say whose they are.
 * @param ask - what the field beside each picture asks for, where it is not a moment of the plot.
 * @param people - where the pictures are for somebody's design sheet: the others who have one, any of which can be
 *   given — a parent's, a sister's — for the likeness of family.
 * @param first - the number the first of them has in the prompt, where another picture goes before them (the picture
 *   to change is 1, and these follow from 2).
 */
export function GuidePictures({ value, onChange, disabled, chapter, hint, label, ask, people, first = 1 }: { value: readonly PictureGuide[]; onChange: (next: PictureGuide[]) => void; disabled?: boolean; chapter?: string | undefined; hint?: string; label?: string; ask?: string; people?: readonly SheetLender[]; first?: number }) {
  const { controller } = useStudio()
  const t = useT()
  const { root } = useProject()
  const [picking, setPicking] = useState(false)
  const [lending, setLending] = useState(false)
  /** Whose picture one of them is, where it is somebody else's. */
  const whose = (path: string): SheetLender | undefined => people?.find(person => person.pictures.includes(path))
  const [bringing, setBringing] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const full = value.length >= MOST
  const add = (path: string): void => { if (!value.some(guide => guide.path === path)) onChange([...value, { path }].slice(0, MOST)) }
  const bring = (files: FileList | null): void => {
    const chosen = [...(files ?? [])].filter(file => file.type.startsWith('image/')).slice(0, MOST - value.length)
    if (chosen.length === 0) return
    setBringing(true)
    void controller.guard(async () => {
      let next = [...value]
      for (const file of chosen) {
        const { path } = await controller.api.call('guide.add', { root, ...(await encoded(file)) })
        if (!next.some(guide => guide.path === path)) next = [...next, { path }]
      }
      onChange(next.slice(0, MOST))
    }).finally(() => {
      setBringing(false)
      if (input.current !== null) input.current.value = ''
    })
  }
  return (
    <div className={cx('nv-guides', disabled === true && 'is-off')}>
      <div className="nv-guides-head">
        <span className="nv-guides-label">{label ?? t('参考图', 'Pictures to go by')}{value.length > 0 ? ` · ${value.length}` : ''}</span>
        {people !== undefined ? <Button size="sm" variant="ghost" icon="users" disabled={disabled === true || full || people.length === 0} title={people.length === 0 ? t('还没有别的人有人设图', 'Nobody else has a design sheet yet') : t('照另一个人的人设图画：相貌像一家人——画父母子女、兄弟姐妹', 'By another person\'s design sheet: the likeness of family — for a parent, a child, a sibling')} onClick={() => { setLending(true) }}>{t('照别人的人设图…', 'Somebody else\'s sheet…')}</Button> : null}
        <Button size="sm" variant="ghost" icon="image" disabled={disabled === true || full} onClick={() => { setPicking(true) }}>{t('从本书的图里选…', 'From the book…')}</Button>
        <Button size="sm" variant="ghost" icon="upload" busy={bringing} disabled={disabled === true || full} pending={t('正在带进来…', 'Bringing it in…')} onClick={() => { input.current?.click() }}>{t('从电脑选…', 'From this computer…')}</Button>
        <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden onChange={(event) => { bring(event.target.files) }} />
        {hint !== undefined && value.length > 0 ? <span className="nv-muted nv-small">{hint}</span> : null}
      </div>
      {value.length > 0 ? (
        <div className="nv-guides-list">
          {value.map((guide, at) => (
            <div key={guide.path} className="nv-guide">
              <span className="nv-guide-no">{at + first}</span>
              <ProjectImage path={guide.path} alt="" className="nv-guide-thumb" />
              {whose(guide.path) !== undefined ? <Chip tone="violet" title={t('这是另一个人的图：画的不是他', 'Another person\'s picture: not who is drawn')}>{whose(guide.path)!.name}</Chip> : null}
              <GuideNote note={guide.note ?? ''} disabled={disabled === true} {...(whose(guide.path) !== undefined ? { ask: t(`要它的什么（不填：相貌像${whose(guide.path)!.name}，像一家人；别的照文字）`, `What of it is wanted (left empty: the family likeness of ${whose(guide.path)!.name}; the rest as the words say)`) } : ask !== undefined ? { ask } : {})} onCommit={(note) => { onChange(value.map((item, index) => (index === at ? (note.length > 0 ? { path: item.path, note } : { path: item.path }) : item))) }} />
              <button type="button" className="nv-guide-drop" disabled={disabled === true} title={t('不用这张', 'Leave this one out')} aria-label={t('不用这张', 'Leave this one out')} onClick={() => { onChange(value.filter((_item, index) => index !== at)) }}>×</button>
            </div>
          ))}
        </div>
      ) : null}
      {picking ? <PickPicture {...(chapter !== undefined ? { chapter } : {})} onPick={(image) => { add(image.path); setPicking(false) }} onClose={() => { setPicking(false) }} /> : null}
      {lending && people !== undefined ? (
        <Modal wide title={t('照谁的人设图', 'Whose design sheet')} onClose={() => { setLending(false) }}>
          <p className="nv-muted nv-small">{t('画出来相貌像他、看得出是一家人，不是同一个人；年纪、发式、衣着照这张卡上写的。想要别的，选完在图后面写一句。', 'The likeness of family, not the same person; age, hair and clothing as this card has them. For something else, say so beside the picture once it is chosen.')}</p>
          <div className="nv-gallery-grid nv-pick-grid">
            {people.map(person => (
              <button key={person.sheet} type="button" className="nv-gallery-item" disabled={value.some(guide => guide.path === person.sheet)} onClick={() => { add(person.sheet); setLending(false) }}>
                <ProjectImage path={person.sheet} alt={person.name} />
                <span className="nv-gallery-caption"><span>{person.name}</span>{person.tie !== undefined ? <Chip tone="violet">{person.tie}</Chip> : null}</span>
              </button>
            ))}
          </div>
        </Modal>
      ) : null}
    </div>
  )
}

/** What the author says of one picture: typed freely, handed on when the field is left — where the pictures are kept with a chapter, that is when they are saved. */
function GuideNote({ note, disabled, ask, onCommit }: { note: string; disabled: boolean; ask?: string; onCommit: (note: string) => void }) {
  const t = useT()
  const [text, setText] = useState(note)
  const [held, setHeld] = useState(note)
  // Changed from outside (another picture list loaded): shown as it is now.
  if (held !== note) {
    setHeld(note)
    setText(note)
  }
  const commit = (): void => { if (text.trim() !== note) onCommit(text.trim()) }
  return <TextInput className="nv-guide-note" value={text} disabled={disabled} placeholder={ask ?? t('说一句（可不填）：这是哪一幕、要它的什么', 'A word on it (optional): what it is, what of it matters')} onChange={(event) => { setText(event.target.value) }} onBlur={commit} onKeyDown={(event) => { if (plainEnter(event)) (event.target as HTMLInputElement).blur() }} />
}

/** How the pictures given to a piece of work were read, in a line for whoever gave them. */
export function picturesReadWord(read: PicturesRead | undefined, t: (zh: string, en: string) => string): string | undefined {
  if (read === undefined) return undefined
  if (read.by === 'vision') return t(`${read.count} 张参考图由 ${read.model ?? '看图的模型'} 看成了文字`, `${read.count} picture(s) put into words by ${read.model ?? 'the picture model'}`)
  return read.unsure === true
    ? t(`${read.count} 张参考图发给了模型；它没有声明能不能看图——看不出效果的话，到设置里配一个“看图的模型”`, `${read.count} picture(s) sent to the model, which does not say whether it sees them — if it shows no sign of it, set up a model to look at pictures in the settings`)
    : t(`${read.count} 张参考图，模型自己看的`, `${read.count} picture(s), looked at by the model itself`)
}

/** What a role read in the book's references for work that looks in them first, in a line for the author. */
export function referencesLookedWord(looked: ReferencesLooked | undefined, t: (zh: string, en: string) => string): string | undefined {
  if (looked === undefined) return undefined
  if (looked.cannot !== undefined) return t(`没查参考文献：${looked.cannot}`, `The references were not looked at: ${looked.cannot}`)
  if (looked.calls === 0) return t('该先查参考文献，这次没有去读', 'The references were to be looked at first, and nothing was read in them this time')
  return t(`先查了参考文献：${looked.read.join('；')}`, `Looked in the references first: ${looked.read.join('; ')}`)
}
