// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The recommendations (`recommended.json`) as the author meets them.
 *
 * Which models a service is best used with is published with every update of
 * the plugin, as an issue with a number and a date. An author who follows has
 * the settings that were a recommendation moved to the new one — and is told,
 * here, what moved, with a way to take it back. An author who does not follow
 * is told what the issue would change, and decides.
 *
 *   RecommendedNotice   the notice at the top of the Studio, until it is settled
 *   RecommendedCard     the issue in force and the switch to follow it, on the settings page
 */
import type { RecommendedView } from '../shared/rpc'
import type { RecommendedChange } from '../shared/types'
import { Icon } from './icons'
import { Button, useAction, useSnapshot, useStudio, useT, type Translate } from './ui'

const KEY_LABELS: Record<string, [string, string]> = {
  'image.model': ['插图模型', 'image model'],
  'tts.model': ['配音模型', 'speech model'],
  'tts.narratorVoice': ['旁白音色', 'narrator\'s voice'],
  'embedding.model': ['检索模型', 'retrieval model'],
}

const changeText = (change: RecommendedChange, t: Translate): string => `${t(...(KEY_LABELS[change.key] ?? [change.key, change.key]))} ${change.from} → ${change.to}`

/** What an issue changed or would change, and what the author can do about it. */
function NoticeBody({ view }: { view: RecommendedView }) {
  const { controller } = useStudio()
  const t = useT()
  const settle = useAction()
  const notice = view.notice
  if (notice === undefined) return null
  const pending = notice.pending === true
  const list = notice.changes.map(change => changeText(change, t)).join(t('；', '; '))
  const act = (action: 'adopt' | 'keep' | 'revert' | 'dismiss', done: string): void => {
    void settle.run(async () => {
      await controller.settleRecommended(action)
      if (done.length > 0) controller.toast('success', done)
    })
  }
  return (
    <>
      <span>
        <Icon name="sparkles" size={14} />
        <b>{pending ? t(`推荐配置出了第 ${notice.version} 版`, `Issue ${notice.version} of the recommended setup is out`) : t(`已按第 ${notice.version} 版推荐配置更新`, `Updated to issue ${notice.version} of the recommended setup`)}</b>
        {notice.date.length > 0 ? `（${notice.date}）` : ''}
        {pending
          ? t(`——${list}。你没有跟随更新，没有改。`, ` — ${list}. You are not following, so nothing changed.`)
          : t(`——${list}。你自己选的没有动。`, ` — ${list}. What you chose yourself was left alone.`)}
      </span>
      {pending ? (
        <>
          <Button size="sm" variant="primary" busy={settle.busy} pending={t('正在更新…', 'Updating…')} onClick={() => { act('adopt', t('已按新的推荐更新', 'Updated as recommended')) }}>{t('采用', 'Adopt')}</Button>
          <Button size="sm" variant="ghost" disabled={settle.busy} onClick={() => { act('keep', t('保持现在的设置；这几项以后不再跟随推荐', 'Kept as it is; these settings no longer follow the recommendations')) }} title={t('保持现在的值，以后不再问', 'Keep these as they are and do not ask again')}>{t('保持现在的', 'Keep mine')}</Button>
        </>
      ) : (
        <>
          <Button size="sm" variant="ghost" disabled={settle.busy} onClick={() => { act('dismiss', '') }}>{t('知道了', 'Got it')}</Button>
          <Button size="sm" variant="ghost" busy={settle.busy} pending={t('正在改回…', 'Taking it back…')} onClick={() => { act('revert', t('已改回原来的设置；这几项以后不再跟随推荐', 'Taken back; these settings no longer follow the recommendations')) }} title={t('换回更新前的值，以后不再动', 'Back to what they were, and leave them alone from now on')}>{t('改回去', 'Take it back')}</Button>
        </>
      )}
    </>
  )
}

/** At the top of the Studio: an issue changed something, or would — said until the author has settled it. */
export function RecommendedNotice() {
  const { controller } = useStudio()
  const t = useT()
  const view = useSnapshot(snapshot => snapshot.settings?.recommended)
  // The settings page says it itself, where the switch is.
  const onSettings = useSnapshot(snapshot => snapshot.view === 'settings')
  if (view?.notice === undefined || onSettings) return null
  return (
    <div className="nv-banner nv-stale nv-recommended-notice" role="status">
      <NoticeBody view={view} />
      <Button size="sm" variant="ghost" icon="settings" onClick={() => { controller.openSettings('recommended') }}>{t('看设置', 'Settings')}</Button>
    </div>
  )
}

/** On the settings page: which issue is in force, what it says, and whether the settings follow the next one. */
export function RecommendedCard({ view }: { view: RecommendedView | undefined }) {
  const { controller } = useStudio()
  const t = useT()
  const toggle = useAction()
  // A Host from before the recommendations were a file says nothing about them.
  if (view === undefined) return null
  const note = t(view.notes?.zh ?? '', view.notes?.en ?? view.notes?.zh ?? '')
  return (
    <div className="nv-recommended" data-section="recommended">
      <div className="nv-recommended-head">
        <span>
          <Icon name="sparkles" size={13} />
          <b>{t(`推荐配置 第 ${view.version} 版`, `Recommended setup, issue ${view.version}`)}</b>
          {view.date.length > 0 ? <span className="nv-muted"> · {view.date}</span> : null}
        </span>
        <label className="nv-check" title={t('跟随：推荐换了模型时，仍是推荐值的设置跟着换；你自己选的不动', 'Follow: when a recommendation changes, settings still at the recommended value change with it; your own choices stay')}>
          <input
            type="checkbox"
            checked={view.follow}
            disabled={toggle.busy}
            onChange={(event) => {
              const follow = event.target.checked
              void toggle.run(async () => {
                await controller.saveSettings({ recommended: { follow } })
                controller.toast('success', follow ? t('以后跟随推荐配置更新', 'The settings follow the recommendations from now on') : t('以后不跟随：有新的推荐时只提示，不改设置', 'Not following: a new issue is only announced, nothing is changed'))
              })
            }}
          />
          <span>{t('跟随推荐配置更新', 'Follow updates')}</span>
        </label>
      </div>
      {note.length > 0 ? <p className="nv-muted nv-small">{note}</p> : null}
      {view.notice !== undefined ? <div className="nv-banner nv-recommended-inline" role="status"><NoticeBody view={view} /></div> : null}
    </div>
  )
}
