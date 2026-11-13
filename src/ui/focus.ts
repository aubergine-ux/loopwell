// How did an element come to have focus: was it clicked or touched, or did the keyboard put focus there?
// The editors (step grid, piano roll, timeline) have arrow-key controls of their own for people working
// without a pointer. Someone who has just clicked a step still expects the arrow keys to pick tracks and
// patterns, as they always have, so those controls only apply when focus arrived by keyboard.
// (:focus-visible can't be used for this: browsers switch it on at the first key press whatever came before.)

let pointer = false;
const arrived = new WeakMap<EventTarget, boolean>();

if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', () => { pointer = true; }, true);
  document.addEventListener('keydown', () => { pointer = false; }, true);
  // the keydown above runs before any focus it causes, and a click's pointerdown before the focus it causes
  document.addEventListener('focusin', (e) => { if (e.target) arrived.set(e.target, !pointer); }, true);
}

/** Did the keyboard (or a script acting for it) put focus on this element? */
export const byKeyboard = (el: EventTarget | null): boolean => !!el && arrived.get(el) === true;
