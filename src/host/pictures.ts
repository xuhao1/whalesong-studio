// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Pictures on their way to a model, the way DSH sends them: each is handed to
 * DSH's attachment service, which checks and keeps it, and goes into the
 * message as a reference to what was kept. The provider's adapter turns that
 * into whatever its endpoint takes; nothing of that is the Studio's business.
 */
import type { Context } from '@deepseek-ai/cordis'
import { LlmCallError, type LlmImage } from '../core/llm'

/** What the attachment service is asked for here; declared so that a DSH without the service is told apart at run time, not at build time. */
interface Attachments {
  saveImages(inputs: readonly { data: Uint8Array; mediaType: LlmImage['mediaType']; name?: string }[]): Promise<readonly unknown[]>
}

/** An image block of a message, as DSH's models take it. */
export interface ImageBlock {
  type: 'image'
  attachment: unknown
}

/**
 * Hand pictures to DSH and get the blocks that carry them in a message, in the order given.
 * @throws LlmCallError where this DSH keeps no attachments, or refuses a picture (too large, not a picture).
 */
export async function imageBlocks(ctx: Context, images: readonly LlmImage[] | undefined): Promise<ImageBlock[]> {
  if (images === undefined || images.length === 0) return []
  const store = (ctx as unknown as { get(name: string): unknown }).get('attachments') as Attachments | undefined
  if (store === undefined) throw new LlmCallError('this DSH has no attachment service (@deepseek-ai/dsh-attachment-local): pictures cannot be sent to a model', 'NO_ATTACHMENTS')
  try {
    const refs = await store.saveImages(images.map(image => ({ data: image.data, mediaType: image.mediaType, ...(image.name !== undefined && image.name.length > 0 ? { name: image.name } : {}) })))
    return refs.map(attachment => ({ type: 'image' as const, attachment }))
  } catch (error) {
    throw new LlmCallError(`DSH did not take a picture: ${error instanceof Error ? error.message : String(error)}`, 'IMAGE_REFUSED')
  }
}
