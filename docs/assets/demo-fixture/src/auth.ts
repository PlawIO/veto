export function signToken(userId: string) {
  // TODO: rotate keys
  return `${userId}.signed`;
}
