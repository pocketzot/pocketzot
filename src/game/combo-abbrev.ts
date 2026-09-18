// Species/job names → the two-letter combo ("Deep Elf" + "Fire Elementalist"
// → "DEFE"). The wire only carries the abbreviation on lobby_entry.char, which
// the server sends for RUNNING games to sockets in the lobby — never for your
// own saved game — so surfaces showing a stored character derive it.
//
// crawl's rule (util/species-gen.py:117, util/job-gen.py:77):
// `short_name` defaults to name[:2]; only the exceptions are declared in
// dat/species/*.yaml / dat/jobs/*.yaml. Same here — the tables hold the
// declared exceptions (trunk ∪ 0.34.1), and an unlisted name (a new species,
// a fork's) takes the default, which is what its yaml most likely says too.

const SPECIES: Record<string, string> = {
  'Armataur': 'At', 'Coglin': 'Co', 'Deep Dwarf': 'DD', 'Deep Elf': 'DE',
  'Demigod': 'Dg', 'Demonspawn': 'Ds', 'Djinni': 'Dj', 'Gale Centaur': 'GC',
  'Gargoyle': 'Gr', 'High Elf': 'HE', 'Hill Orc': 'HO', 'Lava Orc': 'LO',
  'Mayflytaur': 'My', 'Merfolk': 'Mf', 'Meteoran': 'Me', 'Mountain Dwarf': 'MD',
  'Octopode': 'Op', 'Poltergeist': 'Po', 'Revenant': 'Re', 'Sludge Elf': 'SE',
  'Vampire': 'Vp', 'Vine Stalker': 'VS',
}

const JOBS: Record<string, string> = {
  'Air Elementalist': 'AE', 'Chaos Knight': 'CK', 'Cinder Acolyte': 'CA',
  'Conjurer': 'Cj', 'Earth Elementalist': 'EE', 'Fire Elementalist': 'FE',
  'Forgewright': 'Fw', 'Hedge Wizard': 'HW', 'Hexslinger': 'Hs',
  'Ice Elementalist': 'IE', 'Wanderer': 'Wn', 'Warper': 'Wr',
}

// Every coloured draconian ("Red Draconian") declares Dr.
const speciesAbbrev = (name: string): string =>
  SPECIES[name] ?? (/\bDraconian$/.test(name) ? 'Dr' : name.slice(0, 2))

const jobAbbrev = (name: string): string => JOBS[name] ?? name.slice(0, 2)

// Either half may be unknown (the job comes from the welcome line, which a
// capture can miss): a lone species still abbreviates, a lone job does not —
// "FE" alone reads as nothing.
export function comboAbbrev(species?: string, background?: string): string {
  if (!species) return ''
  return speciesAbbrev(species) + (background ? jobAbbrev(background) : '')
}
