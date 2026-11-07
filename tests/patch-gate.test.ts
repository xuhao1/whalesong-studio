// SPDX-License-Identifier: LGPL-3.0-or-later
/** DSH 0.2.2's `apply_patch` names every file it changes in one patch; the gate that keeps a book whole has to read them. */
import { describe, expect, it } from 'vitest'
import { patchPaths } from '../src/core/reconcile'

describe("the files a Codex-style patch names", () => {
  it('reads add, update, delete and move lines', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: bible/new.md',
      '+# New',
      '*** Update File: manuscript/ch001.md',
      '@@',
      '*** Move to: manuscript/ch002.md',
      '-old',
      '+new',
      '*** Delete File: .novel/jotting.json',
      '*** End Patch',
    ].join('\n')
    expect(patchPaths(patch)).toEqual(['bible/new.md', 'manuscript/ch001.md', 'manuscript/ch002.md', '.novel/jotting.json'])
  })

  it('takes a path with spaces whole, and trims it', () => {
    expect(patchPaths('*** Update File:  manuscript/第一章 vendredi.md   \n')).toEqual(['manuscript/第一章 vendredi.md'])
  })

  it('names nothing for a patch that changes no file, and ignores ordinary lines', () => {
    expect(patchPaths('*** Begin Patch\n@@ some context\n*** End Patch')).toEqual([])
  })
})