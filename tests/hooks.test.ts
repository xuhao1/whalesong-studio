// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * No screen of the Studio or the reader calls a hook after it may have returned.
 *
 * A component that returns early while its data loads and reaches a hook only
 * once the data is there renders with one hook more than the render before:
 * React throws, and the host takes the whole Studio off the screen — a blank
 * page where a book was. It type-checks, it builds, and nothing shows it until
 * somebody opens that screen. So the sources are read here, every one of them.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.tsx?$/.test(name) ? [path] : []
  })
}

const isFunction = (node: ts.Node): node is ts.FunctionLikeDeclaration => ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)

/** Every node of a statement that runs when the statement does: what is inside a function written there runs later, if at all. */
function within(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node)
  node.forEachChild((child) => { if (!isFunction(child)) within(child, visit) })
}

/** The hooks a statement calls as it runs, by name. */
function hooksOf(statement: ts.Node): string[] {
  const names: string[] = []
  within(statement, (node) => {
    if (!ts.isCallExpression(node)) return
    const callee = node.expression
    const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined
    if (name !== undefined && /^use[A-Z0-9]/.test(name)) names.push(name)
  })
  return names
}

/** A statement after which the rest of the function may not run. */
function mayReturn(statement: ts.Node): boolean {
  let returns = false
  within(statement, (node) => { if (ts.isReturnStatement(node)) returns = true })
  return returns
}

/** The name a function goes by: its own, or that of the constant it is kept in. */
function nameOf(node: ts.FunctionLikeDeclaration): string | undefined {
  if (node.name !== undefined && ts.isIdentifier(node.name)) return node.name.text
  const parent = node.parent
  return ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) ? parent.name.text : undefined
}

/** Hooks called after a point where the function may have returned, in components and in hooks of our own. */
export function hooksAfterReturn(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (isFunction(node) && node.body !== undefined && ts.isBlock(node.body)) {
      const name = nameOf(node)
      // What React calls with its hooks in order: a component, or a hook.
      if (name !== undefined && /^([A-Z]|use[A-Z0-9])/.test(name)) {
        let returned: number | undefined
        for (const statement of node.body.statements) {
          const line = (at: number): number => source.getLineAndCharacterOfPosition(at).line + 1
          if (returned !== undefined) {
            for (const hook of hooksOf(statement)) found.push(`${file}:${line(statement.getStart())} ${name} calls ${hook}() after it may have returned at line ${returned}`)
          } else if (mayReturn(statement) && !ts.isReturnStatement(statement)) {
            returned = line(statement.getStart())
          }
        }
      }
    }
    node.forEachChild(visit)
  }
  visit(source)
  return found
}

describe('the rules of hooks, read off the sources', () => {
  it('tells a hook reached only after an early return from one asked for before it', () => {
    const late = `
      export function Stage({ chapter }: { chapter?: string }) {
        const board = useLoad(() => fetch(chapter))
        if (board.data === undefined) return <Spinner />
        const sheets = useSheetsAsk()
        return <div>{sheets.element}</div>
      }`
    expect(hooksAfterReturn('Stage.tsx', late)).toEqual(['Stage.tsx:5 Stage calls useSheetsAsk() after it may have returned at line 4'])
    const early = late.replace('const sheets = useSheetsAsk()\n', '').replace('const board', 'const sheets = useSheetsAsk()\n        const board')
    expect(hooksAfterReturn('Stage.tsx', early)).toEqual([])
    // A hook inside a function written after the return is not called by the render; one in a kept arrow component is.
    expect(hooksAfterReturn('a.tsx', 'function A() { if (x) return null; const run = () => { useThing() }; return run }')).toEqual([])
    expect(hooksAfterReturn('b.tsx', 'const B = () => { if (x) { return null } const [a] = React.useState(0); return a }')).toHaveLength(1)
    // A hook of our own is held to the same: in the statement it returns with, a hook is still reached after the return before it.
    expect(hooksAfterReturn('c.ts', 'export function useC() { if (off) return undefined; return useMemo(() => 1, []) }')).toHaveLength(1)
    expect(hooksAfterReturn('d.ts', 'export function useD() { const value = useMemo(() => 1, []); if (off) return undefined; return value }')).toEqual([])
    // Not a component and not a hook: whatever it calls is its own business.
    expect(hooksAfterReturn('e.ts', 'function helper() { if (x) return 1; return useless() }')).toEqual([])
  })

  it('finds none in the Studio and the reader', () => {
    const found = [join(ROOT, 'src/client'), join(ROOT, 'src/reader')].flatMap(sources).flatMap(path => hooksAfterReturn(relative(ROOT, path), readFileSync(path, 'utf8')))
    expect(found).toEqual([])
  })
})
