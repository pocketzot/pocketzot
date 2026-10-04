// The crypt room's tile strip, baked at build time (vite.config.ts
// cryptStrip): its URL, or null when the build had no offline pack (and
// always under vitest).
declare module 'virtual:crypt-strip' {
  const url: string | null
  export default url
}
