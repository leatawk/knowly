// =====================================================
// KNOWLY ACCOUNTS
//
// Uses the existing public.app_users table.
// No extra npm packages: Node's built-in crypto is used for
//   - password hashing (scrypt, random salt per user)
//   - login tokens (signed with HMAC-SHA256, valid 7 days)
//
// Put a long random value in server/.env:
//   AUTH_SECRET=some-long-random-text
// Without it a temporary secret is generated at start-up
// and everyone is logged out when the server restarts.
// =====================================================

const crypto = require("crypto");
const { promisify } = require("util");
const db = require("../db");

const scrypt = promisify(crypto.scrypt);

const TOKEN_DAYS = 7;
const KEY_LENGTH = 64;
const SCRYPT = { N: 16384, r: 8, p: 1 };

const SECRET = (() => {
  const configured = String(process.env.AUTH_SECRET || "");

  if (configured.length >= 32) return configured;

  if (configured) {
    console.warn("AUTH_SECRET is shorter than 32 characters. Using a temporary secret instead.");
  } else {
    console.warn("AUTH_SECRET is not set in server/.env. Logins will end when the server restarts.");
  }

  return crypto.randomBytes(48).toString("hex");
})();

// -------------------------------------
// Errors with a message the user can read
// -------------------------------------

function fail(status, message, extra = {}) {
  const error = new Error(message);
  error.status = status;
  error.expose = true;
  Object.assign(error, extra);
  return error;
}

// -------------------------------------
// Too many attempts protection
// (per IP address, kept in memory)
// -------------------------------------

const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;

const LIMITS = {
  login: 10,
  register: 8
};

function checkLimit(kind, ip) {
  const key = `${kind}|${ip}`;
  const now = Date.now();
  const entry = attempts.get(key);

  if (entry && now < entry.resetAt && entry.count >= LIMITS[kind]) {
    const minutes = Math.ceil((entry.resetAt - now) / 60000);

    throw fail(
      429,
      `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`
    );
  }
}

function countAttempt(kind, ip) {
  const key = `${kind}|${ip}`;
  const now = Date.now();
  const entry = attempts.get(key);

  if (!entry || now >= entry.resetAt) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
  } else {
    entry.count++;
  }

  // Keep the map small.
  if (attempts.size > 5000) {
    for (const [name, value] of attempts) {
      if (now >= value.resetAt) attempts.delete(name);
    }
  }
}

function clearAttempts(kind, ip) {
  attempts.delete(`${kind}|${ip}`);
}

// -------------------------------------
// Passwords
// Stored as: scrypt$N$r$p$salt$hash
// -------------------------------------

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);

  const hash = await scrypt(password, salt, KEY_LENGTH, {
    ...SCRYPT,
    maxmem: 64 * 1024 * 1024
  });

  return [
    "scrypt",
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString("base64"),
    hash.toString("base64")
  ].join("$");
}

async function checkPassword(password, stored) {
  const parts = String(stored || "").split("$");

  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const [, N, r, p, salt, expected] = parts;
  const expectedBytes = Buffer.from(expected, "base64");

  const hash = await scrypt(password, Buffer.from(salt, "base64"), expectedBytes.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: 64 * 1024 * 1024
  });

  return (
    hash.length === expectedBytes.length &&
    crypto.timingSafeEqual(hash, expectedBytes)
  );
}

// Used when the email does not exist, so a wrong email and a
// wrong password take the same time to answer.
let dummyHash = null;

async function fakeCheck(password) {
  if (!dummyHash) dummyHash = await hashPassword("knowly-not-a-real-password");
  await checkPassword(password, dummyHash);
}

// -------------------------------------
// Tokens: base64url(payload).base64url(signature)
// -------------------------------------

function sign(value) {
  return crypto.createHmac("sha256", SECRET).update(value).digest("base64url");
}

function createToken(userId) {
  const now = Math.floor(Date.now() / 1000);

  const payload = Buffer.from(
    JSON.stringify({
      sub: String(userId),
      iat: now,
      exp: now + TOKEN_DAYS * 24 * 60 * 60
    })
  ).toString("base64url");

  return `${payload}.${sign(payload)}`;
}

function readToken(token) {
  const [payload, signature, extra] = String(token || "").split(".");

  if (!payload || !signature || extra !== undefined) return null;

  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(signature);

  if (
    expected.length !== given.length ||
    !crypto.timingSafeEqual(expected, given)
  ) {
    return null;
  }

  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));

    if (
      !/^[1-9][0-9]*$/.test(String(data.sub)) ||
      !Number.isFinite(data.exp) ||
      data.exp * 1000 < Date.now()
    ) {
      return null;
    }

    return data;
  } catch {
    return null;
  }
}

// -------------------------------------
// Validation
// -------------------------------------

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function cleanEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function validEmail(email) {
  return email.length <= 255 && EMAIL.test(email);
}

function publicUser(row) {
  return {
    id: String(row.id),
    name: row.name,
    email: row.email,
    memberSince: row.created_at
  };
}

// -------------------------------------
// Register
// -------------------------------------

async function register(body, ip) {
  checkLimit("register", ip);

  const input = body && typeof body === "object" ? body : {};
  const name = String(input.name || "").replace(/\s+/g, " ").trim();
  const email = cleanEmail(input.email);
  const password = String(input.password || "");

  const errors = {};

  if (name.length < 2 || name.length > 150) {
    errors.name = "Enter your name (2 to 150 characters).";
  }

  if (!validEmail(email)) {
    errors.email = "Enter a valid email address, like name@example.com.";
  }

  if (password.length < 8) {
    errors.password = "Use at least 8 characters.";
  } else if (password.length > 200) {
    errors.password = "Use 200 characters or fewer.";
  } else if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    errors.password = "Use at least one letter and one number.";
  }

  if (Object.keys(errors).length) {
    throw fail(400, "Check the highlighted fields.", { fields: errors });
  }

  countAttempt("register", ip);

  const passwordHash = await hashPassword(password);

  try {
    const result = await db.pool.query(
      `
      INSERT INTO public.app_users (name, email, password_hash)
      VALUES ($1, $2, $3)
      RETURNING id, name, email, created_at
      `,
      [name, email, passwordHash]
    );

    const user = result.rows[0];

    return {
      user: publicUser(user),
      token: createToken(user.id)
    };
  } catch (error) {
    if (error.code === "23505") {
      throw fail(409, "An account with this email already exists. Log in instead.", {
        fields: { email: "This email is already registered." }
      });
    }

    throw error;
  }
}

// -------------------------------------
// Log in
// -------------------------------------

async function login(body, ip) {
  checkLimit("login", ip);

  const input = body && typeof body === "object" ? body : {};
  const email = cleanEmail(input.email);
  const password = String(input.password || "");

  if (!email || !password) {
    throw fail(400, "Enter your email and password.");
  }

  if (password.length > 200) {
    throw fail(400, "Email or password is incorrect.");
  }

  const result = await db.pool.query(
    `
    SELECT id, name, email, password_hash, created_at
    FROM public.app_users
    WHERE LOWER(email) = $1
    ORDER BY id
    LIMIT 1
    `,
    [email]
  );

  const user = result.rows[0];

  let ok = false;

  if (user) {
    ok = await checkPassword(password, user.password_hash);
  } else {
    await fakeCheck(password);
  }

  if (!ok) {
    countAttempt("login", ip);
    throw fail(401, "Email or password is incorrect.");
  }

  clearAttempts("login", ip);

  return {
    user: publicUser(user),
    token: createToken(user.id)
  };
}

// -------------------------------------
// Who is logged in (Authorization: Bearer <token>)
// -------------------------------------

async function currentUser(req) {
  const header = String(req.get("authorization") || "");
  const match = header.match(/^Bearer\s+(.+)$/i);

  if (!match) return null;

  const data = readToken(match[1].trim());
  if (!data) return null;

  const result = await db.pool.query(
    `
    SELECT id, name, email, created_at
    FROM public.app_users
    WHERE id = $1
    `,
    [data.sub]
  );

  return result.rows[0] ? publicUser(result.rows[0]) : null;
}

// Express middleware for routes that need an account.
function requireUser(req, res, next) {
  currentUser(req)
    .then(user => {
      if (!user) {
        return res.status(401).json({
          success: false,
          error: "Your session has ended. Log in again."
        });
      }

      req.user = user;
      next();
    })
    .catch(next);
}

module.exports = {
  register,
  login,
  currentUser,
  requireUser,

  // Used by the automated tests (tests/auth.test.js).
  _test: {
    hashPassword,
    checkPassword,
    createToken,
    readToken
  }
};
