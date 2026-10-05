// Rarely-used admin CLI for creating users and changing passwords.
// There is deliberately no self-service password reset flow (see
// PROGRESS.md) — this script is how the two users of this system get
// created and how a forgotten password gets changed.
//
// Usage:
//   npm run manage-user -- create <username> <displayName> <password>
//   npm run manage-user -- set-password <username> <newPassword>
//   npm run manage-user -- list
//   npm run manage-user -- reset-passkeys <username>   (deletes their passkeys; their password then lets them enrol a new one)
//   npm run manage-user -- set-service-account <username> <true|false>   (Genosuke's user: password sign-in from inside the dyno only)

import { db } from "../src/db/connection.js";
import { hashPassword } from "../src/lib/auth.js";
import { deleteAllPasskeysForUser } from "../src/lib/passkeys.js";

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
  const users = await db("users")
    .leftJoin("user_passkeys", "user_passkeys.user_id", "users.id")
    .groupBy("users.id")
    .select("users.id", "users.username", "users.display_name", "users.is_service_account", "users.created_at")
    .count({ passkeys: "user_passkeys.id" })
    .orderBy("users.created_at");
  console.table(users);
}

async function findUserOrReport(username: string): Promise<{ id: string; username: string } | null> {
  const user = await db("users").whereRaw("lower(username) = lower(?)", [username]).first("id", "username");
  if (!user) {
    console.error(`No user found with username ${username}`);
    process.exitCode = 1;
    return null;
  }
  return user;
}

async function resetPasskeys(username: string): Promise<void> {
  const user = await findUserOrReport(username);
  if (!user) return;
  const deletedCount = await deleteAllPasskeysForUser(user.id);
  console.log(`Deleted ${deletedCount} passkey(s) for ${user.username}. They can now sign in with their password to set up a new one.`);
}

async function setServiceAccount(username: string, flag: string): Promise<void> {
  if (flag !== "true" && flag !== "false") throw new Error('The flag must be "true" or "false".');
  const user = await findUserOrReport(username);
  if (!user) return;
  await db("users").where({ id: user.id }).update({ is_service_account: flag === "true" });
  console.log(`${user.username}: is_service_account = ${flag}`);
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
    case "reset-passkeys": {
      const [username] = args;
      if (!username) throw new Error("Usage: manage-user reset-passkeys <username>");
      await resetPasskeys(username);
      break;
    }
    case "set-service-account": {
      const [username, flag] = args;
      if (!username || !flag) throw new Error("Usage: manage-user set-service-account <username> <true|false>");
      await setServiceAccount(username, flag);
      break;
    }
    default:
      throw new Error("Usage: manage-user <create|set-password|list|reset-passkeys|set-service-account> ...");
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
