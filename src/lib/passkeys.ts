import { db } from "../db/connection.js";

export interface StoredPasskey {
  credentialId: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[] | null;
  userId: string;
}

// A passkey that has signed in at least once. Password enrolment stays open for a user until they have one, so a
// passkey that was saved but never worked cannot lock them out.
export async function userHasUsedPasskey(userId: string): Promise<boolean> {
  const row = await db("user_passkeys").where({ user_id: userId }).whereNotNull("last_used_at").first("id");
  return row !== undefined;
}

export async function findPasskeyByCredentialId(credentialId: string): Promise<StoredPasskey | null> {
  const row = await db("user_passkeys").where({ credential_id: credentialId }).first();
  if (!row) return null;
  return {
    credentialId: row.credential_id,
    publicKey: new Uint8Array(row.public_key),
    // bigint columns come back from pg as strings.
    counter: Number(row.counter),
    transports: row.transports,
    userId: row.user_id,
  };
}

export async function storeNewPasskey(passkey: {
  userId: string;
  credentialId: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[] | undefined;
  deviceType: string;
  backedUp: boolean;
  registeredUserAgent: string | undefined;
}): Promise<void> {
  await db.transaction(async (transaction) => {
    // Enrolment is only open while none of the user's passkeys has ever worked, so anything still stored for them is
    // an unproven earlier attempt; this registration replaces it.
    await transaction("user_passkeys").where({ user_id: passkey.userId }).whereNull("last_used_at").delete();
    await transaction("user_passkeys").insert({
      user_id: passkey.userId,
      credential_id: passkey.credentialId,
      public_key: Buffer.from(passkey.publicKey),
      counter: passkey.counter,
      transports: passkey.transports ?? null,
      device_type: passkey.deviceType,
      backed_up: passkey.backedUp,
      registered_user_agent: passkey.registeredUserAgent?.slice(0, 300) ?? null,
    });
  });
}

export async function recordPasskeyUse(credentialId: string, newCounter: number): Promise<void> {
  await db("user_passkeys").where({ credential_id: credentialId }).update({ counter: newCounter, last_used_at: db.fn.now() });
}

export async function deleteAllPasskeysForUser(userId: string): Promise<number> {
  return db("user_passkeys").where({ user_id: userId }).delete();
}
