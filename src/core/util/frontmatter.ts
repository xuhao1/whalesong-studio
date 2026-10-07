// SPDX-License-Identifier: LGPL-3.0-or-later
/** Markdown-with-front-matter documents: structured fields a human can still edit by hand. */
import { parse, stringify } from 'yaml'

export interface FrontMatterDocument<T> {
  data: T
  body: string
}

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

/**
 * Parse a Markdown file with an optional YAML front matter block.
 * A file without front matter (or with an unparseable one) is all body.
 */
export function parseFrontMatter<T extends object>(text: string): FrontMatterDocument<Partial<T>> {
  const source = text.replace(/^﻿/, '')
  const match = FENCE.exec(source)
  if (match === null) return { data: {}, body: source.trim() }
  let data: unknown
  try {
    data = parse(match[1] ?? '')
  } catch {
    return { data: {}, body: source.trim() }
  }
  const body = source.slice(match[0].length).trim()
  return { data: (data !== null && typeof data === 'object' && !Array.isArray(data) ? data : {}) as Partial<T>, body }
}

/** Render a document; keys with undefined, empty-string or empty-array values are omitted. */
export function renderFrontMatter(data: object, body?: string): string {
  const clean: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue
    if (typeof value === 'string' && value.length === 0) continue
    if (Array.isArray(value) && value.length === 0) continue
    if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value as object).length === 0) continue
    clean[key] = value
  }
  const yaml = stringify(clean, { lineWidth: 0, defaultStringType: 'PLAIN', defaultKeyType: 'PLAIN' }).trimEnd()
  const text = body?.trim() ?? ''
  return `---\n${yaml}\n---\n${text.length > 0 ? `\n${text}\n` : ''}`
}
