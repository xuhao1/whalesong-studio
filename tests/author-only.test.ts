// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * What is the author's alone to do, on the page.
 *
 * Bringing a file of this computer into the book as a picture, and saying
 * what a picture of the book is for, are done by the author where the picture
 * is shown. Neither the showrunner nor the crew has a tool for either — the
 * author's word (2026-10-11: "不要给总编这个权限"). This reads the sources of
 * everything an agent can call and fails where one of them reaches for it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..', 'src')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? sources(path) : /\.tsx?$/.test(name) ? [path] : []
  })
}

describe('what only the author does', () => {
  it('gives no agent a way to bring a file in as a picture, or to say what a picture is for', () => {
    // The showrunner's tools, and the tools the crew's roles are given.
    const files = [...sources(join(ROOT, 'agent')), join(ROOT, 'core', 'crew.ts')]
    expect(files.length).toBeGreaterThan(5)
    const reaching = files.filter(file => /\b(importPicture|usePictureAs|refilePicture|takeDown)\b|image\.(import|use)\b/.test(readFileSync(file, 'utf8')))
    expect(reaching.map(file => file.slice(ROOT.length + 1))).toEqual([])
  })
})
