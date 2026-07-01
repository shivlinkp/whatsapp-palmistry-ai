export function extractFacts(session, text = "") {
  const t = text.toLowerCase();

  // NAME (simple fallback)
  if (!session.name) {
    const cleaned = text
      .replace(/male|female|boy|girl|man|woman/gi, "")
      .replace(/\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}/g, "")
      .trim();

    if (cleaned.length > 2 && cleaned.length < 40) {
      session.name = cleaned.split(",")[0].trim();
    }
  }

  // DOB
  const dob = text.match(/\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}/);
  if (dob && !session.dob) {
    session.dob = dob[0];
  }

  // GENDER
  if (!session.gender) {
    if (t.includes("male")) session.gender = "male";
    if (t.includes("female")) session.gender = "female";
  }

  return session;
}
