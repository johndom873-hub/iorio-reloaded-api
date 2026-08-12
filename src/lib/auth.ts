import argon2 from "argon2";

export async function hashPassword(plainTextPassword: string): Promise<string> {
  return argon2.hash(plainTextPassword, { type: argon2.argon2id });
}

export async function verifyPassword(passwordHash: string, plainTextPassword: string): Promise<boolean> {
  return argon2.verify(passwordHash, plainTextPassword);
}
