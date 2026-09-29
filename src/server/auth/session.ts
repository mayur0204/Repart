import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient, Role } from "@/generated/prisma/client";

/**
 * Sessions (PLAN.md §1.2 "Auth"): a random 256-bit token lives only in the cookie;
 * the database stores its SHA-256 hash. 30-day rolling expiry.
 */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Extend expiry at most once a day to avoid a write on every request. */
const ROLL_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type SessionUser = { id: string; phone: string; name: string | null; email: string | null; roles: Role[] };

type Db = Pick<PrismaClient, "session">;

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export async function createSession(db: Db, userId: string, userAgent?: string | null, now = new Date()) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await db.session.create({
    data: { userId, tokenHash: hashToken(token), expiresAt, lastSeenAt: now, userAgent: userAgent?.slice(0, 300) ?? null },
  });
  return { token, expiresAt };
}

/** Returns the signed-in user, or null for unknown, expired or suspended sessions. Rolls the expiry forward. */
export async function resolveSession(db: Db, token: string, now = new Date()): Promise<{ sessionId: string; user: SessionUser } | null> {
  if (!token || token.length > 100) return null;
  const session = await db.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: { select: { id: true, phone: true, name: true, email: true, roles: true, status: true } } },
  });
  if (!session || session.expiresAt <= now || session.user.status !== "ACTIVE") return null;

  if (now.getTime() - session.lastSeenAt.getTime() > ROLL_INTERVAL_MS) {
    await db.session.update({
      where: { id: session.id },
      data: { lastSeenAt: now, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) },
    });
  }
  const { id, phone, name, email, roles } = session.user;
  return { sessionId: session.id, user: { id, phone, name, email, roles } };
}

export async function revokeSession(db: Db, token: string): Promise<void> {
  await db.session.deleteMany({ where: { tokenHash: hashToken(token) } });
}

export async function revokeAllSessions(db: Db, userId: string): Promise<void> {
  await db.session.deleteMany({ where: { userId } });
}
