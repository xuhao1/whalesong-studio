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
          ? t(`——它会把：${list}。你没有跟随更新，所以什么都没有改。`, ` — it would change: ${list}. You do not follow updates, so nothing was changed.`)
          : t(`——${list}。只换了原先就是推荐值的设置，你自己选的没有动；已经生成的插图和配音不受影响，之后新生成的用新模型。`, ` — ${list}. Only settings that were a recommendation moved; what you chose yourself was left alone. Pictures and audio already made are untouched; what is made from now on uses the new models.`)}
      </span>
      {pending ? (
        <>
          <Button size="sm" variant="primary" busy={settle.busy} pending={t('正在更新…', 'Updating…')} onClick={() => { act('adopt', t('已按新的推荐更新', 'Updated as recommended')) }}>{t('采用', 'Adopt')}</Button>
          <Button size="sm" variant="ghost" disabled={settle.busy} onClick={() => { act('keep', t('保持现在的设置；这几项以后不再跟随推荐', 'Kept as it is; these settings no longer follow the recommendations')) }} title={t('这几项保持现在的值，算作你自己的选择：以后的推荐更新不会再问', 'These settings stay as they are and count as your own choice: later issues will not ask again')}>{t('保持现在的', 'Keep mine')}</Button>
        </>
      ) : (
        <>
          <Button size="sm" variant="ghost" disabled={settle.busy} onClick={() => { act('dismiss', '') }}>{t('知道了', 'Got it')}</Button>
          <Button size="sm" variant="ghost" busy={settle.busy} pending={t('正在改回…', 'Taking it back…')} onClick={() => { act('revert', t('已改回原来的设置；这几项以后不再跟随推荐', 'Taken back; these settings no longer follow the recommendations')) }} title={t('换回更新前的值，并算作你自己的选择：以后的推荐更新不会再动它们', 'Back to what they were, and counted as your own choice: later issues will leave them alone')}>{t('改回去', 'Take it back')}</Button>
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
        <label className="nv-check" title={t('推荐配置随插件的每次更新一起发布。跟随：原先就是推荐值的模型换成新的推荐，并告诉你换了什么（可以改回去）；你自己选的模型不会被动。不跟随：只告诉你新的推荐是什么，什么都不改。', 'The recommendations are published with every update of the plugin. Following: a model that was a recommendation moves to the new one, and you are told what moved (and can take it back); a model you chose yourself is left alone. Not following: you are told what the new issue recommends, and nothing is changed.')}>
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
      <p className="nv-muted nv-small">
        {t('各家服务用哪个模型、下拉里的候选、常见模型的上下文窗口，都来自随插件发布的 recommended.json，不写在代码里。', 'Which model each service is used with, what is offered beside the fields and the context windows of the usual models all come from recommended.json, published with the plugin — none of it is fixed in the code.')}
        {note.length > 0 ? ` ${note}` : ''}
      </p>
      {view.notice !== undefined ? <div className="nv-banner nv-recommended-inline" role="status"><NoticeBody view={view} /></div> : null}
    </div>
  )
}
