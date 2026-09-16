// ---------------------------------------------------------------------------
// The house-plant directory
//
// Brendan: "plant watering timer, say the plant time and it will use a
// directory's saved on the server with house plants and optimal watering times".
//
// So the shape is a LOOKUP: a player names a plant, and the server answers with
// how often it wants water. This module is the directory and the lookup; the
// timer that counts the days is W1's, and the callable in index.ts is the only
// thing that serves it.
//
// 🔑 SERVER-SIDE BECAUSE THE NUMBER IS ADVERTISED, and because it must be
// correctable without an app release. A watering interval is a claim the app
// makes to a player about a living thing they own — getting it wrong kills the
// plant, and "wait for the next TestFlight build" is not an acceptable latency
// for fixing it.
//
// ⚠️ THESE INTERVALS ARE GUIDANCE, NOT HORTICULTURE, AND THE APP MUST SAY SO.
// Every number below is a temperate-indoor, average-pot, growing-season
// default. Real demand swings with light, pot size, humidity, season and
// whether the thing is root-bound — a snake plant in a dim winter room can go a
// month, and the same plant in a bright July window wants water in ten days. The
// range is carried alongside the interval precisely so a UI can show that this
// is a starting point rather than an instruction, and `wateringIntervalDays` is
// a DEFAULT the player is expected to adjust, never a fact about their plant.
//
// 📌 The plant PROP is already real and sits in all four default houses
// (`room_catalogue.dart:215, 335`). This is not art work and must not be sent
// to W3.
// ---------------------------------------------------------------------------

/** One species a player can name. */
export interface PlantSpecies {
  /** Stable key. Never renamed — a saved timer references it. */
  id: string;
  /** What the app calls it. */
  commonName: string;
  /**
   * Everything else a player might say, lowercase and already normalised.
   *
   * 🔑 THE POINT OF THE DIRECTORY. "say the plant" means the input is whatever
   * a person calls it, not a menu selection — so `devil's ivy`, `pothos` and
   * `epipremnum` must all reach the same row. The Latin name is included for
   * anyone reading a nursery label.
   *
   * ⚠️ An alias may not be shared between two species; `validatePlantDirectory`
   * refuses that, because an ambiguous lookup would silently pick whichever row
   * came first and then advertise the wrong interval.
   */
  aliases: string[];
  /** The advertised default, in days. */
  wateringIntervalDays: number;
  /** Plausible span for the same plant in different conditions, in days. */
  wateringIntervalRange: [number, number];
  light: 'low' | 'medium' | 'bright-indirect' | 'direct';
  /** One line a UI can show under the number. */
  note: string;
}

/**
 * The bundled directory.
 *
 * A deliberately small, common set rather than an encyclopedia: every row here
 * is a plant somebody actually keeps on a windowsill, and a directory nobody
 * has checked is worse than a short one. Extending it is a data edit plus a
 * deploy — see `getPlantDirectory` for the override path that avoids even that.
 */
export const PLANT_DIRECTORY: PlantSpecies[] = [
  {
    id: 'snake_plant',
    commonName: 'Snake plant',
    aliases: ['snake plant', 'sansevieria', 'dracaena trifasciata', 'mother in laws tongue'],
    wateringIntervalDays: 17,
    wateringIntervalRange: [14, 28],
    light: 'low',
    note: 'Stores water in its leaves. Far more houseplants die of kindness than of thirst, and this is the one that dies of it fastest.',
  },
  {
    id: 'zz_plant',
    commonName: 'ZZ plant',
    aliases: ['zz plant', 'zz', 'zamioculcas', 'zamioculcas zamiifolia', 'zanzibar gem'],
    wateringIntervalDays: 17,
    wateringIntervalRange: [14, 28],
    light: 'low',
    note: 'Rhizomes underground hold weeks of water. Let it dry out completely first.',
  },
  {
    id: 'pothos',
    commonName: 'Pothos',
    aliases: ['pothos', 'devils ivy', "devil's ivy", 'epipremnum', 'epipremnum aureum', 'golden pothos'],
    wateringIntervalDays: 8,
    wateringIntervalRange: [7, 14],
    light: 'medium',
    note: 'Droops visibly when thirsty and recovers within hours — the most forgiving plant to learn on.',
  },
  {
    id: 'monstera',
    commonName: 'Monstera',
    aliases: ['monstera', 'monstera deliciosa', 'swiss cheese plant', 'split leaf philodendron'],
    wateringIntervalDays: 9,
    wateringIntervalRange: [7, 14],
    light: 'bright-indirect',
    note: 'Water when the top two inches are dry. Yellow lower leaves usually mean too much, not too little.',
  },
  {
    id: 'philodendron',
    commonName: 'Philodendron',
    aliases: ['philodendron', 'heartleaf philodendron', 'philodendron hederaceum'],
    wateringIntervalDays: 8,
    wateringIntervalRange: [7, 12],
    light: 'medium',
    note: 'Happy in less light than most. Let the top inch dry between drinks.',
  },
  {
    id: 'peace_lily',
    commonName: 'Peace lily',
    aliases: ['peace lily', 'spathiphyllum'],
    wateringIntervalDays: 6,
    wateringIntervalRange: [4, 9],
    light: 'medium',
    note: 'Dramatic — it wilts flat to tell you, then stands back up an hour after watering.',
  },
  {
    id: 'spider_plant',
    commonName: 'Spider plant',
    aliases: ['spider plant', 'chlorophytum', 'chlorophytum comosum', 'airplane plant'],
    wateringIntervalDays: 7,
    wateringIntervalRange: [5, 12],
    light: 'bright-indirect',
    note: 'Brown leaf tips usually mean tap-water fluoride rather than a watering mistake.',
  },
  {
    id: 'fiddle_leaf_fig',
    commonName: 'Fiddle leaf fig',
    aliases: ['fiddle leaf fig', 'fiddle leaf', 'ficus lyrata'],
    wateringIntervalDays: 9,
    wateringIntervalRange: [7, 14],
    light: 'bright-indirect',
    note: 'Hates being moved and hates wet feet. Pick one spot and keep to a rhythm.',
  },
  {
    id: 'rubber_plant',
    commonName: 'Rubber plant',
    aliases: ['rubber plant', 'rubber tree', 'ficus elastica'],
    wateringIntervalDays: 9,
    wateringIntervalRange: [7, 14],
    light: 'bright-indirect',
    note: 'Wants less in winter — closer to a fortnight when the light drops.',
  },
  {
    id: 'aloe_vera',
    commonName: 'Aloe vera',
    aliases: ['aloe', 'aloe vera'],
    wateringIntervalDays: 17,
    wateringIntervalRange: [14, 28],
    light: 'direct',
    note: 'A succulent. Soak it thoroughly, then leave it completely alone until dry.',
  },
  {
    id: 'jade_plant',
    commonName: 'Jade plant',
    aliases: ['jade', 'jade plant', 'crassula', 'crassula ovata', 'money plant'],
    wateringIntervalDays: 17,
    wateringIntervalRange: [14, 28],
    light: 'direct',
    note: 'Wrinkled leaves mean thirsty; soft mushy ones mean it has had far too much.',
  },
  {
    id: 'succulent',
    commonName: 'Succulent',
    aliases: ['succulent', 'echeveria', 'haworthia', 'cactus', 'sedum'],
    wateringIntervalDays: 18,
    wateringIntervalRange: [14, 35],
    light: 'direct',
    note: 'A catch-all row. If you know the exact species, it will want its own rhythm.',
  },
  {
    id: 'calathea',
    commonName: 'Calathea',
    aliases: ['calathea', 'prayer plant', 'maranta', 'goeppertia'],
    wateringIntervalDays: 5,
    wateringIntervalRange: [4, 8],
    light: 'medium',
    note: 'Fussy about dryness and about tap water. Likes humidity more than it likes a big drink.',
  },
  {
    id: 'boston_fern',
    commonName: 'Boston fern',
    aliases: ['boston fern', 'fern', 'nephrolepis'],
    wateringIntervalDays: 4,
    wateringIntervalRange: [2, 6],
    light: 'medium',
    note: 'The thirstiest thing on this list — it wants to stay damp, never soggy, and never dry.',
  },
  {
    id: 'orchid',
    commonName: 'Orchid',
    aliases: ['orchid', 'phalaenopsis', 'moth orchid'],
    wateringIntervalDays: 7,
    wateringIntervalRange: [7, 12],
    light: 'bright-indirect',
    note: 'Grown in bark, not soil. Water the roots heavily, then let them go silver-grey again.',
  },
  {
    id: 'dracaena',
    commonName: 'Dracaena',
    aliases: ['dracaena', 'dragon tree', 'dracaena marginata', 'corn plant'],
    wateringIntervalDays: 12,
    wateringIntervalRange: [10, 21],
    light: 'medium',
    note: 'Slow and tolerant. Underwatering is much easier to recover from than the reverse.',
  },
  {
    id: 'chinese_evergreen',
    commonName: 'Chinese evergreen',
    aliases: ['chinese evergreen', 'aglaonema'],
    wateringIntervalDays: 9,
    wateringIntervalRange: [7, 14],
    light: 'low',
    note: 'One of the few that genuinely does well in a dim corner.',
  },
  {
    id: 'english_ivy',
    commonName: 'English ivy',
    aliases: ['english ivy', 'ivy', 'hedera', 'hedera helix'],
    wateringIntervalDays: 6,
    wateringIntervalRange: [5, 10],
    light: 'medium',
    note: 'Likes to stay slightly damp and cool. Dry air brings spider mites.',
  },
  {
    id: 'bird_of_paradise',
    commonName: 'Bird of paradise',
    aliases: ['bird of paradise', 'strelitzia'],
    wateringIntervalDays: 8,
    wateringIntervalRange: [7, 12],
    light: 'direct',
    note: 'Big leaves, big thirst in summer. Splits in the leaves are normal, not damage.',
  },
  {
    id: 'basil',
    commonName: 'Basil',
    aliases: ['basil', 'ocimum basilicum', 'herb'],
    wateringIntervalDays: 2,
    wateringIntervalRange: [1, 3],
    light: 'direct',
    note: 'A kitchen herb rather than a houseplant — near-daily in summer, and it wilts fast.',
  },
];

/**
 * Folds a spoken or typed plant name into its lookup form.
 *
 * Lowercases, strips accents and punctuation, and collapses whitespace, so
 * `"Devil's Ivy"`, `"devils ivy"` and `"  DEVILS   IVY "` all agree. Kept
 * deliberately blunt: a fuzzy matcher that guessed would hand somebody a
 * watering schedule for a different plant, which is worse than saying "not
 * found" and letting them pick.
 */
export function normalisePlantName(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Finds the species a player named, or null.
 *
 * Exact match on the normalised id, common name, or any alias — in that order,
 * though the order cannot matter while `validatePlantDirectory` refuses
 * duplicate aliases. Returns null rather than a best guess.
 */
export function findPlant(
  query: string,
  directory: readonly PlantSpecies[] = PLANT_DIRECTORY,
): PlantSpecies | null {
  const q = normalisePlantName(query);
  if (!q) return null;

  for (const plant of directory) {
    if (normalisePlantName(plant.id.replace(/_/g, ' ')) === q) return plant;
    if (normalisePlantName(plant.commonName) === q) return plant;
    if (plant.aliases.some((a) => normalisePlantName(a) === q)) return plant;
  }
  return null;
}

/**
 * Everything wrong with a directory, as sentences.
 *
 * 🔑 VALIDATED BEFORE IT IS SERVED, NOT WHEN IT IS AUTHORED, and for the same
 * reason `rotateWeeklyOffer` validates an offer before publishing it: the
 * override document below can be edited in the Firebase console by a human,
 * and a console edit passes through no test, no review and no deploy. Catching
 * a duplicate alias here costs nothing; catching it after a player has watered
 * a fern on a cactus schedule costs a plant.
 *
 * Total over a malformed shape — it reports what is missing rather than
 * assuming the fields exist — so a bad override surfaces as a problem string
 * instead of a crash.
 */
export function validatePlantDirectory(directory: readonly unknown[]): string[] {
  const problems: string[] = [];
  const seenIds = new Set<string>();
  const seenAliases = new Map<string, string>();

  if (directory.length === 0) return ['directory is empty'];

  directory.forEach((raw, i) => {
    const p = raw as Partial<PlantSpecies> | null;
    const where = `entry ${i}`;
    if (p == null || typeof p !== 'object') {
      problems.push(`${where} is not an object`);
      return;
    }
    if (!p.id) problems.push(`${where} has no id`);
    if (!p.commonName) problems.push(`${where} (${p.id ?? '?'}) has no commonName`);

    if (p.id) {
      if (seenIds.has(p.id)) problems.push(`duplicate id '${p.id}'`);
      seenIds.add(p.id);
    }

    const days = p.wateringIntervalDays;
    if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0) {
      problems.push(`${where} (${p.id ?? '?'}) has no usable wateringIntervalDays`);
    }

    const range = p.wateringIntervalRange;
    if (!Array.isArray(range) || range.length !== 2) {
      problems.push(`${where} (${p.id ?? '?'}) has no wateringIntervalRange`);
    } else {
      const [lo, hi] = range;
      if (lo > hi) problems.push(`${p.id ?? where} range is inverted (${lo} > ${hi})`);
      if (typeof days === 'number' && (days < lo || days > hi)) {
        // The advertised number sitting outside its own plausible span is the
        // error a hand edit actually makes: someone changes the interval and
        // leaves the range describing the old one.
        problems.push(`${p.id ?? where} interval ${days} is outside its range ${lo}-${hi}`);
      }
    }

    for (const alias of p.aliases ?? []) {
      const key = normalisePlantName(alias);
      if (!key) {
        problems.push(`${p.id ?? where} has an empty alias`);
        continue;
      }
      const owner = seenAliases.get(key);
      if (owner != null && owner !== p.id) {
        // 🔴 The one that makes a lookup lie. Two species answering to the same
        // word means whichever is listed first wins, silently.
        problems.push(`alias '${alias}' is claimed by both '${owner}' and '${p.id}'`);
      }
      seenAliases.set(key, p.id ?? where);
    }
  });

  return problems;
}
