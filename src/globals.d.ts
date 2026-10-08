// SPDX-License-Identifier: LGPL-3.0-or-later
/** Build-time constants injected by scripts/build.mjs. */
declare const __NOVEL_VERSION__: string
declare const __NOVEL_PACKAGE__: string
/** The licence the package is published under, as `package.json` names it. */
declare const __NOVEL_LICENSE__: string

declare module '*.css' {
  const text: string
  export default text
}

/** A picture bundled with the browser half, as a data URL. */
declare module '*.png' {
  const url: string
  export default url
}

declare module '*.webp' {
  const url: string
  export default url
}
