// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Sealed books: the screen that stands before a locked one, and the dialog
 * where a book is sealed, locked, given another way to open, or unsealed.
 *
 * A sealed book has every file of it encrypted on disk. It is read only after
 * it was unlocked — with its password, or by this computer's own unlock (a
 * fingerprint, or the computer's password) — and only until it is locked
 * again or the Harness quits. Passwords are typed here and nowhere else:
 * never into the conversation.
 */
import { useEffect, useRef, useState } from 'react'
import type { LockView } from '../../shared/rpc'
import { RpcError } from '../api'
import { Icon } from '../icons'
import {
  Button, Chip, Field, Modal, Progress, Spinner, TextInput, useLoad, useProject, useRunningJob, useSnapshot, useStudio, useT, type Translate,
} from '../ui'

const methodName = (view: LockView | undefined, t: Translate): string => (view?.device.method === 'touch-id' ? t('触控 ID', 'Touch ID') : view?.device.method === 'windows-hello' ? 'Windows Hello' : t('这台电脑的密码', 'this computer\'s password'))

/** What stands in place of a locked book: its name on the shelf, and the ways it opens. */
export function LockScreen() {
  const { controller } = useStudio()
  const t = useT()
  const lock = useSnapshot(snapshot => snapshot.lock)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState<'password' | 'device' | undefined>()
  const [wrong, setWrong] = useState<string | undefined>()
  const field = useRef<HTMLInputElement>(null)
  const view = lock?.view
  useEffect(() => { field.current?.focus() }, [lock?.root])
  if (lock === undefined) return null
  const open = (how: { password?: string; device?: boolean }): void => {
    setBusy(how.device === true ? 'device' : 'password')
    setWrong(undefined)
    void controller.unlock(how).then(() => { setPassword('') }, (error: unknown) => {
      setWrong(error instanceof RpcError && error.code === 'novel/wrong-key'
        ? how.device === true ? t('系统没有确认是你本人——再试一次，或者用密码。', 'The system did not confirm it is you — try again, or use the password.') : t('密码不对。', 'That is not the password.')
        : error instanceof Error ? error.message : String(error))
    }).finally(() => { setBusy(undefined) })
  }
  return (
    <div className="nv-page nv-lockscreen">
      <div className="nv-lock-card">
        <span className="nv-lock-icon"><Icon name="lock" size={28} /></span>
        <h2>{view?.title ?? t('一本加密的书', 'A sealed book')}</h2>
        <p className="nv-muted">{t('这本书加了密：它的正文、设定、图片和音频在磁盘上都是密文。解锁之后才能读、写、听，也才对总编可见；锁上或退出 DSH 后回到这里。', 'This book is sealed: its text, bible, pictures and audio are ciphertext on disk. Only once unlocked can it be read, written and heard — or seen by the showrunner; locking it or quitting the Harness brings it back here.')}</p>
        {view?.deviceOn === true && view.device.available ? (
          <Button variant="primary" icon="fingerprint" busy={busy === 'device'} disabled={busy !== undefined} pending={t(`请在系统弹出的窗口里用${methodName(view, t)}确认…`, `Confirm with ${methodName(view, t)} in the system prompt…`)} onClick={() => { open({ device: true }) }}>{t(`用${methodName(view, t)}解锁`, `Unlock with ${methodName(view, t)}`)}</Button>
        ) : null}
        <form className="nv-lock-form" onSubmit={(event) => { event.preventDefault(); if (password.length > 0 && busy === undefined) open({ password }) }}>
          <input ref={field} className="nv-input" type="password" autoComplete="off" value={password} placeholder={t('这本书的密码', 'The book\'s password')} onChange={(event) => { setPassword(event.target.value); setWrong(undefined) }} />
          <Button variant={view?.deviceOn === true && view.device.available ? 'outline' : 'primary'} icon="unlock" busy={busy === 'password'} disabled={password.length === 0 || busy !== undefined} pending={t('正在解锁…', 'Unlocking…')} onClick={() => { open({ password }) }}>{t('解锁', 'Unlock')}</Button>
        </form>
        {wrong !== undefined ? <p className="nv-note is-warn">{wrong}</p> : null}
        {view?.conversations !== undefined && view.conversations.sealed + view.conversations.waiting > 0 ? <p className="nv-muted nv-small">{t(`关于这本书的 ${view.conversations.sealed} 段对话也加密收着，解锁后会放回 DSH 的会话列表（没出现的话，重新打开一下 DSH）。`, `${view.conversations.sealed} conversations about this book are sealed with it; unlocking puts them back in DSH's list of sessions (reopen DSH should they not appear).`)}{view.conversations.waiting > 0 ? t(` 还有 ${view.conversations.waiting} 段正开着，关闭后才会加密。`, ` ${view.conversations.waiting} more are in use and are sealed once they are let go.`) : ''}</p> : null}
        {view === undefined ? <Spinner size={12} /> : view.deviceOn && !view.device.available ? <p className="nv-muted nv-small">{t('这本书在这台电脑上设过系统解锁，但现在系统那边不可用——用密码打开。', 'This book was set to open with this computer\'s unlock, which is not available right now — use the password.')}</p> : null}
        <div className="nv-row-wrap">
          <Button variant="ghost" size="sm" icon="book" onClick={() => { controller.closeProject() }}>{t('回书架', 'Back to the shelf')}</Button>
        </div>
        <p className="nv-muted nv-small">{t('密码只在这里输入，不要发到对话里。忘了密码、这台电脑也没开系统解锁的话，这本书打不开——没有后门。', 'The password is typed here only, never into the conversation. Without it, and without this computer\'s unlock, the book cannot be opened — there is no back door.')}</p>
      </div>
    </div>
  )
}

/** Seal a book, lock it, change how it opens, or take the seal off. */
export function SealDialog({ onClose }: { onClose: () => void }) {
  const { controller } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const loaded = useLoad(signal => controller.api.call('lock.get', { root }, signal), [root, project.revision])
  const job = useRunningJob(candidate => candidate.kind === 'seal' && candidate.project === root)
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const [label, setLabel] = useState('')
  const [device, setDevice] = useState(true)
  const [changing, setChanging] = useState(false)
  const view = loaded.data
  const mismatch = again.length > 0 && password !== again
  const usable = password.length >= 4 && password === again
  const run = (work: () => Promise<unknown>): Promise<unknown> => controller.guard(async () => {
    await work()
    loaded.reload()
  })
  const seal = (): Promise<unknown> => run(async () => {
    await controller.run('lock.seal', { root, password, ...(label.trim().length > 0 ? { label: label.trim() } : {}), device: device && view?.device.available === true })
    setPassword('')
    setAgain('')
    void controller.loadWorkspaces().catch(() => {})
    controller.toast('success', t('已加密：磁盘上只剩密文。', 'Sealed: only ciphertext is left on disk.'))
  })
  const change = (params: { password?: string; label?: string; device?: boolean; forget?: { kind: 'grant' | 'device'; id: string } }): Promise<unknown> => controller.guard(async () => {
    loaded.set(await controller.api.call('lock.change', { root, ...params }))
  })
  return (
    <Modal title={t('加密与上锁', 'Seal and lock')} onClose={onClose} wide>
      {view === undefined ? <div className="nv-center">{loaded.error !== undefined ? <p className="nv-muted">{t('这个版本的工坊服务还不支持加密——重启一次 DSH 就有了。', 'This Studio service cannot seal books yet — restart the Harness once.')}</p> : <Spinner />}</div> : job !== undefined ? (
        <div className="nv-seal-working">
          <Spinner size={14} />
          <strong>{job.title === 'unseal' ? t('正在解除加密…', 'Unsealing…') : t('正在加密每一个文件…', 'Sealing every file…')}</strong>
          <Progress done={job.progress?.done ?? 0} total={0} label={t(`已处理 ${job.progress?.done ?? 0} 个文件`, `${job.progress?.done ?? 0} files done`)} />
          <p className="nv-muted nv-small">{t('图片和音频多的书要一会儿。中途断电或退出也没关系：下次解锁时会接着做完。', 'A book with many pictures and much audio takes a while. A power cut or a quit in the middle does no harm: the work is finished at the next unlock.')}</p>
        </div>
      ) : !view.sealed ? (
        <div className="nv-seal">
          <p>{t(`给《${project.manifest.title}》加密后，这本书的每一个文件——正文、设定、大纲、记忆、图片、音频、导出——在磁盘上都只以密文存在，连文件名也加密。别人打开这个文件夹、云盘同步、备份里看到的都是密文。`, `Once "${project.manifest.title}" is sealed, every file of it — text, bible, outline, memory, pictures, audio, exports — exists on disk as ciphertext only, file names included. Whoever opens the folder, a sync service, a backup: all they see is ciphertext.`)}</p>
          <ul className="nv-share-facts">
            <li>{t('每次启动 DSH 后要先解锁才能读写；锁着的时候，总编也看不到它。', 'After each start of the Harness the book has to be unlocked before it can be read or written; while it is locked the showrunner cannot see it either.')}</li>
            <li>{t('密码是最后的钥匙：忘了它，而这台电脑的系统解锁也不在了，这本书就再也打不开。请记在别处。', 'The password is the last key: lose it, and this computer\'s unlock with it, and the book cannot be opened again. Keep it somewhere else too.')}</li>
            <li>{t('加密管的是这本书的文件。不在范围内的：加密前已经留在磁盘空闲区、备份或云盘历史版本里的明文；发给模型服务的内容（照常会离开这台电脑）；以及你和总编的对话记录——它读过、引用过的正文片段留在 DSH 的会话记录里，那是明文。', 'The seal covers the book\'s files. Outside it: plain copies already lying in free disk space, in backups or in a sync service\'s history; what is sent to model services (which leaves this computer as before); and your conversations with the showrunner — passages it read or quoted stay in the Harness\'s session records, in the clear.')}</li>
          </ul>
          <div className="nv-form-grid">
            <Field label={t('密码', 'Password')} hint={t('至少 4 个字符；越长越好，可以是一句话', 'At least 4 characters; longer is better — a phrase works')}>
              <TextInput type="password" autoComplete="new-password" value={password} onChange={(event) => { setPassword(event.target.value) }} />
            </Field>
            <Field label={t('再输一遍', 'Once more')} hint={mismatch ? t('两次不一样', 'The two do not match') : undefined}>
              <TextInput type="password" autoComplete="new-password" value={again} onChange={(event) => { setAgain(event.target.value) }} />
            </Field>
          </div>
          <Field label={t('锁着的时候，书架上显示的名字', 'The name on the shelf while it is locked')} hint={t('留空就显示书名；想连书名也藏起来，就写个别的', 'Left empty, the title is shown; write something else to hide the title too')}>
            <TextInput value={label} placeholder={project.manifest.title} onChange={(event) => { setLabel(event.target.value) }} />
          </Field>
          {view.device.available ? (
            <label className="nv-check">
              <input type="checkbox" checked={device} onChange={(event) => { setDevice(event.target.checked) }} />
              <span>{t(`也允许用${methodName(view, t)}在这台电脑上解锁（系统验证是你本人后，才从这台电脑的钥匙串里取出钥匙）`, `Also let ${methodName(view, t)} unlock it on this computer (the key is taken from this computer's keychain only after the system confirmed it is you)`)}</span>
            </label>
          ) : <p className="nv-muted nv-small">{t('这台电脑没有可用的系统验证（触控 ID / Windows Hello），这本书只用密码解锁。', 'This computer offers no system unlock (Touch ID / Windows Hello); the book opens with its password only.')}</p>}
          <div className="nv-row-wrap">
            <Button variant="primary" icon="lock" disabled={!usable} pending={t('正在开始加密…', 'Starting…')} onClick={seal}>{t('加密这本书', 'Seal this book')}</Button>
          </div>
        </div>
      ) : (
        <div className="nv-seal">
          <div className="nv-row-wrap">
            <Chip tone="green">{t('已加密', 'Sealed')}</Chip>
            <span className="nv-muted nv-small">{t(`锁着时书架上显示为「${view.title ?? ''}」`, `Shown on the shelf as "${view.title ?? ''}" while locked`)}</span>
            <span className="nv-spacer" />
            <Button variant="primary" icon="lock" pending={t('正在上锁…', 'Locking…')} onClick={() => controller.guard(async () => { onClose(); await controller.lockBook() })}>{t('现在锁上', 'Lock now')}</Button>
          </div>
          {view.conversations !== undefined ? (
            <p className="nv-note">
              {t(`和这本书有关的对话也跟着上锁：锁上时，DSH 里关于它的对话记录（总编的对话、各个角色的运行记录——里面有正文和设定）会用这本书的钥匙加密收起来，从 DSH 的会话列表里消失；解锁后原样放回，可以接着聊。现在有 ${view.conversations.open} 段对话。`, `The conversations about this book are locked with it: when it is locked, what DSH keeps of them (the showrunner's conversations and the roles' runs, which hold its text and its bible) is encrypted with the book's key and taken out of DSH's list of sessions; unlocked, they are put back as they were and can be gone on with. There are ${view.conversations.open} right now.`)}
              {view.conversations.waiting > 0 ? <span className="nv-muted"> {t(`其中 ${view.conversations.waiting} 段正开着，要等它关闭（最晚下次启动 DSH）才能加密。`, `${view.conversations.waiting} of them are in use and are sealed once they are let go — at the latest the next time DSH starts.`)}</span> : null}
            </p>
          ) : null}
          <p className="nv-muted nv-small">{t('锁上之后，这台电脑上要重新解锁才能读写，总编也看不到它；退出 DSH 也会自动锁上。已经放行的手机等设备凭各自的授权仍然能读（读的时候电脑这边依旧是锁着的）——要让它们也读不到，在下面收回授权，或者停止分享这本书。', 'Once locked, it has to be unlocked again on this computer to be read or written, and the showrunner cannot see it; quitting the Harness locks it too. Devices that were let in can still read it by their own grant (it stays locked on this computer while they do) — to shut them out as well, withdraw their grant below or stop sharing the book.')}</p>
          <h4>{t('这本书可以这样打开', 'This book opens with')}</h4>
          <ul className="nv-lock-ways">
            {view.ways.map((way, index) => (
              <li key={`${way.kind}-${way.id ?? index}`}>
                <Icon name={way.kind === 'password' ? 'unlock' : way.kind === 'device' ? 'fingerprint' : 'phone'} size={14} />
                <span>{way.kind === 'password' ? t('密码', 'The password') : way.kind === 'device' ? t(`电脑「${way.label ?? way.id ?? ''}」的系统解锁`, `The unlock of the computer "${way.label ?? way.id ?? ''}"`) : t(`已放行的设备：${way.label ?? way.id ?? ''}`, `A device that was let in: ${way.label ?? way.id ?? ''}`)}</span>
                {way.at !== undefined ? <span className="nv-muted nv-small">{new Date(way.at).toLocaleDateString()}</span> : null}
                <span className="nv-spacer" />
                {way.kind === 'password' ? <Button size="sm" variant="ghost" onClick={() => { setChanging(value => !value) }}>{t('改密码', 'Change')}</Button> : null}
                {way.kind === 'grant' && way.id !== undefined ? <Button size="sm" variant="ghost" icon="x" pending={t('正在收回…', 'Withdrawing…')} onClick={() => change({ forget: { kind: 'grant', id: way.id! } })}>{t('收回', 'Withdraw')}</Button> : null}
                {way.kind === 'device' && way.id !== undefined && !(view.deviceOn && way.id === `host:${view.device.host}`) ? <Button size="sm" variant="ghost" icon="x" pending={t('正在移除…', 'Removing…')} onClick={() => change({ forget: { kind: 'device', id: way.id! } })}>{t('移除', 'Remove')}</Button> : null}
              </li>
            ))}
          </ul>
          {changing ? (
            <div className="nv-form-grid">
              <Field label={t('新密码', 'New password')}><TextInput type="password" autoComplete="new-password" value={password} onChange={(event) => { setPassword(event.target.value) }} /></Field>
              <Field label={t('再输一遍', 'Once more')} hint={mismatch ? t('两次不一样', 'The two do not match') : undefined}><TextInput type="password" autoComplete="new-password" value={again} onChange={(event) => { setAgain(event.target.value) }} /></Field>
              <Button variant="primary" disabled={!usable} pending={t('正在更换…', 'Changing…')} onClick={() => change({ password }).then(() => { setPassword(''); setAgain(''); setChanging(false); controller.toast('success', t('密码已更换；旧密码不再能打开这本书。', 'Password changed; the old one no longer opens the book.')) })}>{t('换成新密码', 'Use the new password')}</Button>
            </div>
          ) : null}
          {view.device.available ? (
            <label className="nv-check">
              <input type="checkbox" checked={view.deviceOn} onChange={(event) => { void change({ device: event.target.checked }) }} />
              <span>{t(`允许用${methodName(view, t)}在这台电脑上解锁`, `Let ${methodName(view, t)} unlock it on this computer`)}</span>
            </label>
          ) : null}
          <details className="nv-share-advanced">
            <summary>{t('解除加密', 'Take the seal off')}</summary>
            <p className="nv-muted nv-small">{t('所有文件恢复成明文，和加密之前一样。之后任何能打开这个文件夹的人都能读到它。', 'Every file becomes plain again, as before the book was sealed. From then on whoever can open the folder can read it.')}</p>
            <Button variant="danger" icon="unlock" pending={t('正在开始…', 'Starting…')} onClick={() => run(async () => { await controller.run('lock.unseal', { root }); void controller.loadWorkspaces().catch(() => {}); controller.toast('success', t('已解除加密。', 'The seal is off.')) })}>{t('解除这本书的加密', 'Unseal this book')}</Button>
          </details>
        </div>
      )}
    </Modal>
  )
}
