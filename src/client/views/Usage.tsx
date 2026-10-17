// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Usage and cost: what the Studio's model calls have used — tokens of text,
 * pictures, minutes of speech — by model, by role, by book and by day.
 *
 * The Studio counts; the author says what a model costs them. A model with a
 * price shows money, a model without one shows that it has none, and nothing
 * is guessed in between.
 */
import { useState } from 'react'
import { formatCount } from '../../shared/text'
import type { PriceEntry, UsageAmount, UsageKind, UsageRow } from '../../shared/types'
import { Button, Chip, cx, Empty, Field, Modal, SectionTitle, Spinner, TextInput, useAction, useLoad, useSnapshot, useStudio, useT, type Translate } from '../ui'
import { CallsDialog } from '../Calls'

type Range = 'today' | '7d' | '30d' | 'all'

const RANGES: { value: Range; label: [string, string] }[] = [
  { value: 'today', label: ['今天', 'Today'] },
  { value: '7d', label: ['近 7 天', '7 days'] },
  { value: '30d', label: ['近 30 天', '30 days'] },
  { value: 'all', label: ['全部', 'All time'] },
]

const KIND: Record<UsageKind, [string, string]> = {
  text: ['文本', 'Text'],
  image: ['图片', 'Images'],
  speech: ['语音', 'Speech'],
  embedding: ['向量', 'Embeddings'],
}

const ROLE: Record<string, [string, string]> = {
  writer: ['写手', 'Writer'],
  architect: ['策划', 'Planner'],
  analyst: ['场记', 'Continuity'],
  director: ['导演', 'Director'],
  producer: ['后期', 'Post-production'],
  other: ['其他文本调用', 'Other text calls'],
  image: ['绘图', 'Pictures'],
  speech: ['配音', 'Speech'],
  listen: ['配音听检', 'Listening to takes'],
  vision: ['看图', 'Looking at pictures'],
  embedding: ['语义检索', 'Retrieval'],
}

export function money(cost: readonly UsageAmount[]): string {
  return cost.filter(amount => amount.amount > 0).map(amount => `${amount.currency}${amount.amount < 1 ? amount.amount.toFixed(3) : amount.amount.toFixed(2)}`).join(' + ')
}

function minutes(seconds: number): string {
  return seconds >= 60 ? `${(seconds / 60).toFixed(1)}` : (seconds / 60).toFixed(2)
}

export function UsageView() {
  const { controller, locale } = useStudio()
  const t = useT()
  const root = useSnapshot(snapshot => snapshot.root)
  const title = useSnapshot(snapshot => snapshot.project?.manifest.title)
  const [range, setRange] = useState<Range>('30d')
  const [scope, setScope] = useState<'book' | 'all'>(root !== undefined ? 'book' : 'all')
  const [pricing, setPricing] = useState<UsageRow | undefined>()
  const [calls, setCalls] = useState(false)
  const inBook = scope === 'book' && root !== undefined
  const loaded = useLoad(signal => controller.api.call('usage.summary', { range, ...(inBook ? { root } : {}) }, signal), [range, inBook, root])
  const count = (value: number): string => formatCount(Math.round(value), locale)

  if (loaded.data === undefined) return <div className="nv-center">{loaded.error !== undefined ? <p className="nv-muted">{loaded.error}</p> : <Spinner size={18} />}</div>
  const { summary, prices, begun } = loaded.data
  const { total } = summary
  const cost = money(total.cost)
  const max = Math.max(1, ...summary.byDay.map(day => day.input + day.output))

  return (
    <div className="nv-page nv-usage">
      <header className="nv-settings-head">
        <div>
          <h2>{t('用量与成本', 'Usage and cost')}</h2>
          <p className="nv-muted nv-small">{t('工坊每调用一次模型就记一笔。填上单价就能看到花费。', 'Every model call the Studio makes is noted. Enter prices to see the cost.')}</p>
        </div>
        {/* The counts are here; what each call sent and got back is the book's record of calls. */}
        {root !== undefined ? <Button variant="ghost" icon="list" title={t('这本书每次文字模型调用发了什么、回了什么', 'What every call to a text model for this book sent and got back')} onClick={() => { setCalls(true) }}>{t('调用记录…', 'Record of calls…')}</Button> : null}
        <Button variant="ghost" icon="refresh" busy={loaded.loading} onClick={() => { loaded.reload() }}>{t('刷新', 'Refresh')}</Button>
      </header>
      {calls && root !== undefined ? <CallsDialog onClose={() => { setCalls(false) }} /> : null}

      <div className="nv-toolbar">
        <div className="nv-chips">
          {RANGES.map(item => <Chip key={item.value} active={range === item.value} tone={range === item.value ? 'blue' : 'neutral'} onClick={() => { setRange(item.value) }}>{t(...item.label)}</Chip>)}
        </div>
        <span className="nv-spacer" />
        <div className="nv-chips">
          {root !== undefined ? <Chip active={inBook} tone={inBook ? 'blue' : 'neutral'} onClick={() => { setScope('book') }}>{t(`只看《${title ?? ''}》`, `Only "${title ?? ''}"`)}</Chip> : null}
          <Chip active={!inBook} tone={!inBook ? 'blue' : 'neutral'} onClick={() => { setScope('all') }}>{t('所有作品', 'All books')}</Chip>
        </div>
      </div>

      {total.calls === 0 ? (
        <Empty icon="clock" title={t('这段时间还没有调用记录', 'No calls in this period')}>{t('还没有用量记录。', 'Nothing has been used yet.')}</Empty>
      ) : (
        <>
          <div className="nv-usage-cards">
            <Figure label={t('预估花费', 'Estimated cost')} value={cost.length > 0 ? cost : '—'} sub={summary.unpriced.length > 0 ? t(`${summary.unpriced.length} 个模型还没填单价，未计入`, `${summary.unpriced.length} models have no price and are left out`) : t('按你填的单价计算', 'At the prices you entered')} tone={summary.unpriced.length > 0 ? 'amber' : undefined} />
            <Figure label={t('文本 tokens', 'Text tokens')} value={`${total.estimated ? '≈' : ''}${count(total.input + total.output)}`} sub={t(`输入 ${count(total.input)}${(total.cached ?? 0) > 0 ? `（其中缓存命中 ${count(total.cached ?? 0)}，${Math.round(((total.cached ?? 0) / Math.max(1, total.input)) * 100)}%）` : ''} · 输出 ${count(total.output)}`, `${count(total.input)} in${(total.cached ?? 0) > 0 ? ` (${count(total.cached ?? 0)} of it from the provider's cache, ${Math.round(((total.cached ?? 0) / Math.max(1, total.input)) * 100)}%)` : ''} · ${count(total.output)} out`)} />
            <Figure label={t('图片', 'Pictures')} value={count(total.images)} sub={t('张', 'drawn')} />
            <Figure label={t('语音', 'Speech')} value={`${minutes(total.seconds)} ${t('分钟', 'min')}`} sub={t(`${count(total.chars)} 字`, `${count(total.chars)} characters`)} />
            <Figure label={t('调用次数', 'Calls')} value={count(total.calls)} sub={t(`${summary.byDay.length} 天有活动`, `over ${summary.byDay.length} active days`)} />
          </div>

          <section className="nv-card">
            <SectionTitle>{t('按模型', 'By model')}</SectionTitle>
            <p className="nv-muted nv-small">{t('没填单价的模型只计数，不算钱。', 'A model with no price entered is counted, not costed.')}</p>
            <div className="nv-table-wrap">
              <table className="nv-table">
                <thead>
                  <tr>
                    <th>{t('模型', 'Model')}</th>
                    <th>{t('类型', 'Kind')}</th>
                    <th className="is-num">{t('调用', 'Calls')}</th>
                    <th className="is-num">{t('输入', 'In')}</th>
                    <th className="is-num">{t('输出', 'Out')}</th>
                    <th className="is-num">{t('图片', 'Pics')}</th>
                    <th className="is-num">{t('语音(分)', 'Speech (min)')}</th>
                    <th className="is-num">{t('花费', 'Cost')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {summary.byModel.map(row => (
                    <tr key={row.key}>
                      <td className="nv-usage-model">{row.label}</td>
                      <td>{row.kind !== undefined ? t(...KIND[row.kind]) : ''}</td>
                      <td className="is-num">{count(row.calls)}</td>
                      <td className="is-num">{row.input > 0 ? `${row.estimated ? '≈' : ''}${count(row.input)}` : ''}</td>
                      <td className="is-num">{row.output > 0 ? `${row.estimated ? '≈' : ''}${count(row.output)}` : ''}</td>
                      <td className="is-num">{row.images > 0 ? count(row.images) : ''}</td>
                      <td className="is-num">{row.seconds > 0 ? minutes(row.seconds) : ''}</td>
                      <td className="is-num">{money(row.cost) || (row.unpriced ? <span className="nv-muted">{t('未定价', 'no price')}</span> : '')}</td>
                      <td className="is-num"><Button size="sm" variant={prices[row.label] === undefined ? 'outline' : 'ghost'} onClick={() => { setPricing(row) }}>{prices[row.label] === undefined ? t('定价', 'Price') : t('改价', 'Edit')}</Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="nv-card">
            <SectionTitle>{t('按分工', 'By role')}</SectionTitle>
            <Rows rows={summary.byRole.map(row => ({ ...row, label: t(...(ROLE[row.key] ?? [row.label, row.label])) }))} count={count} t={t} />
          </section>

          {!inBook && summary.byBook.length > 0 ? (
            <section className="nv-card">
              <SectionTitle>{t('按作品', 'By book')}</SectionTitle>
              <Rows rows={summary.byBook.map(row => ({ ...row, label: row.label.length > 0 ? row.label : t('（不属于某本书的调用）', '(calls that belong to no book)') }))} count={count} t={t} />
            </section>
          ) : null}

          <section className="nv-card">
            <SectionTitle>{t('按天', 'By day')}</SectionTitle>
            <div className="nv-usage-days">
              {summary.byDay.map(day => (
                <div key={day.key} className="nv-usage-day" title={`${day.key} · ${count(day.input + day.output)} tokens${day.images > 0 ? ` · ${day.images} ${t('张图', 'pictures')}` : ''}${day.seconds > 0 ? ` · ${minutes(day.seconds)} ${t('分钟语音', 'min of speech')}` : ''}`}>
                  <span className="nv-usage-day-label">{day.key.slice(5)}</span>
                  <span className="nv-usage-day-track"><span className="nv-usage-day-bar" style={{ width: `${Math.max(1, ((day.input + day.output) / max) * 100)}%` }} /></span>
                  <span className="nv-usage-day-figure">{[day.input + day.output > 0 ? `${count(day.input + day.output)} tokens` : '', day.images > 0 ? `${day.images}${t(' 张图', ' pics')}` : '', day.seconds > 0 ? `${minutes(day.seconds)}${t(' 分钟语音', ' min')}` : ''].filter(part => part.length > 0).join(' · ')}</span>
                  <span className="nv-usage-day-cost">{money(day.cost)}</span>
                </div>
              ))}
            </div>
          </section>
        </>
      )}

      <p className="nv-muted nv-small">
        {begun !== undefined ? t(`用量从 ${new Date(begun).toLocaleDateString()} 开始记录。`, `Usage is recorded from ${new Date(begun).toLocaleDateString()}.`) : ''}
        {t('只有工坊自己发出的调用；总编的 token 由 DSH 统计。带 ≈ 的是估算。', 'Only the Studio\'s own calls; the showrunner\'s tokens are counted by DSH. Figures marked ≈ are estimates.')}
      </p>

      {pricing !== undefined ? <PriceEditor row={pricing} price={prices[pricing.label]} onClose={() => { setPricing(undefined) }} onSaved={() => { setPricing(undefined); loaded.reload() }} /> : null}
    </div>
  )
}

function Figure({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'amber' | undefined }) {
  return (
    <div className={cx('nv-usage-figure', tone === 'amber' && 'is-amber')}>
      <span className="nv-usage-figure-label">{label}</span>
      <strong>{value}</strong>
      {sub !== undefined ? <span className="nv-muted nv-small">{sub}</span> : null}
    </div>
  )
}

function Rows({ rows, count, t }: { rows: UsageRow[]; count: (value: number) => string; t: Translate }) {
  return (
    <div className="nv-table-wrap">
      <table className="nv-table">
        <thead>
          <tr>
            <th />
            <th className="is-num">{t('调用', 'Calls')}</th>
            <th className="is-num">{t('输入', 'In')}</th>
            <th className="is-num">{t('输出', 'Out')}</th>
            <th className="is-num">{t('图片', 'Pics')}</th>
            <th className="is-num">{t('语音(分)', 'Speech (min)')}</th>
            <th className="is-num">{t('花费', 'Cost')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.key}>
              <td>{row.label}</td>
              <td className="is-num">{count(row.calls)}</td>
              <td className="is-num">{row.input > 0 ? `${row.estimated ? '≈' : ''}${count(row.input)}` : ''}</td>
              <td className="is-num">{row.output > 0 ? `${row.estimated ? '≈' : ''}${count(row.output)}` : ''}</td>
              <td className="is-num">{row.images > 0 ? count(row.images) : ''}</td>
              <td className="is-num">{row.seconds > 0 ? minutes(row.seconds) : ''}</td>
              <td className="is-num">{money(row.cost) || (row.unpriced ? <span className="nv-muted">{t('未定价', 'no price')}</span> : '')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** What the author pays for one model. Which fields show depends on what the model was used for. */
function PriceEditor({ row, price, onClose, onSaved }: { row: UsageRow; price: PriceEntry | undefined; onClose: () => void; onSaved: () => void }) {
  const { controller } = useStudio()
  const t = useT()
  const { busy, run } = useAction()
  const [draft, setDraft] = useState({
    input: price?.input !== undefined ? String(price.input) : '',
    output: price?.output !== undefined ? String(price.output) : '',
    image: price?.image !== undefined ? String(price.image) : '',
    minute: price?.minute !== undefined ? String(price.minute) : '',
    chars10k: price?.chars10k !== undefined ? String(price.chars10k) : '',
    currency: price?.currency ?? '¥',
  })
  const set = (key: keyof typeof draft) => (event: { target: { value: string } }): void => { setDraft(previous => ({ ...previous, [key]: event.target.value })) }
  const number = (text: string): number | undefined => {
    const value = Number(text)
    return text.trim().length > 0 && Number.isFinite(value) && value >= 0 ? value : undefined
  }
  const save = (clear = false): Promise<unknown> => run(async () => {
    const entry: PriceEntry = {}
    for (const key of ['input', 'output', 'image', 'minute', 'chars10k'] as const) {
      const value = number(draft[key])
      if (value !== undefined) entry[key] = value
    }
    const empty = clear || Object.keys(entry).length === 0
    if (!empty) entry.currency = draft.currency.trim() || '¥'
    await controller.saveSettings({ prices: { [row.label]: empty ? null : entry } })
    onSaved()
  })
  const kind = row.kind ?? 'text'
  return (
    <Modal title={t(`${row.label} 的单价`, `Price of ${row.label}`)} onClose={onClose} footer={(
      <>
        {price !== undefined ? <Button variant="ghost" icon="trash" onClick={() => { save(true) }}>{t('清除单价', 'Clear')}</Button> : null}
        <span className="nv-spacer" />
        <Button variant="ghost" onClick={onClose}>{t('取消', 'Cancel')}</Button>
        <Button variant="primary" busy={busy} onClick={() => { save() }}>{t('保存', 'Save')}</Button>
      </>
    )}>
      <p className="nv-muted nv-small">{t('只填用得到的项。过去和以后的用量都按这个单价算。', 'Fill in only what is used. Past and future usage is costed at these prices.')}</p>
      <div className="nv-form-grid">
        <Field label={t('货币符号', 'Currency sign')}><TextInput value={draft.currency} placeholder="¥" onChange={set('currency')} /></Field>
        {kind === 'text' || kind === 'embedding' ? <Field label={t('每百万输入 tokens', 'Per million input tokens')}><TextInput inputMode="decimal" value={draft.input} onChange={set('input')} /></Field> : null}
        {kind === 'text' ? <Field label={t('每百万输出 tokens', 'Per million output tokens')}><TextInput inputMode="decimal" value={draft.output} onChange={set('output')} /></Field> : null}
        {kind === 'image' ? <Field label={t('每张图', 'Per picture')}><TextInput inputMode="decimal" value={draft.image} onChange={set('image')} /></Field> : null}
        {kind === 'speech' ? <Field label={t('每分钟语音', 'Per minute of speech')} hint={t('按时长计费的填这里', 'For services that bill by duration')}><TextInput inputMode="decimal" value={draft.minute} onChange={set('minute')} /></Field> : null}
        {kind === 'speech' ? <Field label={t('每万字', 'Per 10,000 characters')} hint={t('按字数计费的填这里', 'For services that bill by characters')}><TextInput inputMode="decimal" value={draft.chars10k} onChange={set('chars10k')} /></Field> : null}
      </div>
    </Modal>
  )
}
