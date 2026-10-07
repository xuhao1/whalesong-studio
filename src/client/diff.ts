// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * A small text diff for reviewing revisions: paragraphs first, then tokens
 * inside the paragraphs that changed, so a rewritten sentence shows as a
 * sentence and an untouched chapter stays quiet.
 */

export interface DiffPart {
  kind: 'same' | 'add' | 'del'
  text: string
}

/** Cells of the LCS table we are willing to fill before falling back to "all removed, all added". */
const MAX_CELLS = 4_000_000

function lcs<T>(left: T[], right: T[], emit: (kind: DiffPart['kind'], item: T) => void): void {
  let start = 0
  while (start < left.length && start < right.length && left[start] === right[start]) start++
  let endLeft = left.length
  let endRight = right.length
  while (endLeft > start && endRight > start && left[endLeft - 1] === right[endRight - 1]) {
    endLeft--
    endRight--
  }
  for (let i = 0; i < start; i++) emit('same', left[i]!)
  const rows = endLeft - start
  const columns = endRight - start
  if (rows === 0 || columns === 0 || rows * columns > MAX_CELLS) {
    for (let i = start; i < endLeft; i++) emit('del', left[i]!)
    for (let j = start; j < endRight; j++) emit('add', right[j]!)
  } else {
    const width = columns + 1
    const table = new Uint32Array((rows + 1) * width)
    for (let i = rows - 1; i >= 0; i--) {
      for (let j = columns - 1; j >= 0; j--) {
        table[i * width + j] = left[start + i] === right[start + j]
          ? table[(i + 1) * width + j + 1]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!)
      }
    }
    let i = 0
    let j = 0
    while (i < rows && j < columns) {
      if (left[start + i] === right[start + j]) {
        emit('same', left[start + i]!)
        i++
        j++
      } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
        emit('del', left[start + i]!)
        i++
      } else {
        emit('add', right[start + j]!)
        j++
      }
    }
    for (; i < rows; i++) emit('del', left[start + i]!)
    for (; j < columns; j++) emit('add', right[start + j]!)
  }
  for (let i = endLeft; i < left.length; i++) emit('same', left[i]!)
}

/** Latin words and runs of whitespace stay whole; everything else (CJK, punctuation) is one token per character. */
function tokens(text: string): string[] {
  return text.match(/[A-Za-z0-9_'’-]+|\s+|[\s\S]/gu) ?? []
}

function push(parts: DiffPart[], kind: DiffPart['kind'], text: string): void {
  const last = parts.at(-1)
  if (last !== undefined && last.kind === kind) last.text += text
  else parts.push({ kind, text })
}

/** Token-level diff of two short texts. */
export function diffInline(before: string, after: string): DiffPart[] {
  const parts: DiffPart[] = []
  lcs(tokens(before), tokens(after), (kind, token) => { push(parts, kind, token) })
  return parts
}

/** Diff of two long texts: by paragraph, refined inside the paragraphs that changed. */
export function diffText(before: string, after: string): DiffPart[] {
  const lines: { kind: DiffPart['kind']; text: string }[] = []
  lcs(before.split('\n'), after.split('\n'), (kind, line) => { lines.push({ kind, text: line }) })
  const parts: DiffPart[] = []
  for (let at = 0; at < lines.length;) {
    const line = lines[at]!
    if (line.kind === 'same') {
      push(parts, 'same', `${line.text}\n`)
      at++
      continue
    }
    // A run of removed and added paragraphs is one rewrite; show what changed inside it.
    const removed: string[] = []
    const added: string[] = []
    while (at < lines.length && lines[at]!.kind !== 'same') {
      const item = lines[at]!
      if (item.kind === 'del') removed.push(item.text)
      else added.push(item.text)
      at++
    }
    const left = removed.join('\n')
    const right = added.join('\n')
    if (removed.length === 0) push(parts, 'add', `${right}\n`)
    else if (added.length === 0) push(parts, 'del', `${left}\n`)
    else {
      const inner = diffInline(left, right)
      const kept = inner.reduce((sum, part) => sum + (part.kind === 'same' ? part.text.length : 0), 0)
      // When almost nothing survived, interleaved fragments read worse than the two versions side by side.
      if (kept < Math.min(left.length, right.length) * 0.3) {
        push(parts, 'del', `${left}\n`)
        push(parts, 'add', `${right}\n`)
      } else {
        for (const part of inner) push(parts, part.kind, part.text)
        push(parts, 'same', '\n')
      }
    }
  }
  return parts
}

/** Keep only the changes with a little unchanged text around them. */
export function compactDiff(parts: DiffPart[], context = 60): (DiffPart | { kind: 'gap'; text: string })[] {
  const out: (DiffPart | { kind: 'gap'; text: string })[] = []
  parts.forEach((part, at) => {
    if (part.kind !== 'same' || part.text.length <= context * 2 + 20) {
      out.push(part)
      return
    }
    const first = at === 0
    const last = at === parts.length - 1
    if (!first) out.push({ kind: 'same', text: part.text.slice(0, context) })
    out.push({ kind: 'gap', text: '' })
    if (!last) out.push({ kind: 'same', text: part.text.slice(-context) })
  })
  return out
}
