// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * A picture of somebody that was made elsewhere, brought in as theirs.
 *
 * Beside the buttons that draw a portrait or a design sheet: the same place
 * taken by a file of the author's own — a picture they drew, had drawn, or
 * made with another tool. It is kept among the book's pictures and hangs where
 * one drawn here would.
 */
import { useRef } from 'react'
import { encoded } from './Guides'
import { Button, useAction, useProject, useStudio, useT } from './ui'

/**
 * @param kind - what it is brought in as.
 * @param of - whose, and which of theirs: a look's sheet, a stretch's picture, the portrait of one of their moments.
 */
export function ImportPicture({ kind, of, disabled, label, onDone }: { kind: 'portrait' | 'sheet'; of: { character: string; look?: string; stage?: string; scene?: string }; disabled?: boolean; /** Said on the button; left out, the button is its icon alone. */ label?: string; onDone?: (path: string) => void }) {
  const { controller } = useStudio()
  const t = useT()
  const { root } = useProject()
  const input = useRef<HTMLInputElement>(null)
  const { busy, run } = useAction()
  const said = kind === 'sheet' ? t('从电脑导入一张人设图', 'Bring in a design sheet from this computer') : t('从电脑导入一张立绘', 'Bring in a portrait from this computer')
  const bring = (files: FileList | null): void => {
    const file = files?.[0]
    if (input.current !== null) input.current.value = ''
    if (file === undefined) return
    void run(async () => {
      // Kept as fine as it came, short of what is too large to send whole.
      const picture = await encoded(file, 12_000_000, 4096)
      const done = await controller.api.call('image.import', { root, kind, target: of.character, ...picture, ...(of.look !== undefined ? { look: of.look } : {}), ...(of.stage !== undefined ? { stage: of.stage } : {}), ...(of.scene !== undefined ? { scene: of.scene } : {}) })
      await controller.refreshProject()
      onDone?.(done.path)
      controller.toast('success', done.spare === true
        ? t('导入了，先不启用：主人设图是你选定的那张。要用它，点它再点“设为主人设图”', 'Brought in, not in use yet: the main sheet is the one you chose. To use this one, open it and make it the main sheet')
        : kind === 'sheet' ? t('人设图导入了', 'Design sheet brought in') : t('立绘导入了', 'Portrait brought in'))
    }).catch((reason: unknown) => { controller.toast('error', reason instanceof Error ? reason.message : String(reason)) })
  }
  return (
    <>
      <Button size="sm" variant="ghost" icon="upload" busy={busy} disabled={disabled === true} title={said} aria-label={said} onClick={() => { input.current?.click() }}>{label}</Button>
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(event) => { bring(event.target.files) }} />
    </>
  )
}
