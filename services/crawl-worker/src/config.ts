function requireInt(
  name: string,
  fallback: string,
  min = 0,
  max = Infinity,
): number {
  const raw = process.env[name] ?? fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(
      `${name} must be an integer between ${min} and ${max}, got "${raw}"`,
    );
  }
  return value;
}

export default {
  port: requireInt('PORT', '8080', 0, 65535),
};
