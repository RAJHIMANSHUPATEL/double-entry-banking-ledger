import { ActorRequired, InvalidEntry } from "../services/exceptions.js";

const ACTOR = /^[A-Za-z0-9_.-]{1,64}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * Mutating routes require a displayed actor name. It is not an authentication proof.
 * @param {import('fastify').FastifyRequest} request
 */
export function requireActor(request) {
  const actor = request.headers["x-actor"];
  if (typeof actor !== "string" || !ACTOR.test(actor)) throw new ActorRequired();
  return actor;
}

/**
 * @param {import('fastify').FastifyRequest} request
 * @returns {string | null}
 */
export function readIdempotencyKey(request) {
  const key = request.headers["idempotency-key"];
  if (key === undefined) return null;
  if (typeof key !== "string" || !IDEMPOTENCY_KEY.test(key)) {
    throw new InvalidEntry("Idempotency-Key must be 1–128 characters from [A-Za-z0-9_.:-].");
  }
  return key;
}
