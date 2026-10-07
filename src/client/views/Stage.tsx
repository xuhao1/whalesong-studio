// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The stage: what the manuscript becomes besides a book to read and to listen
 * to — a motion comic, playable interludes, and the pictures. (The audio drama
 * is the reader's listening mode.)
 */
import { useEffect, useState } from 'react'
import { ComicStage } from '../stage/Comic'
import { Gallery } from '../stage/Gallery'
import { PlayStage } from '../stage/Play'
import type { StageTab } from '../store'
import { Button, Select, Tabs, useProject, useSnapshot, useStudio, useT } from '../ui'

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
  const written = project.chapters.filter(chapter => chapter.hasText)
  const chapter = written.find(candidate => candidate.id === chapterId) ?? written.at(-1)
  return (
    <div className="nv-page nv-stage">
      <div className="nv-toolbar">
        <Tabs value={tab} onChange={setTab} tabs={[
          { value: 'comic', label: t('有声漫', 'Motion comic'), icon: 'film' },
          { value: 'play', label: t('幕间', 'Interludes'), icon: 'gamepad' },
          { value: 'gallery', label: t('插图', 'Illustrations'), icon: 'image' },
        ]} />
        <Button size="sm" variant="ghost" icon="headphones" onClick={() => { controller.openReader('listen', chapter?.id) }} title={t('有声剧在"阅读"页的"听"模式里', 'The audio drama is the reader\'s listening mode')}>{t('有声剧', 'Audio drama')}</Button>
        <span className="nv-spacer" />
        {tab === 'comic' && chapter !== undefined ? (
          <Select className="nv-chapter-select" value={chapter.id} options={written.map(item => ({ value: item.id, label: `${item.index}. ${item.title}` }))} onChange={(value) => { controller.focusChapter(value) }} />
        ) : null}
      </div>
      {tab === 'comic' ? <ComicStage key={chapter?.id ?? 'none'} chapter={chapter} /> : null}
      {tab === 'play' ? <PlayStage /> : null}
      {tab === 'gallery' ? <Gallery /> : null}
    </div>
  )
}
