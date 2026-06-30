export function isValidMessage(text) {
  if (!text) return false;

  const clean = text.trim();

  // block empty / junk
  if (clean.length < 2) return false;

  // block only emojis or symbols
  if (/^[\p{Emoji}\s]+$/u.test(clean)) return false;

  return true;
}
