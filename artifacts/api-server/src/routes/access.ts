import { Router } from "express";
import {
  getOrCreateTrialSession,
  getTrialInfo,
  consumeTrialPlay,
  checkSubscriptionToken,
  checkIpBinding,
} from "../lib/session-store.js";

const router = Router();

const COOKIE_NAME = "pc_trial";
const COOKIE_MAX_AGE = 365 * 24 * 60 * 60 * 1000;

// ── VPN / Proxy detection cache ───────────────────────────────────────────────
interface IpCheckResult { isProxy: boolean; checkedAt: number }
const ipCheckCache = new Map<string, IpCheckResult>();
const IP_CHECK_TTL = 60 * 60 * 1000; // 1 hour cache

async function isVpnOrProxy(ip: string): Promise<boolean> {
  if (!ip || ip === "unknown" || ip.startsWith("127.") || ip.startsWith("::1")) return false;
  const cached = ipCheckCache.get(ip);
  if (cached && Date.now() - cached.checkedAt < IP_CHECK_TTL) return cached.isProxy;

  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(
      `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=proxy,hosting,status`,
      { signal: ctrl.signal, headers: { "Accept": "application/json" } }
    );
    clearTimeout(timeout);
    if (!res.ok) return false;
    const data = await res.json() as { proxy?: boolean; hosting?: boolean; status?: string };
    const isProxy = !!(data.proxy || data.hosting);
    ipCheckCache.set(ip, { isProxy, checkedAt: Date.now() });
    if (isProxy) console.log(`[vpn-detect] blocked proxy/VPN IP: ${ip}`);
    return isProxy;
  } catch {
    return false; // fail open — don't block on timeout
  }
}

// Clean cache every hour
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of ipCheckCache.entries()) {
    if (now - entry.checkedAt > IP_CHECK_TTL * 2) ipCheckCache.delete(ip);
  }
}, 60 * 60_000).unref();

// ── Rate limiting for consume-play ────────────────────────────────────────────
const consumeRateMap = new Map<string, { count: number; resetAt: number }>();
const CONSUME_RATE_WINDOW = 60_000;
const CONSUME_RATE_MAX = 10;

function getClientIp(req: Parameters<Parameters<typeof router.post>[1]>[0]): string {
  return (
    (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ??
    req.socket.remoteAddress ?? "unknown"
  );
}

function checkConsumeRate(ip: string): boolean {
  const now = Date.now();
  const entry = consumeRateMap.get(ip);
  if (!entry || entry.resetAt < now) {
    consumeRateMap.set(ip, { count: 1, resetAt: now + CONSUME_RATE_WINDOW });
    return true;
  }
  if (entry.count >= CONSUME_RATE_MAX) return false;
  entry.count++;
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of consumeRateMap.entries()) {
    if (entry.resetAt < now) consumeRateMap.delete(ip);
  }
}, 5 * 60_000).unref();

function cookieOpts(isProduction: boolean) {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax" as const,
    maxAge: COOKIE_MAX_AGE,
    path: "/",
  };
}

function extractToken(authHeader: string | undefined): string | null {
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);
  return null;
}

// GET /api/access/status
router.get("/access/status", (req, res) => {
  const isProd = process.env.NODE_ENV === "production";
  const token = extractToken(req.headers.authorization);
  const clientIp = getClientIp(req);

  let isSubscribed = false;
  let subscriptionExpiresAt: number | null = null;

  if (token) {
    // Check IP binding first — if IP changed, reject the token
    if (!checkIpBinding(token, clientIp)) {
      // IP mismatch — don't deactivate immediately (could be proxy/VPN change)
      // Just mark as not subscribed so user sees paywall
      isSubscribed = false;
    } else {
      const sub = checkSubscriptionToken(token);
      if (sub.valid) {
        isSubscribed = true;
        subscriptionExpiresAt = sub.expiresAt ?? null;
      }
    }
  }

  const trialId = (req.cookies as Record<string, string>)?.[COOKIE_NAME];
  const trial = getTrialInfo(trialId);

  if (!trialId || trialId !== trial.trialId) {
    res.cookie(COOKIE_NAME, trial.trialId, cookieOpts(isProd));
  }

  const canWatch = isSubscribed || trial.freePlaysRemaining > 0;

  return res.json({
    isSubscribed,
    subscriptionExpiresAt,
    freePlaysLimit: trial.freePlaysLimit,
    freePlaysUsed: trial.freePlaysUsed,
    freePlaysRemaining: trial.freePlaysRemaining,
    canWatch,
    trialId: trial.trialId,
    reason: canWatch ? null : "subscription_required",
  });
});

// POST /api/access/consume-play
router.post("/access/consume-play", async (req, res) => {
  const ip = getClientIp(req);
  if (!checkConsumeRate(ip)) {
    return res.status(429).json({ consumed: false, reason: "rate_limited", freePlaysRemaining: 0 });
  }
  const isProd = process.env.NODE_ENV === "production";
  const token = extractToken(req.headers.authorization);

  if (token) {
    const sub = checkSubscriptionToken(token);
    if (sub.valid) {
      return res.json({ consumed: true, reason: "subscribed", freePlaysRemaining: null, isSubscribed: true });
    }
  }

  // VPN/Proxy check — block free plays from VPNs to prevent session farming
  const vpn = await isVpnOrProxy(ip);
  if (vpn) {
    return res.status(403).json({
      consumed: false,
      reason: "vpn_blocked",
      freePlaysRemaining: 0,
      message: "يُرجى إيقاف VPN أو البروكسي للاستمرار في المشاهدة المجانية",
    });
  }

  let trialId = (req.cookies as Record<string, string>)?.[COOKIE_NAME];

  if (!trialId) {
    const session = getOrCreateTrialSession(undefined);
    trialId = session.trialId;
    res.cookie(COOKIE_NAME, trialId, cookieOpts(isProd));
  }

  const { playbackSessionId } = (req.body ?? {}) as { playbackSessionId?: string };
  const result = consumeTrialPlay(trialId, playbackSessionId);

  if (!result.consumed) {
    return res.status(402).json({
      consumed: false,
      reason: result.reason,
      freePlaysRemaining: result.freePlaysRemaining,
      message: "انتهت مشاهداتك المجانية، اشترك للمتابعة",
    });
  }

  return res.json({
    consumed: true,
    freePlaysRemaining: result.freePlaysRemaining,
    isSubscribed: false,
  });
});

export default router;
