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

type Device = LockView['device']

/** What this computer's own unlock is called. */
export const deviceName = (device: Device | undefined, t: Translate): string => (device?.method === 'touch-id' ? t('触控 ID', 'Touch ID') : device?.method === 'windows-hello' ? 'Windows Hello' : t('这台电脑的密码', 'this computer\'s password'))
const methodName = (view: LockView | undefined, t: Translate): string => deviceName(view?.device, t)

/**
 * The way in to whatever is locked — a sealed book, the private shelf: this computer's own unlock where it was set up
 * for it, and the password. One form for both, so both open alike.
 * @param unlock - open it; a `novel/wrong-key` it throws is said here, in the form.
 */
export function UnlockForm({ device, deviceOn, placeholder, unlock, focusKey }: { device: Device | undefined; deviceOn: boolean; placeholder: string; unlock: (how: { password?: string; device?: boolean }) => Promise<unknown>; /** Changes when another thing is to be opened: the field is focused again. */ focusKey?: unknown }) {
  const t = useT()
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState<'password' | 'device' | undefined>()
  const [wrong, setWrong] = useState<string | undefined>()
  const field = useRef<HTMLInputElement>(null)
  useEffect(() => { field.current?.focus() }, [focusKey])
  const byDevice = deviceOn && device?.available === true
  const open = (how: { password?: string; device?: boolean }): void => {
    setBusy(how.device === true ? 'device' : 'password')
    setWrong(undefined)
    void unlock(how).then(() => { setPassword('') }, (error: unknown) => {
      setWrong(error instanceof RpcError && error.code === 'novel/wrong-key'
        ? how.device === true ? t('系统没有确认是你本人——再试一次，或者用密码。', 'The system did not confirm it is you — try again, or use the password.') : t('密码不对。', 'That is not the password.')
        : error instanceof Error ? error.message : String(error))
    }).finally(() => { setBusy(undefined) })
  }
  return (
    <>
      {byDevice ? (
        <Button variant="primary" icon="fingerprint" busy={busy === 'device'} disabled={busy !== undefined} pending={t(`请在系统弹出的窗口里用${deviceName(device, t)}确认…`, `Confirm with ${deviceName(device, t)} in the system prompt…`)} onClick={() => { open({ device: true }) }}>{t(`用${deviceName(device, t)}解锁`, `Unlock with ${deviceName(device, t)}`)}</Button>
      ) : null}
      <form className="nv-lock-form" onSubmit={(event) => { event.preventDefault(); if (password.length > 0 && busy === undefined) open({ password }) }}>
        <input ref={field} className="nv-input" type="password" autoComplete="off" value={password} placeholder={placeholder} onChange={(event) => { setPassword(event.target.value); setWrong(undefined) }} />
        <Button variant={byDevice ? 'outline' : 'primary'} icon="unlock" busy={busy === 'password'} disabled={password.length === 0 || busy !== undefined} pending={t('正在解锁…', 'Unlocking…')} onClick={() => { open({ password }) }}>{t('解锁', 'Unlock')}</Button>
      </form>
      {wrong !== undefined ? <p className="nv-note is-warn">{wrong}</p> : null}
      {deviceOn && device !== undefined && !device.available ? <p className="nv-muted nv-small">{t('系统解锁现在不可用，请用密码。', 'System unlock is not available right now: use the password.')}</p> : null}
    </>
  )
}

/** What stands in place of a locked book: its name on the shelf, and the ways it opens. */
export function LockScreen() {
  const { controller } = useStudio()
  const t = useT()
  const lock = useSnapshot(snapshot => snapshot.lock)
  const view = lock?.view
  if (lock === undefined) return null
  return (
    <div className="nv-page nv-lockscreen">
      <div className="nv-lock-card">
        <span className="nv-lock-icon"><Icon name="lock" size={28} /></span>
        <h2>{view?.title ?? t('一本加密的书', 'A sealed book')}</h2>
        <p className="nv-muted">{t('这本书加了密，解锁后才能读写。', 'This book is sealed: unlock it to read or write.')}</p>
        <UnlockForm device={view?.device} deviceOn={view?.deviceOn === true} placeholder={t('这本书的密码', 'The book\'s password')} focusKey={lock.root} unlock={how => controller.unlock(how)} />
        {view?.conversations !== undefined && view.conversations.sealed + view.conversations.waiting > 0 ? <p className="nv-muted nv-small">{t(`${view.conversations.sealed} 段对话也加密收着，解锁后放回。`, `${view.conversations.sealed} conversation(s) are sealed with it and come back when it is unlocked.`)}{view.conversations.waiting > 0 ? t(` 还有 ${view.conversations.waiting} 段正开着，关闭后才会加密。`, ` ${view.conversations.waiting} more are in use and are sealed once they are let go.`) : ''}</p> : null}
        {view === undefined ? <Spinner size={12} /> : null}
        <div className="nv-row-wrap">
          <Button variant="ghost" size="sm" icon="book" onClick={() => { controller.closeProject() }}>{t('回书架', 'Back to the shelf')}</Button>
        </div>
        <p className="nv-muted nv-small">{t('密码不要发到对话里。忘了密码就打不开。', 'Never put the password in a conversation. Forget it and the book stays shut.')}</p>
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
      {view === undefined ? <div className="nv-center">{loaded.error !== undefined ? <p className="nv-muted">{t('这个版本的工坊服务还不支持加密——重启一次 DSH 就有了。', 'This Studio service cannot seal books yet — restart DSH once.')}</p> : <Spinner />}</div> : job !== undefined ? (
        <div className="nv-seal-working">
          <Spinner size={14} />
          <strong>{job.title === 'unseal' ? t('正在解除加密…', 'Unsealing…') : t('正在加密每一个文件…', 'Sealing every file…')}</strong>
          <Progress done={job.progress?.done ?? 0} total={0} label={t(`已处理 ${job.progress?.done ?? 0} 个文件`, `${job.progress?.done ?? 0} files done`)} />
          <p className="nv-muted nv-small">{t('中途退出也没关系，下次解锁时接着做完。', 'Quitting midway is fine: it is finished at the next unlock.')}</p>
        </div>
      ) : !view.sealed ? (
        <div className="nv-seal">
          <p>{t(`给《${project.manifest.title}》加密：这本书的每个文件和文件名在磁盘上都是密文。`, `Seal "${project.manifest.title}": every file of the book, names included, is kept on disk as ciphertext.`)}</p>
          <ul className="nv-share-facts">
            <li>{t('每次启动 DSH 后要先解锁；锁着时总编也看不到它。', 'It must be unlocked after each start of DSH; while locked the showrunner cannot see it either.')}</li>
            <li>{t('忘了密码、系统解锁也不在了，就再也打不开。', 'With the password forgotten and system unlock gone, it can never be opened again.')}</li>
            <li>{t('不在加密范围内的：加密前留在备份或云盘历史里的明文；发给模型服务的内容。', 'Not covered: plaintext left in backups or cloud history from before; what is sent to model services.')}</li>
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
              <span>{t(`也允许用${methodName(view, t)}在这台电脑上解锁`, `Also unlock with ${methodName(view, t)} on this computer`)}</span>
            </label>
          ) : <p className="nv-muted nv-small">{t('这台电脑没有系统验证，只用密码解锁。', 'This computer has no system verification: the password is the only way in.')}</p>}
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
              {t(`这本书的对话也跟着上锁，解锁后放回。现在有 ${view.conversations.open} 段。`, `This book's conversations are sealed with it and come back on unlock. There are ${view.conversations.open} now.`)}
              {view.conversations.waiting > 0 ? <span className="nv-muted"> {t(`其中 ${view.conversations.waiting} 段正开着，关闭后才加密。`, `${view.conversations.waiting} of them are open and are sealed once closed.`)}</span> : null}
            </p>
          ) : null}
          <p className="nv-muted nv-small">{t('退出 DSH 会自动锁上。已放行的设备仍然能读，要收回在下面。', 'Quitting DSH locks it. Devices already let in can still read; take that back below.')}</p>
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
            <p className="nv-muted nv-small">{t('所有文件恢复成明文。', 'Every file goes back to plaintext.')}</p>
            <Button variant="danger" icon="unlock" pending={t('正在开始…', 'Starting…')} onClick={() => run(async () => { await controller.run('lock.unseal', { root }); void controller.loadWorkspaces().catch(() => {}); controller.toast('success', t('已解除加密。', 'The seal is off.')) })}>{t('解除这本书的加密', 'Unseal this book')}</Button>
          </details>
        </div>
      )}
    </Modal>
  )
}
