// Prints share links for the demo beats, as a markdown table for the README.
// Run with: npm run demos [-- base-url]

import { DEMOS } from '../src/core/demos';
import { beatUrl } from '../src/core/share';

const base = process.argv[2] ?? 'https://aubergine-ux.github.io/loopwell/';
console.log('| Beat | Style | Link |\n| :-- | :-- | :-- |');
for (const d of DEMOS) console.log(`| **${d.name}** | ${d.blurb} | [▶ Play it](${beatUrl(d.make(), base)}) |`);
