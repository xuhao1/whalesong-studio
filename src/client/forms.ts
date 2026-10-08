// SPDX-License-Identifier: LGPL-3.0-or-later
/** What the bible's forms share: reading a box of lines, a select's options from labels, an AI assist with its stream. */
import { useEffect, useRef, useState } from 'react'
import { useStudio, type Translate } from './ui'

export const lines = (text: string): string[] => text.split('\n').map(line => line.trim()).filter(line => line.length > 0)

export const options = <T extends string>(labels: Record<T, [string, string]>, t: Translate): { value: T; label: string }[] =>
  (Object.keys(labels) as T[]).map(value => ({ value, label: t(labels[value][0], labels[value][1]) }))

/** Follow an AI-assist job and show its stream while it runs. */
export function useAssist(): { running: boolean; stream: string; start: (run: (onText: (text: string) => void) => Promise<unknown>) => void } {
  const { controller } = useStudio()
  const [running, setRunning] = useState(false)
  const [stream, setStream] = useState('')
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])
  const start = (run: (onText: (text: string) => void) => Promise<unknown>): void => {
    setRunning(true)
    setStream('')
    void controller.guard(async () => { await run((text) => { if (alive.current) setStream(text) }) }).finally(() => {
      if (alive.current) {
        setRunning(false)
        setStream('')
      }
    })
  }
  return { running, stream, start }
}

// ───────────────────────────── characters ─────────────────────────────
