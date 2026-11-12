// Readouts shown on a knob while it is being turned.
export const pan = (v: number) => (v === 0 ? 'C' : v < 0 ? `L${-v}` : `R${v}`);
export const filter = (v: number) => (v === 0 ? 'OFF' : v < 0 ? `LP ${-v}` : `HP ${v}`);
export const semis = (v: number) => (v > 0 ? `+${v}` : `${v}`);
export const decay = (v: number) => (v >= 127 ? 'FULL' : `${v}`);
