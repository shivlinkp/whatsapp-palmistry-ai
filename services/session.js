export function sessionMissingInfo(session) {
  if (!session.name) return "Please share your Name";
  if (!session.dob) return "Please share your Date of Birth";
  if (!session.gender) return "Please share your Gender";
  return null;
}
