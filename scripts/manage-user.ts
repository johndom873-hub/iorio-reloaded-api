// Rarely-used admin CLI for creating users and changing passwords.
// There is deliberately no self-service password reset flow (see
// PROGRESS.md) — this script is how the two users of this system get
// created and how a forgotten password gets changed.
//
// Usage:
//   npm run manage-user -- create <username> <displayName> <password>
//   npm run manage-user -- set-password <username> <newPassword>
//   npm run manage-user -- list

import { db } from "../src/db/connection.js";
import { hashPassword } from "../src/lib/auth.js";

async function createUser(username: string, displayName: string, password: string): Promise<void> {
  const passwordHash = await hashPassword(password);
  const [user] = await db("users")
    .insert({ username, display_name: displayName, password_hash: passwordHash })
    .returning(["id", "username", "display_name"]);
  console.log(`Created user ${user.username} (${user.id})`);
}

async function setPassword(username: string, newPassword: string): Promise<void> {
  const passwordHash = await hashPassword(newPassword);
  const updatedCount = await db("users")
    .whereRaw("lower(username) = lower(?)", [username])
    .update({ password_hash: passwordHash });
  if (updatedCount === 0) {
    console.error(`No user found with username ${username}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Password updated for ${username}`);
}

async function listUsers(): Promise<void> {
  const users = await db("users").select("id", "username", "display_name", "created_at").orderBy("created_at");
  console.table(users);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case "create": {
      const [username, displayName, password] = args;
      if (!username || !displayName || !password) {
        throw new Error("Usage: manage-user create <username> <displayName> <password>");
      }
      await createUser(username, displayName, password);
      break;
    }
    case "set-password": {
      const [username, newPassword] = args;
      if (!username || !newPassword) {
        throw new Error("Usage: manage-user set-password <username> <newPassword>");
      }
      await setPassword(username, newPassword);
      break;
    }
    case "list":
      await listUsers();
      break;
    default:
      throw new Error("Usage: manage-user <create|set-password|list> ...");
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
