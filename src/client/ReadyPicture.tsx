// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * A picture there already, put where one would be drawn.
 *
 * Beside every button that draws for a place of its own — somebody's
 * portrait or design sheet (a look's, a stretch's, a moment's), the design
 * art of a place, a house or a thing (or of one turn of its course), the
 * cover — one button for the picture that need not be drawn: chosen among the
 * book's pictures, whatever they were drawn or brought in as, or brought in
 * from the author's computer in the same dialog. Either way it hangs where
 * one drawn there would.
 *
 * This is the author's to do, here: the showrunner has no tool for it.
 */
import { useState } from 'react'
import { hungAt } from '../shared/hung'
import type { IllustrationInfo } from '../shared/types'
import type { BroughtKind, BroughtOf } from './ImportPicture'
import { hungWords } from './PictureUse'
import { PickPicture } from './PlacePicture'
import { Button, useAction, useConfirm, useProject, useSnapshot, useStudio, useT } from './ui'

/**
 * @param kind - what the picture is to be there: a portrait, a design sheet, design art, the cover.
 * @param of - whose, and which of theirs — as for a picture brought in.
 * @param label - said on the button; left out, the button is its icon alone.
 * @param onDone - the picture that hangs there now.
 */
export function ReadyPicture({ kind, of = {}, disabled, label, variant = 'ghost', onDone }: { kind: Exclude<BroughtKind, 'picture'>; of?: BroughtOf; disabled?: boolean; label?: string; variant?: 'ghost' | 'outline' | 'primary'; onDone?: (path: string, image: IllustrationInfo) => void }) {
  const { controller } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const stale = useSnapshot(snapshot => snapshot.hostStale) === true
  const [open, setOpen] = useState(false)
  const { busy, run } = useAction()
  const confirm = useConfirm()
  const what = kind === 'sheet' ? t('人设图', 'design sheet') : kind === 'portrait' ? t('立绘', 'portrait') : kind === 'cover' ? t('封面', 'cover') : of.event !== undefined ? t('这时的样子', 'picture of it as it is then') : t('设定图', 'design art')
  const said = t(`用一张现成的图当${what}：从本书的图里选，或从电脑导入`, `A picture there already as the ${what}: chosen among the book's, or brought in from this computer`)
  // One of a look's, a stretch's, a turn's: a Host half from before it knew those would hang the picture as the main one.
  const fine = of.look !== undefined || of.stage !== undefined || of.event !== undefined
  const use = (image: IllustrationInfo): Promise<unknown> => run(async () => {
    if (kind === 'cover') {
      await controller.api.call('project.update', { root, patch: { cover: image.path } })
      await controller.refreshProject()
      controller.toast('success', t('封面换成了这张', 'The cover is this picture now'))
    } else {
      const target = kind === 'art' ? of.entry : of.character
      if (target === undefined) return
      const done = await controller.api.call('image.use', {
        root,
        picture: image.path,
        as: kind,
        target,
        ...(kind === 'portrait' && of.scene !== undefined ? { scene: of.scene } : {}),
        ...(kind === 'sheet' && of.look !== undefined ? { look: of.look } : {}),
        ...(of.stage !== undefined ? { stage: of.stage } : {}),
        ...(kind === 'art' && of.event !== undefined ? { event: of.event } : {}),
      })
      await controller.refreshProject()
      const from = done.released.length > 0 ? t(`；原来挂在 ${[...new Set(done.released)].join('、')} 那里，已取下`, `; taken down from ${[...new Set(done.released)].join(', ')}`) : ''
      controller.toast('success', done.spare === true
        ? t(`放进来了，先不启用：主${what}是你选定的那张。要用它，点它再设为主${what}${from}`, `It is one of them now, not in use: the main ${what} is the one you chose. To use this one, open it and make it the main one${from}`)
        : t(`这张现在是这里的${what}${from}`, `It is the ${what} here now${from}`))
    }
    setOpen(false)
    onDone?.(image.path, image)
  }).catch((reason: unknown) => { controller.toast('error', reason instanceof Error ? reason.message : String(reason)) })
  const pick = (image: IllustrationInfo, brought?: boolean): void => {
    // Brought in just now: it came in as what is wanted here, and hangs there already.
    if (brought === true) {
      setOpen(false)
      onDone?.(image.path, image)
      return
    }
    // (The cover is a picture shown, whoever's it is: nothing is taken down for it.)
    const hung = kind === 'cover' ? [] : hungAt(project.characters, project.world, image.path, image)
    if (hung.length > 0) confirm.ask(t(`这张图现在是${hung.map(item => hungWords(item, t)).join('、')}。用在这里，它就从那里取下（正文、分镜里用着它的地方不动）。`, `This picture is ${hung.map(item => hungWords(item, t)).join(', ')} now. Used here, it is taken down from there (where a text or a storyboard shows it stays as it is).`), () => { void use(image) })
    else void use(image)
  }
  return (
    <>
      <Button size="sm" variant={variant} icon="image" busy={busy} disabled={disabled === true} title={said} aria-label={said} onClick={() => {
        if (fine && stale) controller.toast('error', t('后台还是旧版本：先点顶上的“重启”，再从现成的图里选', 'The Host half is an older build: press Restart at the top first'))
        else setOpen(true)
      }}>{label}</Button>
      {open ? <PickPicture title={t(`选一张现成的图当${what}`, `Choose a picture for the ${what}`)} {...(of.chapter !== undefined ? { chapter: of.chapter } : {})} bring={{ kind, of }} onPick={pick} onClose={() => { setOpen(false) }} /> : null}
      {confirm.element}
    </>
  )
}
