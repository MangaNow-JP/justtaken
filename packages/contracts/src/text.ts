// Use the same Unicode rules on Hermes, web, and Workers. Hermes does not expose
// Intl.Segmenter; using string.length would miscount Japanese marks and emoji.
export { countGraphemes } from 'unicode-segmenter/grapheme';
export const profileBioMaxGraphemes = 160;
