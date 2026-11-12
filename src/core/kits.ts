// Built-in drum kits. Every sound is synthesised by scripts/build-kits.ts and
// released as CC0, so there is nothing to license or attribute.

export const SLOTS = ['kick', 'snare', 'clap', 'hat', 'open', 'tom', 'rim', 'perc', 'crash', 'sub'] as const;
export type Slot = (typeof SLOTS)[number];

export interface Kit {
  id: string;
  name: string;
  blurb: string;
  /** Display names for slots that differ from the default. */
  names?: Partial<Record<Slot, string>>;
}

export const KITS: Kit[] = [
  { id: 'boom', name: 'Boom', blurb: 'Round analog lows, snappy tops', names: { perc: 'cowbell' } },
  { id: 'punch', name: 'Punch', blurb: 'Tight, bright and loud', names: { perc: 'shaker' } },
  { id: 'dust', name: 'Dust', blurb: 'Crunchy, dusty, lo-fi', names: { perc: 'conga', clap: 'snap', crash: 'ride' } },
  { id: 'glass', name: 'Glass', blurb: 'Digital FM percussion', names: { perc: 'bell', kick: 'zap' } },
];

/** General MIDI drum notes, used for MIDI export and as pad-controller defaults. */
export const GM_NOTE: Record<Slot, number> = {
  kick: 36, snare: 38, clap: 39, hat: 42, open: 46, tom: 45, rim: 37, perc: 56, crash: 49, sub: 35,
};

export const isBuiltin = (id: string) => {
  const [k, s] = id.split('/');
  return KITS.some((x) => x.id === k) && (SLOTS as readonly string[]).includes(s);
};
export const isUser = (id: string) => id.startsWith('user/');
export const sampleUrl = (id: string) => `kits/${id}.wav`;

export function slotLabel(id: string): string {
  const [k, s] = id.split('/') as [string, Slot];
  return KITS.find((x) => x.id === k)?.names?.[s] ?? s;
}

/** All built-in sample ids, kit by kit. */
export const ALL_SAMPLES: string[] = KITS.flatMap((k) => SLOTS.map((s) => `${k.id}/${s}`));
