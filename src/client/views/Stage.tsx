// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The stage: what the manuscript becomes besides a book to read and to listen
 * to — a motion comic, playable interludes, and the pictures. (The audio drama
 * is the reader's listening mode.) Its first tab is the production of the
 * whole book: where every chapter stands, and one button for what is missing.
 */
import { useEffect, useState } from 'react'
import { ProductionBoard } from '../Batch'
import { ComicStage } from '../stage/Comic'
import { Gallery } from '../stage/Gallery'
import { PlayStage } from '../stage/Play'
import type { StageTab } from '../store'
import { Button, Tabs, useProject, useSnapshot, useStudio, useT } from '../ui'

type Tab = Exclude<StageTab, 'audio'>

let lastTab: Tab = 'comic'

export function StageView() {
  const { controller } = useStudio()
  const t = useT()
  const { project } = useProject()
  const chapterId = useSnapshot(snapshot => snapshot.chapterId)
  const asked = useSnapshot(snapshot => snapshot.stageTab)
  const [tab, setTabState] = useState<Tab>(asked !== undefined && asked !== 'audio' ? asked : lastTab)
  const setTab = (next: Tab): void => {
    lastTab = next
    setTabState(next)
    controller.setStageTab(next)
  }
  // A link (the showrunner showing something) may name the tab while the stage is already open.
  useEffect(() => {
    // The audio drama used to be a tab here; whoever still asks for it is taken to where it lives now.
    if (asked === 'audio') {
      controller.setStageTab(tab)
      controller.openReader('listen')
      return
    }
    if (asked !== undefined && asked !== tab) {
      lastTab = asked
      setTabState(asked)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked])
  // Of whichever line: the switch at the chapter's title lists them all.
  const written = [...project.chapters, ...(project.lines ?? []).flatMap(line => line.chapters)].filter(chapter => chapter.hasText)
  const chapter = written.find(candidate => candidate.id === chapterId) ?? project.chapters.filter(candidate => candidate.hasText).at(-1) ?? written.at(-1)
  return (
    <div className="nv-page nv-stage">
      <div className="nv-toolbar">
        <Tabs value={tab} onChange={setTab} tabs={[
          { value: 'production', label: t('一键制作', 'Produce'), icon: 'layers' },
          { value: 'comic', label: t('有声漫', 'Motion comic'), icon: 'film' },
          { value: 'play', label: t('幕间', 'Interludes'), icon: 'gamepad' },
          { value: 'gallery', label: t('插图', 'Illustrations'), icon: 'image' },
        ]} />
        <span className="nv-spacer" />
        <Button
          size="sm"
          variant="ghost"
          icon="eye"
          onClick={() => {
            // The same thing, as whoever reads the book has it: the chapter to watch, the side stories, the text.
            if (tab === 'play') controller.openAlbum({ section: 'sides' })
            else controller.openReader(tab === 'gallery' ? 'read' : 'watch', chapter?.id)
          }}
          title={tab === 'play' ? t('观看：留作番外的幕间在读者那里的样子', 'View: the interludes kept as side stories, as a reader has them') : t('观看：这一章在读者那里的样子', 'View: this chapter as a reader has it')}
        >{t('观看', 'View')}</Button>
        <Button size="sm" variant="ghost" icon="headphones" onClick={() => { controller.openReader('listen', chapter?.id) }} title={t('有声剧在"观看"里：正文的"脚本"版面，点播放就听', 'The audio drama is in the viewer: the script face of the text, with the player under it')}>{t('有声剧', 'Audio drama')}</Button>
      </div>
      {tab === 'production' ? <ProductionBoard onOpen={(id) => { controller.focusChapter(id); setTab('comic') }} /> : null}
      {tab === 'comic' ? <ComicStage key={chapter?.id ?? 'none'} chapter={chapter} /> : null}
      {tab === 'play' ? <PlayStage /> : null}
      {tab === 'gallery' ? <Gallery /> : null}
    </div>
  )
}
