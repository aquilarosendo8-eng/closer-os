let locks = 0
let originalOverflow = ''

/** Nested dialogs release independently, including simultaneous auth/scope unmounts. */
export function lockDialogScroll(): () => void {
  if (locks === 0) originalOverflow = document.body.style.overflow
  locks += 1
  document.body.style.overflow = 'hidden'
  let released = false
  return () => {
    if (released) return
    released = true
    locks -= 1
    if (locks === 0) document.body.style.overflow = originalOverflow
  }
}
