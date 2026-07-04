// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Canonical topic catalog (SPEC §14.1 story topics). This is the SSOT for the
// finite, stable set of subject topics a story may carry — the topic analogue
// of the WS-A moderation reason-code enumeration in `moderation.ts`. Every
// `topic_id` that reaches the wire, the ranking/similarity signals, or the
// PHI narrow-loop tracker MUST resolve to an entry here.
//
// Three properties make topics trustworthy:
//   • UNIQUE  — each real subject is ONE catalog entry with a stable UUID, so
//     the same topic is shared across stories (groupable) instead of a
//     per-story random id.
//   • ACCURATE — a story's TRUSTED `topic_ids` are only ever set by the AI
//     validator (WS-K `classifyStoryTopics`), which confirms each author-
//     proposed topic against the story's actual content. Author picks are
//     PROPOSALS (`proposed_topic_ids`) until validated.
//   • HONEST ABSENCE — a story the validator cannot classify carries the
//     `UNCLASSIFIED` sentinel (below), which similarity/loop consumers EXCLUDE
//     rather than treat as a real shared topic (so unrelated unclassified
//     stories never look like "circling one topic").
//
// The keyword sets are the deterministic classifier's evidence (WS-K
// `classifyTopics`). The classifier reads them from HERE so the catalog stays
// the single source of truth; a real governed model backend swaps in behind
// the same catalog without changing consumers.

/** One catalog topic. `keywords` drives the deterministic validator; the
 *  sentinel carries none and is never author-selectable. */
export interface TopicDefinition {
  /** Stable UUID (never regenerated — it is the cross-story topic identity). */
  readonly id: string;
  /** Human-stable slug (logs, tests, debugging — never the wire identity). */
  readonly slug: string;
  /** Display name shown in the composer picker and topic surfaces. */
  readonly name: string;
  /** Lowercase keyword evidence for the deterministic validator. */
  readonly keywords: readonly string[];
  /** True for the non-subject sentinel (`UNCLASSIFIED`): not author-selectable,
   *  and EXCLUDED from every topic-similarity/loop signal. */
  readonly sentinel?: boolean;
}

/** The sentinel topic id: "topic unknown / not yet validated", NOT a subject.
 *  Similarity consumers (PHI narrow-loop, topic grouping) skip it. */
export const UNCLASSIFIED_TOPIC_ID = '70b1c0de-0000-4000-8000-000000000000';

/**
 * The catalog, in stable registry order. The first entry is the sentinel; the
 * rest are the selectable subject topics. UUIDs are hand-pinned (a `70b1c0de`
 * — "topic" — prefix) so they never collide with content/user ids and never
 * change across deploys.
 */
export const TOPICS: readonly TopicDefinition[] = [
  {
    id: UNCLASSIFIED_TOPIC_ID,
    slug: 'unclassified',
    name: 'Unclassified',
    keywords: [],
    sentinel: true,
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000001',
    slug: 'climate-environment',
    name: 'Climate & Environment',
    keywords: [
      'climate',
      'carbon',
      'emissions',
      'warming',
      'renewable',
      'wildfire',
      'drought',
      'environment',
      'pollution',
      'water',
      'reservoir',
      'river',
    ],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000002',
    slug: 'science-research',
    name: 'Science & Research',
    keywords: ['research', 'study', 'scientists', 'experiment', 'discovery', 'space', 'physics'],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000003',
    slug: 'technology',
    name: 'Technology',
    keywords: ['ai', 'software', 'chip', 'computer', 'internet', 'app', 'algorithm', 'data'],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000004',
    slug: 'health',
    name: 'Health',
    keywords: ['health', 'disease', 'vaccine', 'hospital', 'medical', 'outbreak', 'mental'],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000005',
    slug: 'economy',
    name: 'Economy',
    keywords: ['economy', 'inflation', 'jobs', 'market', 'trade', 'tax', 'budget'],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000006',
    slug: 'government-policy',
    name: 'Government & Policy',
    keywords: ['policy', 'law', 'bill', 'regulation', 'senate', 'congress', 'government'],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000007',
    slug: 'elections-democracy',
    name: 'Elections & Democracy',
    keywords: ['election', 'vote', 'ballot', 'campaign', 'candidate', 'primary', 'referendum'],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000008',
    slug: 'local-community',
    name: 'Local & Community',
    keywords: [
      'city',
      'council',
      'neighborhood',
      'community',
      'county',
      'mayor',
      'zoning',
      'transit',
    ],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000009',
    slug: 'energy',
    name: 'Energy',
    keywords: ['energy', 'power', 'grid', 'solar', 'wind', 'nuclear'],
  },
  {
    id: '70b1c0de-0000-4000-8000-00000000000a',
    slug: 'education',
    name: 'Education',
    keywords: ['education', 'school', 'university', 'student', 'teacher', 'curriculum'],
  },
  {
    id: '70b1c0de-0000-4000-8000-00000000000b',
    slug: 'justice-rights',
    name: 'Justice & Rights',
    keywords: ['justice', 'court', 'police', 'rights', 'prison', 'crime'],
  },
  {
    id: '70b1c0de-0000-4000-8000-00000000000c',
    slug: 'international',
    name: 'International',
    keywords: ['international', 'foreign', 'global', 'diplomacy', 'treaty', 'border'],
  },
  {
    id: '70b1c0de-0000-4000-8000-00000000000d',
    slug: 'culture-society',
    name: 'Culture & Society',
    keywords: ['culture', 'art', 'music', 'film', 'sport', 'media'],
  },
  {
    id: '70b1c0de-0000-4000-8000-00000000000e',
    slug: 'business-industry',
    name: 'Business & Industry',
    keywords: [
      'business',
      'company',
      'corporate',
      'startup',
      'industry',
      'manufacturing',
      'ceo',
      'merger',
      'entrepreneur',
    ],
  },
  {
    id: '70b1c0de-0000-4000-8000-00000000000f',
    slug: 'finance-markets',
    name: 'Finance & Markets',
    keywords: [
      'finance',
      'bank',
      'stocks',
      'investment',
      'investor',
      'fund',
      'bond',
      'currency',
      'interest',
    ],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000010',
    slug: 'sports',
    name: 'Sports',
    keywords: [
      'sports',
      'football',
      'basketball',
      'soccer',
      'olympics',
      'tournament',
      'athlete',
      'league',
      'championship',
    ],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000011',
    slug: 'transportation',
    name: 'Transportation & Infrastructure',
    keywords: [
      'transportation',
      'infrastructure',
      'roads',
      'highway',
      'aviation',
      'airline',
      'rail',
      'railway',
      'traffic',
    ],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000012',
    slug: 'housing',
    name: 'Housing & Real Estate',
    keywords: [
      'housing',
      'rent',
      'mortgage',
      'homeless',
      'tenant',
      'landlord',
      'eviction',
      'property',
      'apartment',
    ],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000013',
    slug: 'immigration',
    name: 'Immigration & Migration',
    keywords: [
      'immigration',
      'immigrant',
      'migrant',
      'asylum',
      'refugee',
      'visa',
      'deportation',
      'citizenship',
      'migration',
    ],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000014',
    slug: 'labor-work',
    name: 'Labor & Work',
    keywords: [
      'labor',
      'union',
      'workers',
      'wages',
      'employment',
      'strike',
      'workplace',
      'unemployment',
      'layoffs',
    ],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000015',
    slug: 'agriculture-food',
    name: 'Agriculture & Food',
    keywords: [
      'agriculture',
      'farming',
      'farmers',
      'crops',
      'food',
      'harvest',
      'livestock',
      'fishery',
      'ranch',
    ],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000016',
    slug: 'military-defense',
    name: 'Military & Defense',
    keywords: [
      'military',
      'defense',
      'army',
      'navy',
      'soldiers',
      'weapons',
      'war',
      'troops',
      'pentagon',
    ],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000017',
    slug: 'religion-belief',
    name: 'Religion & Belief',
    keywords: [
      'religion',
      'church',
      'faith',
      'muslim',
      'christian',
      'jewish',
      'hindu',
      'worship',
      'clergy',
    ],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000018',
    slug: 'weather-disasters',
    name: 'Weather & Disasters',
    keywords: [
      'weather',
      'hurricane',
      'earthquake',
      'flood',
      'storm',
      'tornado',
      'disaster',
      'evacuation',
      'quake',
    ],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000019',
    slug: 'media-journalism',
    name: 'Media & Journalism',
    keywords: [
      'journalism',
      'press',
      'newspaper',
      'broadcast',
      'censorship',
      'reporter',
      'newsroom',
      'editorial',
    ],
  },
  {
    id: '70b1c0de-0000-4000-8000-00000000001a',
    slug: 'crypto-web3',
    name: 'Crypto & Web3',
    keywords: [
      'cryptocurrency',
      'bitcoin',
      'blockchain',
      'crypto',
      'ethereum',
      'stablecoin',
      'defi',
      'mining',
    ],
  },
  {
    id: '70b1c0de-0000-4000-8000-00000000001b',
    slug: 'travel-tourism',
    name: 'Travel & Tourism',
    keywords: [
      'travel',
      'tourism',
      'tourist',
      'vacation',
      'hotel',
      'flight',
      'destination',
      'passport',
    ],
  },
  {
    id: '70b1c0de-0000-4000-8000-00000000001c',
    slug: 'consumer-retail',
    name: 'Consumer & Retail',
    keywords: ['retail', 'shopping', 'consumer', 'brand', 'store', 'ecommerce', 'product', 'sales'],
  },
  {
    id: '70b1c0de-0000-4000-8000-00000000001d',
    slug: 'artificial-intelligence',
    name: 'Artificial Intelligence',
    keywords: [
      'chatbot',
      'llm',
      'agi',
      'generative',
      'neural',
      'robotics',
      'automation',
      'superintelligence',
    ],
  },
  {
    id: '70b1c0de-0000-4000-8000-00000000001e',
    slug: 'social-media',
    name: 'Social Media',
    keywords: [
      'instagram',
      'tiktok',
      'twitter',
      'facebook',
      'influencer',
      'viral',
      'hashtag',
      'feeds',
    ],
  },
  {
    id: '70b1c0de-0000-4000-8000-00000000001f',
    slug: 'privacy-surveillance',
    name: 'Privacy & Surveillance',
    keywords: [
      'privacy',
      'surveillance',
      'tracking',
      'encryption',
      'biometric',
      'spyware',
      'wiretap',
    ],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000020',
    slug: 'cybersecurity',
    name: 'Cybersecurity',
    keywords: [
      'cybersecurity',
      'hacking',
      'ransomware',
      'malware',
      'phishing',
      'exploit',
      'breach',
    ],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000021',
    slug: 'gaming',
    name: 'Gaming',
    keywords: ['gaming', 'esports', 'console', 'playstation', 'xbox', 'nintendo', 'gamer'],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000022',
    slug: 'space-exploration',
    name: 'Space Exploration',
    keywords: ['nasa', 'mars', 'rocket', 'astronaut', 'spacex', 'satellite', 'orbit', 'moon'],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000023',
    slug: 'remote-work',
    name: 'Remote Work',
    keywords: ['remote', 'telework', 'freelance', 'commute', 'coworking', 'hybrid'],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000024',
    slug: 'emerging-tech',
    name: 'Emerging Tech',
    keywords: ['quantum', 'metaverse', 'wearable', 'iot', 'nanotech', 'hologram'],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000025',
    slug: 'electric-vehicles',
    name: 'Electric Vehicles',
    keywords: ['ev', 'charging', 'battery', 'tesla', 'autonomous', 'electric'],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000026',
    slug: 'open-source',
    name: 'Open Source & Software',
    keywords: ['programming', 'developer', 'coding', 'linux', 'github', 'compiler'],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000027',
    slug: 'biotech-genetics',
    name: 'Biotech & Genetics',
    keywords: ['genetics', 'crispr', 'dna', 'genome', 'biotech', 'cloning', 'mutation'],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000028',
    slug: 'neuroscience',
    name: 'Neuroscience',
    keywords: ['neuroscience', 'brain', 'neuron', 'cognition', 'consciousness', 'dopamine'],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000029',
    slug: 'mathematics',
    name: 'Mathematics',
    keywords: ['mathematics', 'geometry', 'algebra', 'calculus', 'theorem', 'probability'],
  },
  {
    id: '70b1c0de-0000-4000-8000-00000000002a',
    slug: 'history',
    name: 'History',
    keywords: [
      'history',
      'ancient',
      'empire',
      'medieval',
      'archaeology',
      'civilization',
      'dynasty',
    ],
  },
  {
    id: '70b1c0de-0000-4000-8000-00000000002b',
    slug: 'language-linguistics',
    name: 'Language & Linguistics',
    keywords: ['language', 'linguistics', 'grammar', 'dialect', 'etymology', 'bilingual'],
  },
  {
    id: '70b1c0de-0000-4000-8000-00000000002c',
    slug: 'psychology',
    name: 'Psychology',
    keywords: [
      'psychology',
      'personality',
      'behavior',
      'emotion',
      'empathy',
      'introvert',
      'narcissism',
    ],
  },
  {
    id: '70b1c0de-0000-4000-8000-00000000002d',
    slug: 'philosophy-ethics',
    name: 'Philosophy & Ethics',
    keywords: ['philosophy', 'ethics', 'morality', 'existentialism', 'stoicism', 'metaphysics'],
  },
  {
    id: '70b1c0de-0000-4000-8000-00000000002e',
    slug: 'conservation-wildlife',
    name: 'Wildlife & Conservation',
    keywords: [
      'wildlife',
      'conservation',
      'extinction',
      'endangered',
      'biodiversity',
      'poaching',
      'habitat',
    ],
  },
  {
    id: '70b1c0de-0000-4000-8000-00000000002f',
    slug: 'oceans',
    name: 'Oceans & Marine Life',
    keywords: ['ocean', 'marine', 'coral', 'reef', 'fisheries', 'tsunami', 'plankton'],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000030',
    slug: 'pollution-waste',
    name: 'Pollution & Waste',
    keywords: ['waste', 'recycling', 'plastic', 'landfill', 'sewage', 'smog'],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000031',
    slug: 'sustainability',
    name: 'Sustainability',
    keywords: [
      'sustainability',
      'compost',
      'biodegradable',
      'reusable',
      'greenwashing',
      'renewables',
    ],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000032',
    slug: 'mental-health',
    name: 'Mental Health',
    keywords: ['anxiety', 'depression', 'therapy', 'burnout', 'stress', 'wellbeing', 'psychiatry'],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000033',
    slug: 'fitness-exercise',
    name: 'Fitness & Exercise',
    keywords: ['fitness', 'exercise', 'workout', 'gym', 'running', 'strength', 'cardio'],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000034',
    slug: 'nutrition-diet',
    name: 'Nutrition & Diet',
    keywords: ['nutrition', 'diet', 'calories', 'protein', 'keto', 'fasting', 'supplement'],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000035',
    slug: 'plant-based',
    name: 'Plant-Based Living',
    keywords: ['vegan', 'vegetarian', 'meatless', 'tofu', 'veganism'],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000036',
    slug: 'sleep',
    name: 'Sleep',
    keywords: ['sleep', 'insomnia', 'circadian', 'melatonin', 'napping', 'dreaming'],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000037',
    slug: 'aging-longevity',
    name: 'Aging & Longevity',
    keywords: ['aging', 'longevity', 'lifespan', 'elderly', 'dementia', 'alzheimers'],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000038',
    slug: 'addiction-recovery',
    name: 'Addiction & Recovery',
    keywords: ['addiction', 'alcoholism', 'sobriety', 'rehab', 'overdose', 'withdrawal'],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000039',
    slug: 'reproductive-rights',
    name: 'Reproductive Rights',
    keywords: [
      'abortion',
      'contraception',
      'pregnancy',
      'reproductive',
      'fertility',
      'miscarriage',
    ],
  },
  {
    id: '70b1c0de-0000-4000-8000-00000000003a',
    slug: 'disease-pandemics',
    name: 'Disease & Pandemics',
    keywords: ['pandemic', 'epidemic', 'virus', 'infection', 'quarantine', 'immunity'],
  },
  {
    id: '70b1c0de-0000-4000-8000-00000000003b',
    slug: 'gender-identity',
    name: 'Gender & Identity',
    keywords: ['gender', 'feminism', 'patriarchy', 'pronouns', 'sexism', 'misogyny'],
  },
  {
    id: '70b1c0de-0000-4000-8000-00000000003c',
    slug: 'race-ethnicity',
    name: 'Race & Ethnicity',
    keywords: ['race', 'racism', 'ethnicity', 'diversity', 'discrimination', 'segregation'],
  },
  {
    id: '70b1c0de-0000-4000-8000-00000000003d',
    slug: 'lgbtq',
    name: 'LGBTQ+',
    keywords: ['lgbtq', 'gay', 'lesbian', 'queer', 'bisexual', 'pride', 'transgender'],
  },
  {
    id: '70b1c0de-0000-4000-8000-00000000003e',
    slug: 'disability-access',
    name: 'Disability & Access',
    keywords: ['disability', 'accessibility', 'wheelchair', 'autism', 'deaf', 'ableism'],
  },
  {
    id: '70b1c0de-0000-4000-8000-00000000003f',
    slug: 'inequality-poverty',
    name: 'Inequality & Poverty',
    keywords: ['inequality', 'poverty', 'welfare', 'redistribution', 'ubi', 'destitution'],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000040',
    slug: 'human-rights',
    name: 'Human Rights',
    keywords: [
      'genocide',
      'slavery',
      'trafficking',
      'torture',
      'freedom',
      'oppression',
      'atrocity',
    ],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000041',
    slug: 'free-speech',
    name: 'Free Speech',
    keywords: ['deplatform', 'dissent', 'expression', 'blasphemy', 'sedition', 'censored'],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000042',
    slug: 'misinformation',
    name: 'Misinformation',
    keywords: [
      'misinformation',
      'disinformation',
      'conspiracy',
      'propaganda',
      'hoax',
      'debunk',
      'rumor',
    ],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000043',
    slug: 'foreign-policy',
    name: 'Foreign Policy',
    keywords: ['sanctions', 'geopolitics', 'nato', 'alliance', 'embassy', 'statecraft'],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000044',
    slug: 'war-conflict',
    name: 'War & Conflict',
    keywords: ['conflict', 'ceasefire', 'insurgency', 'occupation', 'militia', 'bombardment'],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000045',
    slug: 'terrorism',
    name: 'Terrorism & Extremism',
    keywords: ['terrorism', 'extremism', 'radicalization', 'bombing', 'jihad', 'insurgent'],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000046',
    slug: 'protest-activism',
    name: 'Protest & Activism',
    keywords: ['protest', 'activism', 'demonstration', 'boycott', 'uprising', 'marching'],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000047',
    slug: 'corruption',
    name: 'Corruption & Accountability',
    keywords: ['corruption', 'bribery', 'embezzlement', 'whistleblower', 'scandal', 'nepotism'],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000048',
    slug: 'democracy-authoritarianism',
    name: 'Democracy & Authoritarianism',
    keywords: ['authoritarianism', 'dictatorship', 'autocracy', 'populism', 'fascism', 'tyranny'],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000049',
    slug: 'political-ideology',
    name: 'Political Ideology',
    keywords: [
      'capitalism',
      'socialism',
      'marxism',
      'communism',
      'libertarian',
      'conservatism',
      'liberalism',
    ],
  },
  {
    id: '70b1c0de-0000-4000-8000-00000000004a',
    slug: 'globalization-trade',
    name: 'Globalization & Trade',
    keywords: ['globalization', 'tariff', 'offshoring', 'wto', 'protectionism', 'imports'],
  },
  {
    id: '70b1c0de-0000-4000-8000-00000000004b',
    slug: 'law-legal',
    name: 'Law & Legal Issues',
    keywords: ['lawsuit', 'litigation', 'attorney', 'verdict', 'jury', 'precedent', 'statute'],
  },
  {
    id: '70b1c0de-0000-4000-8000-00000000004c',
    slug: 'crime-safety',
    name: 'Crime & Public Safety',
    keywords: ['homicide', 'robbery', 'gang', 'shooting', 'felony', 'forensics'],
  },
  {
    id: '70b1c0de-0000-4000-8000-00000000004d',
    slug: 'gun-policy',
    name: 'Gun Policy',
    keywords: ['guns', 'firearm', 'ammunition', 'nra', 'rifle', 'handgun'],
  },
  {
    id: '70b1c0de-0000-4000-8000-00000000004e',
    slug: 'drug-policy',
    name: 'Drug Policy',
    keywords: [
      'cannabis',
      'marijuana',
      'legalization',
      'decriminalization',
      'psychedelics',
      'narcotics',
    ],
  },
  {
    id: '70b1c0de-0000-4000-8000-00000000004f',
    slug: 'criminal-justice-reform',
    name: 'Criminal Justice Reform',
    keywords: ['incarceration', 'parole', 'recidivism', 'sentencing', 'rehabilitation', 'clemency'],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000050',
    slug: 'personal-finance',
    name: 'Personal Finance',
    keywords: ['budgeting', 'savings', 'frugality', 'retirement', 'paycheck', 'debt'],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000051',
    slug: 'entrepreneurship',
    name: 'Entrepreneurship',
    keywords: [
      'entrepreneurship',
      'bootstrapping',
      'franchise',
      'solopreneur',
      'hustle',
      'founder',
    ],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000052',
    slug: 'venture-startups',
    name: 'Startups & Venture Capital',
    keywords: ['startup', 'unicorn', 'accelerator', 'valuation', 'funding', 'vc'],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000053',
    slug: 'taxes-spending',
    name: 'Taxes & Public Spending',
    keywords: ['taxation', 'deficit', 'subsidy', 'austerity', 'fiscal', 'entitlement'],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000054',
    slug: 'film-tv',
    name: 'Film & Television',
    keywords: ['cinema', 'movie', 'television', 'netflix', 'series', 'hollywood', 'documentary'],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000055',
    slug: 'music',
    name: 'Music',
    keywords: ['album', 'concert', 'band', 'spotify', 'melody', 'guitar', 'songwriter'],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000056',
    slug: 'books-literature',
    name: 'Books & Literature',
    keywords: ['books', 'literature', 'novel', 'author', 'poetry', 'fiction', 'publishing'],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000057',
    slug: 'art-design',
    name: 'Art & Design',
    keywords: ['painting', 'sculpture', 'gallery', 'illustration', 'aesthetics', 'museum'],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000058',
    slug: 'architecture',
    name: 'Architecture',
    keywords: ['architecture', 'building', 'urbanism', 'skyscraper', 'blueprint', 'facade'],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000059',
    slug: 'fashion-style',
    name: 'Fashion & Style',
    keywords: ['fashion', 'clothing', 'style', 'runway', 'apparel', 'streetwear', 'couture'],
  },
  {
    id: '70b1c0de-0000-4000-8000-00000000005a',
    slug: 'food-cooking',
    name: 'Food & Cooking',
    keywords: ['cooking', 'recipe', 'cuisine', 'chef', 'baking', 'culinary', 'foodie'],
  },
  {
    id: '70b1c0de-0000-4000-8000-00000000005b',
    slug: 'celebrity-pop',
    name: 'Celebrity & Pop Culture',
    keywords: ['celebrity', 'gossip', 'fandom', 'tabloid', 'paparazzi', 'stardom'],
  },
  {
    id: '70b1c0de-0000-4000-8000-00000000005c',
    slug: 'comedy-humor',
    name: 'Comedy & Humor',
    keywords: ['comedy', 'humor', 'comedian', 'satire', 'meme', 'sitcom'],
  },
  {
    id: '70b1c0de-0000-4000-8000-00000000005d',
    slug: 'photography',
    name: 'Photography',
    keywords: ['photography', 'camera', 'lens', 'portrait', 'exposure', 'composition'],
  },
  {
    id: '70b1c0de-0000-4000-8000-00000000005e',
    slug: 'relationships-dating',
    name: 'Relationships & Dating',
    keywords: ['relationship', 'dating', 'marriage', 'romance', 'heartbreak', 'intimacy'],
  },
  {
    id: '70b1c0de-0000-4000-8000-00000000005f',
    slug: 'parenting-family',
    name: 'Parenting & Family',
    keywords: [
      'parenting',
      'children',
      'motherhood',
      'fatherhood',
      'toddler',
      'childcare',
      'adoption',
    ],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000060',
    slug: 'productivity-habits',
    name: 'Productivity & Habits',
    keywords: ['productivity', 'habits', 'motivation', 'procrastination', 'discipline', 'routine'],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000061',
    slug: 'self-improvement',
    name: 'Self-Improvement',
    keywords: ['mindset', 'confidence', 'growth', 'journaling', 'resilience', 'ambition'],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000062',
    slug: 'minimalism',
    name: 'Minimalism & Consumerism',
    keywords: ['minimalism', 'consumerism', 'declutter', 'materialism', 'frugal', 'tidying'],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000063',
    slug: 'pets-animals',
    name: 'Pets & Animals',
    keywords: ['pets', 'dogs', 'cats', 'veterinary', 'puppy', 'kitten', 'breeds'],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000064',
    slug: 'gardening-diy',
    name: 'Gardening & DIY',
    keywords: ['gardening', 'diy', 'woodworking', 'renovation', 'planting', 'handyman'],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000065',
    slug: 'outdoors-adventure',
    name: 'Outdoors & Adventure',
    keywords: ['hiking', 'camping', 'backpacking', 'climbing', 'wilderness', 'trail', 'kayaking'],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000066',
    slug: 'spirituality',
    name: 'Spirituality & Mindfulness',
    keywords: ['spirituality', 'meditation', 'mindfulness', 'yoga', 'enlightenment', 'astrology'],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000067',
    slug: 'automotive',
    name: 'Automotive & Cars',
    keywords: ['automotive', 'vehicle', 'engine', 'racing', 'motorcycle', 'sedan'],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000068',
    slug: 'science-fiction',
    name: 'Science Fiction & Futurism',
    keywords: ['dystopia', 'utopia', 'cyberpunk', 'singularity', 'futurism', 'android'],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000069',
    slug: 'online-learning',
    name: 'Online Learning & EdTech',
    keywords: ['mooc', 'edtech', 'homeschool', 'tutoring', 'certification', 'coursework'],
  },
  {
    id: '70b1c0de-0000-4000-8000-00000000006a',
    slug: 'happiness-meaning',
    name: 'Happiness & Meaning',
    keywords: ['happiness', 'fulfillment', 'purpose', 'contentment', 'gratitude', 'joy'],
  },
  {
    id: '70b1c0de-0000-4000-8000-00000000006b',
    slug: 'charity-philanthropy',
    name: 'Charity & Philanthropy',
    keywords: ['charity', 'philanthropy', 'donation', 'nonprofit', 'volunteer', 'fundraising'],
  },
] as const;

/** Author-selectable subject topics (everything except the sentinel) — the
 *  composer picker's option list. */
export const SELECTABLE_TOPICS: readonly TopicDefinition[] = TOPICS.filter(
  (t) => t.sentinel !== true,
);

const TOPIC_BY_ID: ReadonlyMap<string, TopicDefinition> = new Map(TOPICS.map((t) => [t.id, t]));

/** slug → id (stable references for seeds/tests without hard-coding UUIDs). */
export const TOPIC_ID_BY_SLUG: ReadonlyMap<string, string> = new Map(
  TOPICS.map((t) => [t.slug, t.id]),
);

/** Resolve a topic id by slug; throws on an unknown slug (a programming error
 *  in a seed/test, never runtime user input). */
export function topicIdForSlug(slug: string): string {
  const id = TOPIC_ID_BY_SLUG.get(slug);
  if (id === undefined) throw new Error(`unknown topic slug '${slug}'`);
  return id;
}

/** All catalog topic ids (incl. the sentinel). */
export const TOPIC_IDS: readonly string[] = TOPICS.map((t) => t.id);

/** Look up a topic definition by id (undefined for unknown ids). */
export function topicById(id: string): TopicDefinition | undefined {
  return TOPIC_BY_ID.get(id);
}

/** Whether a string is any catalog topic id (subject OR sentinel). */
export function isTopicId(value: string): boolean {
  return TOPIC_BY_ID.has(value);
}

/** Whether an id is the non-subject `UNCLASSIFIED` sentinel. Similarity/loop
 *  consumers call this to EXCLUDE it (an unclassified story is not "similar"
 *  to anything). */
export function isSentinelTopicId(value: string): boolean {
  return value === UNCLASSIFIED_TOPIC_ID;
}

/** Whether an id is an author-SELECTABLE subject topic (a real catalog topic,
 *  not the sentinel). The trust boundary for author proposals. */
export function isSelectableTopicId(value: string): boolean {
  const topic = TOPIC_BY_ID.get(value);
  return topic !== undefined && topic.sentinel !== true;
}

/** Max author-proposed topics per submission (keeps proposals focused; the
 *  validator may still add a bounded number of its own). */
export const MAX_PROPOSED_TOPICS = 5;

/** id → keyword evidence, for the deterministic validator (sentinel omitted —
 *  it has no keywords and can never be validated INTO). */
export const TOPIC_KEYWORDS: ReadonlyMap<string, readonly string[]> = new Map(
  SELECTABLE_TOPICS.map((t) => [t.id, t.keywords]),
);
