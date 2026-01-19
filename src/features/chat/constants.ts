/**
 * Constants for the chat feature.
 */

/** iFlow logo SVG configuration - brush stroke smiley face. */
export const LOGO_SVG = {
  viewBox: '0 0 100 100',
  width: '18',
  height: '18',
  // iFlow logo: brush stroke circle with eyes and tail blob
  paths: [
    // Top arc brush stroke
    { d: 'M78 22C68 12 56 8 44 10C32 12 22 20 16 32C12 42 12 54 16 64', stroke: true, strokeWidth: '12' },
    // Bottom left arc
    { d: 'M16 64C20 74 28 82 40 86', stroke: true, strokeWidth: '11' },
    // Right side arc
    { d: 'M65 85C75 82 82 74 86 64C90 52 88 40 82 30C78 24 78 22 78 22', stroke: true, strokeWidth: '10' },
  ],
  // Tail blob
  ellipse: { cx: '78', cy: '78', rx: '14', ry: '12' },
  // Eyes
  eyes: [
    { x: '34', y: '38', width: '10', height: '22', rx: '5' },
    { x: '56', y: '38', width: '10', height: '22', rx: '5' },
  ],
  fill: '#7c5cff',
} as const;

/** Random flavor texts shown while Claude is thinking. */
export const FLAVOR_TEXTS = [
  // Classic
  'Thinking...',
  'Pondering...',
  'Processing...',
  'Analyzing...',
  'Considering...',
  'Working on it...',
  'One moment...',
  'On it...',
  // Thoughtful
  'Ruminating...',
  'Contemplating...',
  'Reflecting...',
  'Mulling it over...',
  'Let me think...',
  'Hmm...',
  'Cogitating...',
  'Deliberating...',
  'Weighing options...',
  'Gathering thoughts...',
  // Playful
  'Brewing ideas...',
  'Connecting dots...',
  'Assembling thoughts...',
  'Spinning up neurons...',
  'Loading brilliance...',
  'Consulting the oracle...',
  'Summoning knowledge...',
  'Crunching thoughts...',
  'Dusting off neurons...',
  'Wrangling ideas...',
  'Herding thoughts...',
  'Juggling concepts...',
  'Untangling this...',
  'Piecing it together...',
  // Cozy
  'Sipping coffee...',
  'Warming up...',
  'Getting cozy with this...',
  'Settling in...',
  'Making tea...',
  'Grabbing a snack...',
  // Technical
  'Parsing...',
  'Compiling thoughts...',
  'Running inference...',
  'Querying the void...',
  'Defragmenting brain...',
  'Allocating memory...',
  'Optimizing...',
  'Indexing...',
  'Syncing neurons...',
  // Zen
  'Breathing...',
  'Finding clarity...',
  'Channeling focus...',
  'Centering...',
  'Aligning chakras...',
  'Meditating on this...',
  // Whimsical
  'Asking the stars...',
  'Reading tea leaves...',
  'Shaking the magic 8-ball...',
  'Consulting ancient scrolls...',
  'Decoding the matrix...',
  'Communing with the ether...',
  'Peering into the abyss...',
  'Channeling the cosmos...',
  // Action
  'Diving in...',
  'Rolling up sleeves...',
  'Getting to work...',
  'Tackling this...',
  'On the case...',
  'Investigating...',
  'Exploring...',
  'Digging deeper...',
  // Casual
  'Bear with me...',
  'Hang tight...',
  'Just a sec...',
  'Working my magic...',
  'Almost there...',
  'Give me a moment...',
];
