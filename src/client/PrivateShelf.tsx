// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The private shelf, on the shelf: the way in (a password), what stands on it
 * while it is open, and how a book is put on it or taken off. The shelf's own
 * password opens every book on it; a book may ask for a password of its own
 * besides (`core/shelf.ts`).
 */
import { useState, type ReactNode } from 'react'
import type { PrivateShelfState } from '../shared/rpc'
import type { ProjectRef } from '../shared/types'
import { RpcError } from './api'
import { Button, Field, Modal, plainEnter, Select, TextInput, useAction, useStudio, useT } from './ui'
import { deviceName, UnlockForm } from './views/Lock'

type Book = ProjectRef & { workspace: string }

/** A password asked for, with what went wrong said under it. */
function Password({ value, onChange, onEnter, placeholder, autoFocus }: { value: string; onChange: (value: string) => void; onEnter?: () => void; placeholder?: string; autoFocus?: boolean }) {
  return <TextInput type="password" autoComplete="off" autoFocus={autoFocus} value={value} placeholder={placeholder} onChange={(event) => { onChange(event.target.value) }} onKeyDown={(event) => { if (plainEnter(event) && onEnter !== undefined) onEnter() }} />
}

/** What a request that failed says, in the words it came with. */
const said = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Open the shelf: the same form a sealed book is opened with — this computer's own unlock where the shelf was set up for it, and the password. */
function ShelfOpenDialog({ state, onClose }: { state: PrivateShelfState; onClose: () => void }) {
  const { controller } = useStudio()
  const t = useT()
  return (
    <Modal title={t('打开私密书架', 'Open the private shelf')} onClose={onClose}>
      <div className="nv-lock-card is-inline">
        <UnlockForm
          device={state.device}
          deviceOn={state.deviceOn === true}
          placeholder={t('私密书架的密码', 'The shelf\'s password')}
          unlock={async (how) => {
            await controller.api.call('shelf.open', how)
            await controller.loadWorkspaces()
            onClose()
          }}
        />
      </div>
    </Modal>
  )
}

/** Set the shelf up, or give it another password. */
function ShelfKeyDialog({ how, onClose }: { how: 'setup' | 'open' | 'change'; onClose: () => void }) {
  const { controller } = useStudio()
  const t = useT()
  const { busy, run } = useAction()
  const [password, setPassword] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [wrong, setWrong] = useState<string | undefined>()
  const fresh = how === 'setup' ? password : next
  const ready = password.length > 0 && (how === 'open' || (fresh.length >= 4 && fresh === again))
  const go = (): void => {
    if (!ready || busy) return
    void run(async () => {
      try {
        if (how === 'setup') await controller.api.call('shelf.setup', { password })
        else if (how === 'open') await controller.api.call('shelf.open', { password })
        else await controller.api.call('shelf.change', { password, next })
      } catch (error) {
        // A wrong password is something to say here, not a failure of the Studio.
        if (error instanceof RpcError && (error.code === 'novel/wrong-key' || error.code === 'novel/invalid')) {
          setWrong(error.code === 'novel/wrong-key' ? t('密码不对。', 'That is not the password.') : said(error))
          return
        }
        throw error
      }
      await controller.loadWorkspaces()
      onClose()
    })
  }
  return (
    <Modal title={how === 'setup' ? t('设置私密书架', 'Set up the private shelf') : how === 'open' ? t('打开私密书架', 'Open the private shelf') : t('私密书架换密码', 'Another password for the private shelf')} onClose={onClose} footer={(
      <>
        <span className="nv-spacer" />
        <Button variant="primary" icon={how === 'open' ? 'unlock' : 'lock'} busy={busy} disabled={!ready} onClick={go}>{how === 'setup' ? t('设置', 'Set up') : how === 'open' ? t('打开', 'Open') : t('换密码', 'Change')}</Button>
      </>
    )}>
      {how === 'setup' ? <p className="nv-muted nv-small">{t('放进私密书架的书加密保存，不出现在书架上；输入这个密码才看得到、打得开。忘了密码，里面的书打不开。', 'Books put on it are kept encrypted and off the shelf; this password shows and opens them. Forgotten, the books on it cannot be opened.')}</p> : null}
      <Field label={how === 'change' ? t('现在的密码', 'The password now') : t('密码', 'Password')}>
        <Password autoFocus value={password} onChange={(value) => { setPassword(value); setWrong(undefined) }} {...(how === 'open' ? { onEnter: go } : {})} />
      </Field>
      {how === 'change' ? <Field label={t('新密码', 'The new one')} hint={t('至少四个字符', 'Four characters at least')}><Password value={next} onChange={setNext} /></Field> : null}
      {how !== 'open' ? <Field label={t('再输一遍', 'Once more')}><Password value={again} onChange={setAgain} onEnter={go} /></Field> : null}
      {how !== 'open' && again.length > 0 && again !== fresh ? <p className="nv-note is-warn nv-small">{t('两遍不一样。', 'The two differ.')}</p> : null}
      {wrong !== undefined ? <p className="nv-note is-warn nv-small">{wrong}</p> : null}
    </Modal>
  )
}

/** Put a book on the shelf: which, and whether it asks for a password of its own besides. */
function ShelveDialog({ books, onClose }: { books: readonly Book[]; onClose: () => void }) {
  const { controller } = useStudio()
  const t = useT()
  const { busy, run } = useAction()
  const [root, setRoot] = useState(books[0]?.root ?? '')
  const book = books.find(item => item.root === root)
  // `key`: the shelf's password opens it. `own`: a password of its own besides — a new one, or (sealed already) the one it has.
  const [lock, setLock] = useState<'key' | 'own' | 'keep'>('key')
  const [password, setPassword] = useState('')
  const [wrong, setWrong] = useState<string | undefined>()
  const ready = book !== undefined && (lock !== 'own' || password.length >= 4)
  const go = (): Promise<unknown> => run(async () => {
    try {
      await controller.run('shelf.add', { root, ...(lock === 'own' ? { own: password } : lock === 'keep' ? { own: true } : {}) })
    } catch (error) {
      if (error instanceof RpcError && (error.code === 'novel/invalid' || error.code === 'novel/locked')) {
        setWrong(said(error))
        return
      }
      throw error
    }
    await controller.loadWorkspaces()
    controller.toast('success', t(`《${book?.title ?? ''}》放进了私密书架`, `"${book?.title ?? ''}" is on the private shelf`))
    onClose()
  })
  return (
    <Modal title={t('把书放进私密书架', 'Put a book on the private shelf')} onClose={onClose} footer={(
      <>
        <span className="nv-spacer" />
        <Button variant="primary" icon="lock" busy={busy} pending={t('正在加密…', 'Sealing…')} disabled={!ready} onClick={go}>{t('放进去', 'Put it there')}</Button>
      </>
    )}>
      {books.length === 0 ? <p className="nv-muted">{t('书架上没有可以放进去的书（上着锁的先解锁）。', 'No book on the shelf can be put there (unlock a locked one first).')}</p> : (
        <>
          <Field label={t('哪一本', 'Which book')}>
            <Select value={root} options={books.map(item => ({ value: item.root, label: `${item.title}${item.sealed === true ? t('（已加密）', ' (sealed)') : ''}` }))} onChange={(value) => { setRoot(value); setLock('key') }} />
          </Field>
          <Field label={t('怎么打开', 'How it opens')}>
            <Select value={lock} options={[
              { value: 'key' as const, label: t('开了私密书架就能打开', 'Open with the shelf') },
              { value: 'own' as const, label: t('再设一个它自己的密码（二次加密）', 'A password of its own besides') },
              ...(book?.sealed === true ? [{ value: 'keep' as const, label: t('沿用它现在的密码（二次加密）', 'The password it has, besides') }] : []),
            ]} onChange={setLock} />
          </Field>
          {lock === 'own' ? <Field label={t('这本书自己的密码', 'Its own password')} hint={t('至少四个字符', 'Four characters at least')}><Password value={password} onChange={setPassword} /></Field> : null}
          <p className="nv-muted nv-small">{book?.sealed === true ? t('这本书已经加密，文件不动。', 'The book is sealed already; its files stay as they are.') : t('这本书的每个文件会加密保存，和它有关的对话一起收起。', 'Every file of the book is encrypted where it lies, and the conversations about it are put away with it.')}</p>
          {wrong !== undefined ? <p className="nv-note is-warn nv-small">{wrong}</p> : null}
        </>
      )}
    </Modal>
  )
}

/** Take a book off the shelf: it is among the others again, still sealed. */
function UnshelveDialog({ book, onClose }: { book: Book; onClose: () => void }) {
  const { controller } = useStudio()
  const t = useT()
  const { busy, run } = useAction()
  const [password, setPassword] = useState('')
  const [wrong, setWrong] = useState<string | undefined>()
  const go = (): Promise<unknown> => run(async () => {
    try {
      await controller.api.call('shelf.remove', { root: book.root, ...(password.length > 0 ? { password } : {}) })
    } catch (error) {
      if (error instanceof RpcError && (error.code === 'novel/invalid' || error.code === 'novel/locked')) {
        setWrong(error.code === 'novel/locked' ? t('先解锁这本书。', 'Unlock the book first.') : t('取出后它得有自己的密码：在上面填一个。', 'Off the shelf it needs a password of its own: give it one above.'))
        return
      }
      throw error
    }
    await controller.loadWorkspaces()
    onClose()
  })
  return (
    <Modal title={t(`把《${book.title}》从私密书架取出`, `Take "${book.title}" off the private shelf`)} onClose={onClose} footer={(
      <>
        <span className="nv-spacer" />
        <Button variant="primary" busy={busy} onClick={go}>{t('取出', 'Take it off')}</Button>
      </>
    )}>
      <p className="nv-muted nv-small">{t('取出后它回到书架上，仍然是加密的。要取消加密，到这本书的“加密与上锁”里。', 'It goes back among the other books, still sealed. To take the seal off, see the book\'s own lock page.')}</p>
      <Field label={t('这本书自己的密码', 'Its own password')} hint={book.own === true ? t('留空：沿用它现在的', 'Empty: the one it has') : t('至少四个字符', 'Four characters at least')}>
        <Password value={password} onChange={(value) => { setPassword(value); setWrong(undefined) }} />
      </Field>
      {wrong !== undefined ? <p className="nv-note is-warn nv-small">{wrong}</p> : null}
    </Modal>
  )
}

/**
 * The private shelf's part of the shelf page.
 * @param state - how the shelf stands; left out by a Host that has none (nothing is shown).
 * @param books - what stands on it (given only while it is open).
 * @param others - the books of the ordinary shelf that could be put on it.
 * @param tile - a book as the shelf shows one; `extra` is laid over it.
 */
export function PrivateShelfSection({ state, books, others, tile }: { state: PrivateShelfState | undefined; books: readonly Book[]; others: readonly Book[]; tile: (book: Book, extra?: ReactNode) => ReactNode }) {
  const { controller } = useStudio()
  const t = useT()
  const { busy, run } = useAction()
  const [asking, setAsking] = useState<'setup' | 'open' | 'change' | undefined>()
  const [adding, setAdding] = useState(false)
  const [taking, setTaking] = useState<Book | undefined>()
  if (state === undefined) return null
  return (
    <section className={`nv-home-shelf nv-private-shelf${state.open ? ' is-open' : ''}`}>
      <header className="nv-home-shelf-head">
        <h2><span className="nv-private-mark" aria-hidden="true">{state.open ? '🔓' : '🔒'}</span>{t('私密书架', 'Private shelf')}<span className="nv-muted">{state.open && books.length > 0 ? books.length : ''}</span></h2>
        <span className="nv-row">
          {!state.set ? <Button size="sm" variant="ghost" icon="lock" onClick={() => { setAsking('setup') }} title={t('放进去的书加密保存、不出现在书架上，输入密码才看得到', 'Books on it are kept encrypted and off the shelf, shown only when its password is given')}>{t('设置…', 'Set up…')}</Button>
            : !state.open ? <Button size="sm" icon="unlock" onClick={() => { setAsking('open') }}>{t('打开…', 'Open…')}</Button>
              : (
                  <>
                    <Button size="sm" variant="ghost" icon="plus" onClick={() => { setAdding(true) }}>{t('放一本书进来…', 'Put a book on it…')}</Button>
                    {state.device?.available === true ? (
                      <label className="nv-check nv-small" title={t(`打开私密书架时可以不输密码，用${deviceName(state.device, t)}确认。书架的钥匙交给这台电脑的系统钥匙串保管。`, `Open the shelf without typing its password, confirmed with ${deviceName(state.device, t)}. The shelf's key is kept by this computer's own credential store.`)}>
                        <input type="checkbox" checked={state.deviceOn === true} disabled={busy} onChange={(event) => { const on = event.target.checked; void run(async () => { await controller.api.call('shelf.device', { on }); await controller.loadWorkspaces(); controller.toast('success', on ? t(`以后可以用${deviceName(state.device, t)}打开私密书架`, `The shelf now opens with ${deviceName(state.device, t)} too`) : t('私密书架只用密码打开了', 'The shelf opens with its password only')) }) }} />
                        <span>{t(`可用${deviceName(state.device, t)}打开`, `Opens with ${deviceName(state.device, t)}`)}</span>
                      </label>
                    ) : null}
                    <Button size="sm" variant="ghost" onClick={() => { setAsking('change') }}>{t('换密码', 'Password…')}</Button>
                    <Button size="sm" icon="lock" busy={busy} onClick={() => run(async () => { await controller.api.call('shelf.close', {}); await controller.loadWorkspaces() })}>{t('锁上', 'Close')}</Button>
                  </>
                )}
        </span>
      </header>
      {state.open ? (
        books.length > 0 ? (
          <div className="nv-shelf">
            {books.map(book => tile(book, (
              <button type="button" className="nv-shelf-unshelve" onClick={() => { setTaking(book) }} title={t('从私密书架取出', 'Take it off the private shelf')}>{t('取出', 'Take off')}</button>
            )))}
          </div>
        ) : <p className="nv-muted nv-small">{t('还没有书。', 'No book on it yet.')}</p>
      ) : null}
      {asking === 'open' ? <ShelfOpenDialog state={state} onClose={() => { setAsking(undefined) }} /> : asking !== undefined ? <ShelfKeyDialog how={asking} onClose={() => { setAsking(undefined) }} /> : null}
      {adding ? <ShelveDialog books={others.filter(book => book.locked !== true)} onClose={() => { setAdding(false) }} /> : null}
      {taking !== undefined ? <UnshelveDialog book={taking} onClose={() => { setTaking(undefined) }} /> : null}
    </section>
  )
}
