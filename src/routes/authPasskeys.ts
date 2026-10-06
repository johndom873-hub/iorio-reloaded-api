import { Router, type Request, type Response } from "express";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { db } from "../db/connection.js";
import { environment } from "../config/env.js";
import { readPasskeyLoginMode, readPasskeyRelyingPartyId } from "../config/passkeyLoginMode.js";
import { readAppEnvironment } from "../lib/appEnvironment.js";
import { clearLoginFailures, clientAddress, describeClientAddress, isLoginThrottled, recordLoginFailure } from "../lib/loginFailureThrottle.js";
import { findPasskeyByCredentialId, recordPasskeyUse, storeNewPasskey } from "../lib/passkeys.js";
import { regenerateSession } from "../lib/sessionAuthentication.js";
import { notifyTelegram } from "../lib/notifyTelegram.js";

// The password step (POST /auth/login) opens a short enrolment window; registering a passkey is the only thing it
// allows. Sign-in itself is username-less: the browser offers the passkeys it holds for this site and the credential id
// identifies the user.
export const passkeyAuthRouter = Router();

const relyingPartyName = "Iorio Reloaded";
const challengeLifetimeMs = 5 * 60 * 1000;

passkeyAuthRouter.use((_request, response, next) => {
  if (readPasskeyLoginMode() !== "required") {
    response.status(404).json({ error: "Passkey login is not enabled." });
    return;
  }
  next();
});

function storeChallenge(request: Request, purpose: "registration" | "login", value: string): void {
  request.session.passkeyChallenge = { purpose, value, expiresAt: Date.now() + challengeLifetimeMs };
}

// A challenge is single-use: taken (and cleared) whether or not the verification that follows succeeds.
function takeChallenge(request: Request, purpose: "registration" | "login"): string | null {
  const challenge = request.session.passkeyChallenge;
  request.session.passkeyChallenge = undefined;
  if (!challenge || challenge.purpose !== purpose || challenge.expiresAt < Date.now()) return null;
  return challenge.value;
}

function pendingEnrollmentUserId(request: Request): string | null {
  const pending = request.session.pendingPasskeyEnrollment;
  if (!pending || pending.expiresAt < Date.now()) return null;
  return pending.userId;
}

// Staging and development passkeys share the RP ID with production, so the browser's picker lists them side by side:
// the environment goes into the name it shows.
function passkeyAccountLabel(label: string): string {
  const appEnvironment = readAppEnvironment();
  return appEnvironment === "production" ? label : `${label} (${appEnvironment})`;
}

passkeyAuthRouter.post("/register/options", async (request, response) => {
  const userId = pendingEnrollmentUserId(request);
  if (!userId) {
    response.status(401).json({ error: "Enter your username and password first." });
    return;
  }
  const user = await db("users").where({ id: userId }).first();
  if (!user) {
    response.status(401).json({ error: "Enter your username and password first." });
    return;
  }

  const options = await generateRegistrationOptions({
    rpName: relyingPartyName,
    rpID: readPasskeyRelyingPartyId(),
    userID: new TextEncoder().encode(user.id),
    userName: passkeyAccountLabel(user.username),
    userDisplayName: passkeyAccountLabel(user.display_name),
    attestationType: "none",
    // Sign-in is username-less, so the passkey must be discoverable, and it is the only factor, so the authenticator
    // must verify the person (biometric / PIN / provider unlock).
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
  storeChallenge(request, "registration", options.challenge);
  response.json(options);
});

passkeyAuthRouter.post("/register/verify", async (request, response) => {
  const userId = pendingEnrollmentUserId(request);
  const expectedChallenge = takeChallenge(request, "registration");
  if (!userId || !expectedChallenge) {
    response.status(401).json({ error: "Passkey setup expired. Enter your password again." });
    return;
  }
  const user = await db("users").where({ id: userId }).first();
  if (!user) {
    response.status(401).json({ error: "Enter your username and password first." });
    return;
  }

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: request.body as RegistrationResponseJSON,
      expectedChallenge,
      expectedOrigin: environment.frontendOrigin,
      expectedRPID: readPasskeyRelyingPartyId(),
      requireUserVerification: true,
    });
  } catch (error) {
    response.status(400).json({ error: `The passkey could not be verified: ${error instanceof Error ? error.message : "unknown error"}` });
    return;
  }
  if (!verification.verified) {
    response.status(400).json({ error: "The passkey could not be verified." });
    return;
  }

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  await storeNewPasskey({
    userId: user.id,
    credentialId: credential.id,
    publicKey: credential.publicKey,
    counter: credential.counter,
    transports: credential.transports,
    deviceType: credentialDeviceType,
    backedUp: credentialBackedUp,
    registeredUserAgent: request.get("user-agent"),
  });
  request.session.pendingPasskeyEnrollment = undefined;

  // Any registration is worth a message: it is the one moment a stolen password could add an attacker's passkey.
  void notifyTelegram(
    `🔑 Passkey registered for ${user.username} on ${readAppEnvironment()} (${credentialDeviceType}${credentialBackedUp ? ", synced" : ""}) from ${describeClientAddress(request)}. If this was not you or Juan, run: npm run manage-user -- reset-passkeys ${user.username}`,
  );
  response.json({ status: "registered" });
});

passkeyAuthRouter.post("/login/options", async (request, response) => {
  const address = clientAddress(request);
  if (isLoginThrottled(address, Date.now())) {
    response.status(429).json({ error: "Too many failed login attempts — try again in 15 minutes." });
    return;
  }
  const options = await generateAuthenticationOptions({ rpID: readPasskeyRelyingPartyId(), userVerification: "required" });
  storeChallenge(request, "login", options.challenge);
  response.json(options);
});

async function refuseSignIn(request: Request, response: Response, message: string): Promise<void> {
  recordLoginFailure(clientAddress(request), Date.now());
  response.status(401).json({ error: message });
}

passkeyAuthRouter.post("/login/verify", async (request, response) => {
  const address = clientAddress(request);
  if (isLoginThrottled(address, Date.now())) {
    response.status(429).json({ error: "Too many failed login attempts — try again in 15 minutes." });
    return;
  }
  const expectedChallenge = takeChallenge(request, "login");
  if (!expectedChallenge) {
    response.status(401).json({ error: "Passkey sign-in expired. Try again." });
    return;
  }

  const authenticationResponse = request.body as AuthenticationResponseJSON;
  const passkey = typeof authenticationResponse?.id === "string" ? await findPasskeyByCredentialId(authenticationResponse.id) : null;
  if (!passkey) {
    await refuseSignIn(request, response, "This passkey is not registered for Iorio. Sign in with your password to set one up.");
    return;
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: authenticationResponse,
      expectedChallenge,
      expectedOrigin: environment.frontendOrigin,
      expectedRPID: readPasskeyRelyingPartyId(),
      credential: {
        id: passkey.credentialId,
        publicKey: passkey.publicKey as Uint8Array<ArrayBuffer>,
        counter: passkey.counter,
        transports: passkey.transports ?? undefined,
      },
      requireUserVerification: true,
    });
  } catch {
    await refuseSignIn(request, response, "The passkey could not be verified.");
    return;
  }
  if (!verification.verified) {
    await refuseSignIn(request, response, "The passkey could not be verified.");
    return;
  }

  const user = await db("users").where({ id: passkey.userId }).first();
  if (!user) {
    await refuseSignIn(request, response, "The passkey could not be verified.");
    return;
  }
  await recordPasskeyUse(passkey.credentialId, verification.authenticationInfo.newCounter);
  clearLoginFailures(address);

  await regenerateSession(request);
  request.session.userId = user.id;
  request.session.authMethod = "passkey";
  response.json({ id: user.id, username: user.username, displayName: user.display_name });
});
