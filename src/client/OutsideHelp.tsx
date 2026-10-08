// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Outside help: a coding agent of the author's own — Claude Code, Codex — that
 * a role of the crew can hand work to when it is beyond it. Each comes as an
 * official DSH plugin, and is installed here with one press, through DSH's own
 * plugin manager: nothing to look up, nothing to type.
 *
 *   OutsideHelp      the two of them, each with Install or Remove — for the settings
 *   HelpPrompt       one line where help would be of use and none is installed
 */
import { useState } from 'react'
import type { HelpPackage, HelpView } from '../shared/rpc'
import { Icon } from './icons'
import { Button, Chip, useAction, useConfirm, useSnapshot, useStudio, useT } from './ui'

const NAMES: Record<HelpPackage['id'], string> = { 'claude-code': 'Claude Code', codex: 'Codex' }

/** Install one, follow it to its end, and say how it went. */
function useInstall(): { installing: HelpPackage['id'] | undefined; install: (id: HelpPackage['id']) => Promise<unknown>; stop: () => void } {
  const { controller } = useStudio()
  const t = useT()
  const [installing, setInstalling] = useState<HelpPackage['id'] | undefined>()
  const [job, setJob] = useState<string | undefined>()
  const install = (id: HelpPackage['id']): Promise<unknown> => controller.guard(async () => {
    setInstalling(id)
    try {
      const started = await controller.api.call('help.install', { id })
      setJob(started.jobId)
      // Followed by its id: an installation is of no book, and is on no book's list of jobs.
      let cursor = 0
      for (;;) {
        const state = await controller.api.call('jobs.read', { id: started.jobId, cursor, waitMs: 15_000 })
        cursor = state.cursor
        if (state.info.status === 'running') continue
        if (state.info.status !== 'done') throw new Error(state.info.error ?? t('没有装上。', 'It was not installed.'))
        const restart = (state.info.result?.output as { restart?: boolean } | undefined)?.restart === true
        controller.toast('success', restart
          ? t(`${NAMES[id]} 外援装好了。重启一次 DSH 后生效。`, `${NAMES[id]} is installed. It answers once DSH has been restarted.`)
          : t(`${NAMES[id]} 外援装好了，后期现在就可以叫它。`, `${NAMES[id]} is installed: post-production can call on it now.`))
        break
      }
      await controller.loadSettings()
    } finally {
      setInstalling(undefined)
      setJob(undefined)
    }
  })
  const stop = (): void => { if (job !== undefined) void controller.cancelJob(job) }
  return { installing, install, stop }
}

export function OutsideHelp({ view }: { view: HelpView }) {
  const { controller } = useStudio()
  const t = useT()
  const { installing, install, stop } = useInstall()
  const removing = useAction()
  const confirm = useConfirm()
  const remove = (entry: HelpPackage): void => {
    confirm.ask(t(`卸载 ${NAMES[entry.id]} 外援（${entry.package}）？之后随时可以再装。`, `Remove the ${NAMES[entry.id]} helper (${entry.package})? It can be installed again at any time.`), () => {
      void removing.run(async () => {
        const result = await controller.api.call('help.remove', { id: entry.id })
        await controller.loadSettings()
        controller.toast('success', result.message ?? t(`已卸载 ${NAMES[entry.id]} 外援。`, `The ${NAMES[entry.id]} helper is removed.`))
      })
    })
  }
  return (
    <div className="nv-help">
      <p className="nv-muted nv-small">{t('后期做不了的活，可以转交给你自己的 Claude Code 或 Codex（用的是你自己的登录和额度）。', 'What post-production cannot do itself it can hand to your own Claude Code or Codex (your own sign-in and allowance).')}</p>
      {view.packages.map(entry => (
        <div key={entry.id} className="nv-help-row">
          <strong>{NAMES[entry.id]}</strong>
          {entry.connected
            ? <Chip tone="green">{t(`已接入${entry.version !== undefined ? ` · ${entry.version}` : ''}`, `connected${entry.version !== undefined ? ` · ${entry.version}` : ''}`)}</Chip>
            : entry.installed
              ? <Chip tone="amber" title={t('插件已经装上，但它还没有应答：重启一次 DSH，或到 DSH 的“设置 → 插件”里看它是否被关掉了', 'The plugin is installed and does not answer yet: restart DSH, or see under DSH\'s Settings → Plugins whether it is switched off')}>{t('已安装，重启 DSH 后生效', 'installed — restart DSH')}</Chip>
              : <Chip>{t('未安装', 'not installed')}</Chip>}
          <span className="nv-spacer" />
          {installing === entry.id ? <Button size="sm" variant="ghost" icon="stop" onClick={stop}>{t('停止', 'Stop')}</Button> : null}
          {!entry.installed
            ? <Button size="sm" variant="primary" icon="download" busy={installing === entry.id} disabled={!view.manage || (installing !== undefined && installing !== entry.id)} pending={t('正在安装…', 'Installing…')} onClick={() => { void install(entry.id) }} title={view.manage ? t(`通过 DSH 的插件管理器安装 ${entry.package}（会下载这个包）`, `Installs ${entry.package} through DSH's plugin manager (the package is downloaded)`) : t('这个 DSH 没有插件管理器：用命令 dsh plugin add 安装', 'This DSH has no plugin manager: install with dsh plugin add')}>{t('安装', 'Install')}</Button>
            : entry.removable
              ? <Button size="sm" variant="ghost" icon="trash" busy={removing.busy} disabled={!view.manage} onClick={() => { remove(entry) }}>{t('卸载', 'Remove')}</Button>
              : null}
        </div>
      ))}
      {!view.manage ? <p className="nv-muted nv-small">{t('这个 DSH 没有插件管理器，装不了：在命令行里运行 dsh plugin add <包名>，再重启 DSH。', 'This DSH has no plugin manager to install with: run dsh plugin add <package> in a shell, then restart DSH.')}</p> : null}
      {confirm.element}
    </div>
  )
}

/**
 * Where help would be of use and none is installed: one line and the button.
 * Shown by default — a cut that is beyond post-production is a common thing, and help is one press away.
 */
export function HelpPrompt() {
  const { controller } = useStudio()
  const t = useT()
  const helpers = useSnapshot(snapshot => snapshot.settings?.crew?.helpers)
  const { installing, install } = useInstall()
  if (helpers === undefined || !helpers.manage || helpers.packages.some(entry => entry.installed || entry.connected)) return null
  return (
    <p className="nv-note nv-help-prompt">
      <Icon name="users" size={13} />
      <span>{t('还没有外援：后期遇到自己做不了的活时，可以转交给你的 Claude Code 或 Codex。装一个：', 'No outside help yet: what is beyond post-production it could hand to your Claude Code or Codex. Install one:')}</span>
      {helpers.packages.map(entry => (
        <Button key={entry.id} size="sm" icon="download" busy={installing === entry.id} disabled={installing !== undefined && installing !== entry.id} pending={t('正在安装…', 'Installing…')} onClick={() => { void install(entry.id) }}>{NAMES[entry.id]}</Button>
      ))}
      <button type="button" className="nv-link" onClick={() => { controller.openSettings('crew') }}>{t('详情', 'More')}</button>
    </p>
  )
}
