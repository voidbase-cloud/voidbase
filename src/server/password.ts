import bcrypt from "bcryptjs";

// PocketBase uses bcrypt with bcrypt.DefaultCost (10) unless the field sets a cost.
export const DEFAULT_COST = 10;

export function hashPassword(plain: string, cost = DEFAULT_COST): Promise<string> {
  return bcrypt.hash(plain, cost);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  if (!hash) return false;
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}
