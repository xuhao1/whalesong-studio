// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The private shelf: books that are not shown among the others until a
 * password is given.
 *
 * The shelf has a key of its own — random, never stored as it is, kept wrapped
 * with the shelf's password in the one small file that is the shelf
 * (`private-shelf.json`, beside the Studio's settings). A book stands on the
 * shelf by a mark in its stub (`sealed.shelf`); a book the shelf opens has a
 * slot the shelf's key unwraps, and carries a copy of the shelf's file, so
 * that the shelf's password opens the book even where the shelf's own file is
 * gone. A book that keeps a password of its own besides is shown when the
 * shelf is open, and opened by its own password only.
 *
 * Nothing here touches a book: the engine (`NovelCore`) seals, marks and opens
 * them; this keeps the shelf's key and its file.
 */
import { randomBytes } from 'node:crypto'
import { readJson, removePath, writeJson } from './util/fs'
import { newKey, openSlot, openWithSecret, passwordSlot, VaultError, type SealedStub, type SealSlot } from './util/vault'

/** The shelf as it lies on disk: which shelf it is, and its key under its password. */
export interface ShelfFile {
  schema: 1
  id: string
  slot: SealSlot
  /**
   * Other ways in than the password, as a sealed book has them: the shelf's key under a secret this computer's own
   * credential store keeps and hands over once its owner was confirmed (a fingerprint, the computer's password).
   */
  ways?: SealSlot[]
}

export class PrivateShelf {
  private key: Buffer | undefined
  private known: ShelfFile | undefined

  constructor(private readonly path: string) {}

  /** The shelf's file; nothing where no private shelf was set up here. */
  async file(): Promise<ShelfFile | undefined> {
    const stored = await readJson<Partial<ShelfFile>>(this.path).catch(() => undefined)
    this.known = stored !== undefined && typeof stored.id === 'string' && stored.slot !== undefined ? { schema: 1, id: stored.id, slot: stored.slot, ...(Array.isArray(stored.ways) && stored.ways.length > 0 ? { ways: stored.ways } : {}) } : undefined
    return this.known
  }

  /** Whether the shelf is open in this process. */
  get open(): boolean {
    return this.key !== undefined
  }

  /** The open shelf: which it is, and its key. Nothing while it is closed. */
  held(): { id: string; key: Buffer; slot: SealSlot } | undefined {
    return this.key !== undefined && this.known !== undefined ? { id: this.known.id, key: this.key, slot: this.known.slot } : undefined
  }

  /**
   * Set a private shelf up, opened at once.
   * @param adopt - the file of a shelf books here already stand on (its own was lost, or they were brought from
   *   another computer): where the password opens it, it is this shelf again and those books are on it.
   * @throws VaultError `weak` for a password too short; Error where there is a shelf already.
   */
  async setup(password: string, adopt: readonly ShelfFile[] = []): Promise<ShelfFile> {
    if (await this.file() !== undefined) throw new Error('a private shelf is set up here already')
    for (const old of adopt) {
      const key = await openSlot(old.slot, password)
      if (key === undefined) continue
      const file: ShelfFile = { schema: 1, id: old.id, slot: old.slot }
      await writeJson(this.path, file)
      this.known = file
      this.key = key
      return file
    }
    const key = newKey()
    const file: ShelfFile = { schema: 1, id: randomBytes(9).toString('base64url'), slot: await passwordSlot(password, key) }
    await writeJson(this.path, file)
    this.known = file
    this.key = key
    return file
  }

  /** @throws VaultError `wrong-key`; Error where no shelf was set up. */
  async unlock(password: string): Promise<void> {
    const file = await this.file()
    if (file === undefined) throw new Error('no private shelf is set up here')
    const key = await openSlot(file.slot, password)
    if (key === undefined) throw new VaultError('wrong-key', 'that is not the password of the private shelf')
    this.key?.fill(0)
    this.key = key
  }

  /**
   * Open the shelf by one of its other ways in: the secret its keeper holds.
   * @throws VaultError `wrong-key` where the shelf has no such way, or the secret is not its.
   */
  async unlockWith(kind: 'device', id: string, secret: Buffer): Promise<void> {
    const file = await this.file()
    if (file === undefined) throw new Error('no private shelf is set up here')
    // Opened as a book's slot is: the same wrapping, the same check.
    const key = openWithSecret({ sealed: { slots: file.ways ?? [] } } as unknown as SealedStub, kind, id, secret)
    this.key?.fill(0)
    this.key = key
  }

  /**
   * Add a way in (replacing the one of the same keeper), or take one away. The shelf must be open: a way in wraps its key.
   * @param make - the slot, made from the shelf's key by whoever keeps the secret.
   */
  async allow(make: (key: Buffer) => SealSlot): Promise<ShelfFile> {
    const file = await this.file()
    if (file === undefined || this.key === undefined) throw new Error('open the private shelf first')
    const slot = make(this.key)
    const changed: ShelfFile = { ...file, ways: [...(file.ways ?? []).filter(way => !(way.kind === slot.kind && way.id === slot.id)), slot] }
    await writeJson(this.path, changed)
    this.known = changed
    return changed
  }

  async forbid(kind: 'device', id: string): Promise<ShelfFile | undefined> {
    const file = await this.file()
    if (file === undefined) return undefined
    const ways = (file.ways ?? []).filter(way => !(way.kind === kind && way.id === id))
    const { ways: _old, ...rest } = file
    const changed: ShelfFile = ways.length > 0 ? { ...rest, ways } : rest
    await writeJson(this.path, changed)
    this.known = changed
    return changed
  }

  lock(): void {
    this.key?.fill(0)
    this.key = undefined
  }

  /**
   * Another password for the shelf; its key stays, so every book on it opens as before.
   * @returns the shelf's file as it now is — what the books of the shelf carry a copy of.
   * @throws VaultError `wrong-key` where `password` is not the shelf's.
   */
  async change(password: string, next: string): Promise<ShelfFile> {
    const file = await this.file()
    if (file === undefined) throw new Error('no private shelf is set up here')
    const key = await openSlot(file.slot, password)
    if (key === undefined) throw new VaultError('wrong-key', 'that is not the password of the private shelf')
    const changed: ShelfFile = { ...file, slot: await passwordSlot(next, key) }
    await writeJson(this.path, changed)
    this.known = changed
    this.key?.fill(0)
    this.key = key
    return changed
  }

  /** Do away with the shelf itself. Its books are the engine's to take off it first. */
  async remove(): Promise<void> {
    this.lock()
    this.known = undefined
    await removePath(this.path)
  }
}
