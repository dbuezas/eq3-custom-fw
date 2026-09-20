/**
 * ONE class merger, re-exported so both halves of the app use the same one.
 *
 * `shadcn add` writes components that import `cn` from the `cn` package — shadcn's own compiled
 * drop-in for clsx + tailwind-merge — while everything written here imports it from this file. Two
 * implementations of "later Tailwind utilities win" agree until they do not, so this file has none
 * of its own: it points at the package the vendored components already use.
 */
export { cn } from 'cn'
