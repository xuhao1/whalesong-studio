// SPDX-License-Identifier: LGPL-3.0-or-later
/** Build-time constants injected by scripts/build.mjs. */
declare const __NOVEL_VERSION__: string
declare const __NOVEL_PACKAGE__: string

declare module '*.css' {
  const text: string
  export default text
}
