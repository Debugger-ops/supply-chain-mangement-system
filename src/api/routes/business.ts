import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { asyncHandler } from "../asyncHandler.js";
import type { BusinessStore } from "../../business/businessStore.js";
import { hashPassword, verifyPassword } from "../../auth/passwords.js";
import { createSessionToken } from "../../auth/session.js";
import { serializeClearCookie, serializeSessionCookie } from "../../auth/cookies.js";
import { currentBusinessId } from "../../auth/currentBusiness.js";
import type { Business, PublicBusiness } from "../../types.js";

const BUSINESS_TYPES = ["b2c", "b2b2b", "b2b", "other"] as const;

const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  businessName: z.string().trim().min(1).max(120),
  businessType: z.enum(BUSINESS_TYPES),
  description: z.string().trim().max(600).default(""),
  accentColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "accentColor must be a 6-digit hex color")
    .default("#9fd3ff"),
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

const profileUpdateSchema = z
  .object({
    businessName: z.string().trim().min(1).max(120).optional(),
    businessType: z.enum(BUSINESS_TYPES).optional(),
    description: z.string().trim().max(600).optional(),
    accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, "accentColor must be a 6-digit hex color").optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, { message: "Provide at least one field to update" });

function toPublic(business: Business): PublicBusiness {
  const { passwordHash: _passwordHash, ...pub } = business;
  return pub;
}

function setSessionCookie(req: Request, res: Response, businessId: string): void {
  res.setHeader("Set-Cookie", serializeSessionCookie(createSessionToken(businessId), { secure: req.secure }));
}

/**
 * Business accounts: register/login/logout/me and profile updates. This
 * session is also the multi-tenant boundary for orders and the gate on
 * writing to inventory — see src/api/routes/orders.ts's scopeFor() and
 * src/api/routes/inventory.ts's PUT handler, and docs/architecture.md
 * "Multi-tenant scoping" for the full rationale.
 */
export function businessRouter(store: BusinessStore): Router {
  const router = Router();

  router.post(
    "/auth/register",
    asyncHandler(async (req, res) => {
      const parsed = registerSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "INVALID_PAYLOAD", details: parsed.error.flatten() });
      }
      const { email, password, businessName, businessType, description, accentColor } = parsed.data;

      if (await store.getByEmail(email)) {
        return res.status(409).json({ error: "EMAIL_TAKEN", message: "An account with that email already exists." });
      }

      const now = Date.now();
      const business: Business = {
        id: randomUUID(),
        email,
        passwordHash: hashPassword(password),
        businessName,
        businessType,
        description,
        accentColor,
        createdAt: now,
        updatedAt: now,
      };
      await store.create(business);
      setSessionCookie(req, res, business.id);
      res.status(201).json(toPublic(business));
    })
  );

  router.post(
    "/auth/login",
    asyncHandler(async (req, res) => {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "INVALID_PAYLOAD", details: parsed.error.flatten() });
      }
      const { email, password } = parsed.data;
      const business = await store.getByEmail(email);
      // Same message whether the email is unknown or the password is wrong —
      // don't let this endpoint be used to enumerate registered emails.
      if (!business || !verifyPassword(password, business.passwordHash)) {
        return res.status(401).json({ error: "INVALID_CREDENTIALS", message: "Incorrect email or password." });
      }
      setSessionCookie(req, res, business.id);
      res.json(toPublic(business));
    })
  );

  router.post("/auth/logout", (req, res) => {
    res.setHeader("Set-Cookie", serializeClearCookie({ secure: req.secure }));
    res.status(204).end();
  });

  router.get(
    "/auth/me",
    asyncHandler(async (req, res) => {
      const businessId = currentBusinessId(req);
      const business = businessId ? await store.getById(businessId) : undefined;
      if (!business) return res.status(401).json({ error: "UNAUTHENTICATED" });
      res.json(toPublic(business));
    })
  );

  router.patch(
    "/business/profile",
    asyncHandler(async (req, res) => {
      const businessId = currentBusinessId(req);
      if (!businessId) return res.status(401).json({ error: "UNAUTHENTICATED" });

      const parsed = profileUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "INVALID_PAYLOAD", details: parsed.error.flatten() });
      }
      const updated = await store.update(businessId, parsed.data);
      res.json(toPublic(updated));
    })
  );

  return router;
}
