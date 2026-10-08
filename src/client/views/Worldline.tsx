// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * A line of the plot as a world of its own: who has come on along it and how
 * they stand where it ends, which threads it leaves open — and, held against
 * another line, where the two part and what is different between them after
 * that: somebody dead on one and alive on the other, a thread paid off here
 * and still open there.
 *
 * Everything is read off the chapter digests along each line (`shared/worldline.ts`);
 * nothing of it is kept, so it is as true as the digests are.
 */
import { useMemo, useState } from 'react'
import { MAIN_LINE } from '../../shared/types'
import { lifeEnd, type LifeStanding } from '../../shared/life'
import { compareLines, type LinePerson, type LineThread, type LineWorld } from '../../shared/worldline'
import { Chip, cx, Select, Spinner, useKept, useLoad, useProject, useStudio, useT, type Translate } from '../ui'
import { STANDING_LABELS, STANDING_TONES } from './Characters'

const STANDINGS: readonly LifeStanding[] = ['active', 'offstage', 'retired', 'dead']

/** How somebody stands at the end of a line, in a few words: where they were last seen, where it ended for them. */
function standing(person: LinePerson | undefined, t: Translate): string {
  if (person === undefined) return t('这条线没有写到他', 'This line never comes to them')
  const end = lifeEnd(person, true) !== undefined ? t(lifeEnd(person, true)!.text, lifeEnd(person, false)!.text)
    : t(`最后在第 ${person.last} 章`, `last seen in chapter ${person.last}`)
  return [end, person.where, person.state].filter((part): part is string => part !== undefined && part.length > 0).join(t(' · ', ' · '))
}

/** What somebody came to know after two lines part, on one of them: a few of the things, and how many more. */
function known(items: readonly string[] | undefined, t: Translate): string | undefined {
  if (items === undefined || items.length === 0) return undefined
  return `${items.slice(0, 3).join(t('；', '; '))}${items.length > 3 ? t(` 等 ${items.length} 件`, ` and ${items.length - 3} more`) : ''}`
}

function threadState(thread: LineThread | undefined, t: Translate): string {
  if (thread === undefined) return t('这条线上没有这条线索', 'Not on this line')
  return thread.state === 'paid' ? t(`第 ${thread.last} 章回收`, `paid off in chapter ${thread.last}`) : t(`还悬着（最后提到：第 ${thread.last} 章）`, `still open (last touched in chapter ${thread.last})`)
}

/**
 * The world of one line, with a way to hold another against it.
 * @param line - the line's id; `main` for the main line.
 * @param names - what every line of the book is called, the main one among them.
 */
export function LineWorldPanel({ line, names }: { line: string; names: { id: string; title: string }[] }) {
  const { controller } = useStudio()
  const t = useT()
  const { project, root } = useProject()
  const [against, setAgainst] = useKept<string>(`worldline.against.${line}`, '')
  const [courses, setCourses] = useState(false)
  const [everyone, setEveryone] = useState(false)
  const [knowing, setKnowing] = useState(false)
  const own = useLoad<LineWorld>(async signal => await controller.api.call('line.world', { root, ...(line !== MAIN_LINE ? { line } : {}) }, signal), [root, line, project.revision])
  const other = against.length > 0 && against !== line && names.some(item => item.id === against) ? against : ''
  const theirs = useLoad<LineWorld | undefined>(async signal => (other.length > 0 ? await controller.api.call('line.world', { root, ...(other !== MAIN_LINE ? { line: other } : {}) }, signal) : undefined), [root, other, project.revision])
  const compared = useMemo(() => (own.data !== undefined && theirs.data !== undefined && other.length > 0 ? compareLines(own.data, theirs.data) : undefined), [own.data, theirs.data, other])
  const nameOf = (id: string): string => names.find(item => item.id === id)?.title ?? id
  // Somebody's page, read along the line the difference was found on.
  const open = (person: string, along: string): void => {
    controller.kept.set('cast.line', along)
    controller.openCharacter(person)
  }
  if (own.data === undefined) {
    return <div className="nv-worldline">{own.error !== undefined ? <span className="nv-muted nv-small">{/unknown method/.test(own.error) ? t('这个版本的工坊后台还不会按线读出世界——在顶上点"重启"换成新版本就有了。', 'This Studio backend cannot read the world along a line yet — press Restart at the top to change to the new version.') : own.error}</span> : <Spinner size={13} />}</div>
  }
  const world = own.data
  const written = world.path.filter(chapter => chapter.hasText).length
  const digested = world.path.filter(chapter => chapter.digested).length
  const count = (status: LifeStanding): LinePerson[] => world.people.filter(person => person.status === status)
  const open_ = world.threads.filter(thread => thread.state === 'open')
  const fates = compared?.people.filter(item => item.kind === 'fate') ?? []
  const only = compared?.people.filter(item => item.kind === 'only') ?? []
  // The same end by another road: those of them who came to know other things on the way are worth a row of their own.
  const wiser = compared?.people.filter(item => item.kind === 'course' && item.knows !== undefined) ?? []
  const course = compared?.people.filter(item => item.kind === 'course' && item.knows === undefined) ?? []
  const informed = world.people.filter(person => (person.learned?.length ?? 0) > 0)
  return (
    <div className="nv-worldline">
      <div className="nv-worldline-head">
        <strong>{t('这条线上的世界', 'The world along this line')}</strong>
        <span className="nv-muted nv-small">
          {t(`读到这条线的末尾：${world.path.length} 章，已写 ${written} 章，收录了 ${digested} 章。`, `Read to the end of the line: ${world.path.length} chapters, ${written} written, ${digested} digested.`)}
          {written > digested ? t(` 还有 ${written - digested} 章没收录。`, ` ${written - digested} more are not digested.`) : ''}
        </span>
      </div>
      {world.people.length === 0 ? <p className="nv-muted nv-small">{t('这条线上还没有收录过的章节。', 'No chapter of this line is digested yet.')}</p> : (
        <div className="nv-worldline-standings">
          {STANDINGS.map((status) => {
            const list = count(status)
            if (list.length === 0) return null
            return (
              <div key={status} className="nv-worldline-standing">
                <Chip tone={STANDING_TONES[status]}>{t(...STANDING_LABELS[status])} {list.length}</Chip>
                <span className="nv-worldline-names">
                  {list.slice(0, status === 'active' ? 12 : 24).map(person => <button key={person.id} type="button" className="nv-link" onClick={() => { open(person.id, line) }} title={`${standing(person, t)}${(person.learned?.length ?? 0) > 0 ? t(`\n知道了：${person.learned!.slice(-3).map(item => item.what).join('；')}`, `\nHas learned: ${person.learned!.slice(-3).map(item => item.what).join('; ')}`) : ''}`}>{person.name}</button>)}
                  {list.length > (status === 'active' ? 12 : 24) ? <span className="nv-muted">{t(` 等 ${list.length} 人`, ` and ${list.length - (status === 'active' ? 12 : 24)} more`)}</span> : null}
                </span>
              </div>
            )
          })}
          {world.threads.length > 0 ? (
            <div className="nv-worldline-standing">
              <Chip tone="violet">{t(`线索 ${world.threads.length}`, `Threads ${world.threads.length}`)}</Chip>
              <span className="nv-worldline-names nv-small">
                {t(`已回收 ${world.threads.length - open_.length}，还悬着 ${open_.length}`, `${world.threads.length - open_.length} paid off, ${open_.length} open`)}
                {open_.length > 0 ? t(`：${open_.slice(0, 6).map(thread => thread.title).join('、')}${open_.length > 6 ? ' 等' : ''}`, `: ${open_.slice(0, 6).map(thread => thread.title).join(', ')}${open_.length > 6 ? '…' : ''}`) : ''}
              </span>
            </div>
          ) : null}
          {informed.length > 0 ? (
            <div className="nv-worldline-standing nv-worldline-knows">
              <Chip tone="blue">{t(`知道了什么 ${informed.length} 人`, `What they know: ${informed.length}`)}</Chip>
              <span className="nv-worldline-names nv-small">
                <button type="button" className="nv-link" onClick={() => { setKnowing(!knowing) }}>{knowing ? t('收起', 'Fold') : t('各人先后得知的事', 'What each has come to know')}</button>
              </span>
              {knowing ? (
                <ul className="nv-worldline-known">
                  {informed.map(person => (
                    <li key={person.id}>
                      <button type="button" className="nv-link" onClick={() => { open(person.id, line) }}>{person.name}</button>
                      <span>{person.learned!.map(item => t(`第 ${item.index} 章：${item.what}`, `ch. ${item.index}: ${item.what}`)).join(t('；', '; '))}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
      {names.length > 1 ? (
        <div className="nv-worldline-against">
          <span>{t('和另一条线比较', 'Hold another line against it')}</span>
          <Select value={other} options={[{ value: '', label: t('（不比较）', '(none)') }, ...names.filter(item => item.id !== line).map(item => ({ value: item.id, label: item.title }))]} onChange={setAgainst} />
          {other.length > 0 && theirs.data === undefined ? (theirs.error !== undefined ? <span className="nv-muted nv-small">{theirs.error}</span> : <Spinner size={13} />) : null}
        </div>
      ) : null}
      {compared !== undefined ? (
        <div className="nv-worldline-compare">
          <p className="nv-note">
            {compared.parts !== undefined
              ? t(`两条线从头一样读到第 ${compared.parts.index} 章《${compared.parts.title}》，之后分开：`, `The two read alike up to chapter ${compared.parts.index}, "${compared.parts.title}", and part after it: `)
              : t('两条线从第一页起就不一样：', 'The two differ from the first page: ')}
            {t(`「${nameOf(line)}」自己走 ${compared.own.left.chapters} 章（已写 ${compared.own.left.written}），「${nameOf(other)}」自己走 ${compared.own.right.chapters} 章（已写 ${compared.own.right.written}）。`, `"${nameOf(line)}" goes ${compared.own.left.chapters} chapters of its own (${compared.own.left.written} written), "${nameOf(other)}" ${compared.own.right.chapters} (${compared.own.right.written} written).`)}
            {compared.people.length + compared.threads.length === 0 ? t(' 收录里读不出两条线上的人和线索有什么不同。', ' Nothing in the digests tells the people or the threads of the two apart.') : ''}
          </p>
          {fates.length + only.length + wiser.length > 0 ? (
            <table className="nv-worldline-table">
              <thead><tr><th>{t('谁', 'Who')}</th><th>{nameOf(line)}</th><th>{nameOf(other)}</th></tr></thead>
              <tbody>
                {[...fates, ...wiser, ...(everyone ? only : only.slice(0, 6))].map(item => (
                  <tr key={item.id} className={cx(item.kind === 'fate' && 'is-fate')}>
                    <th><button type="button" className="nv-link" onClick={() => { open(item.id, item.left !== undefined ? line : other) }}>{item.name}</button><span className="nv-muted nv-small"> {item.kind === 'fate' ? t('命运不同', 'another fate') : item.kind === 'course' ? t('知道的不一样', 'knows other things') : t('只在一条线上', 'on one line only')}</span></th>
                    {(['left', 'right'] as const).map((side) => {
                      const here = item[side]
                      const learned = known(item.knows?.[side], t)
                      return (
                        <td key={side}>
                          {here !== undefined ? <Chip tone={STANDING_TONES[here.status]}>{t(...STANDING_LABELS[here.status])}</Chip> : null} <span className="nv-small">{standing(here, t)}</span>
                          {learned !== undefined ? <span className="nv-small nv-worldline-learned" title={item.knows![side].join('\n')}>{t('分开之后得知：', 'Learned after the parting: ')}{learned}</span> : null}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {only.length > 6 ? <p className="nv-small"><button type="button" className="nv-link" onClick={() => { setEveryone(!everyone) }}>{everyone ? t('收起只在一条线上出现的人', 'Fold those on one line only') : t(`还有 ${only.length - 6} 人只在一条线上出现`, `${only.length - 6} more are on one line only`)}</button></p> : null}
          {course.length > 0 ? (
            <p className="nv-small">
              <button type="button" className="nv-link" onClick={() => { setCourses(!courses) }}>{courses ? t('收起', 'Fold') : t(`还有 ${course.length} 人在两条线上结局一样、经历的章节不同`, `${course.length} more stand the same at both ends and went through other chapters`)}</button>
              {courses ? <span className="nv-worldline-names">{course.map(item => <button key={item.id} type="button" className="nv-link" onClick={() => { open(item.id, line) }} title={`${nameOf(line)}: ${standing(item.left, t)}\n${nameOf(other)}: ${standing(item.right, t)}`}>{item.name}</button>)}</span> : null}
            </p>
          ) : null}
          {compared.threads.length > 0 ? (
            <table className="nv-worldline-table">
              <thead><tr><th>{t('线索', 'Thread')}</th><th>{nameOf(line)}</th><th>{nameOf(other)}</th></tr></thead>
              <tbody>
                {compared.threads.map(item => (
                  <tr key={item.key} className={cx(item.kind === 'state' && 'is-fate')}>
                    <th>{item.title}</th>
                    <td className="nv-small">{threadState(item.left, t)}</td>
                    <td className="nv-small">{threadState(item.right, t)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          <p className="nv-muted nv-small">{t(`两条线上一样的：${compared.alike.people} 人、${compared.alike.threads} 条线索。`, `The same on both: ${compared.alike.people} people, ${compared.alike.threads} threads.`)}</p>
        </div>
      ) : null}
    </div>
  )
}
