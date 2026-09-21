// MoveApp — OTP generation, hashing and policy.
//
// Every OTP in the system goes through this file, so the rules (length,
// expiry, attempt limits) live in exactly one place.

const crypto = require("crypto");

const OTP_LENGTH = 6;
const OTP_TTL_MINUTES = 5;
const MAX_VERIFY_ATTEMPTS = 5;
const MAX_RESENDS = 5;
const RESEND_COOLDOWN_SECONDS = 60;

// A secret "pepper" so a database leak does not expose live codes.
// A plain SHA-256 of a 6-digit code is useless as protection: an attacker can
// hash all 1,000,000 possibilities in under a second. Mixing in a secret the
// database itself does not hold makes the stored hashes meaningless on their own.
const getPepper = () => {
    const pepper = process.env.OTP_PEPPER || process.env.JWT_SECRET;
    if (!pepper) {
        throw new Error("OTP_PEPPER (or JWT_SECRET) must be set in the environment");
    }
    return pepper;
};

// crypto.randomInt is cryptographically secure. Math.random() is not — its
// output is predictable from previous values, which is fatal for an OTP.
const generateOtp = () =>
    crypto.randomInt(0, 10 ** OTP_LENGTH).toString().padStart(OTP_LENGTH, "0");

const hashOtp = (otp) =>
    crypto.createHmac("sha256", getPepper()).update(String(otp)).digest("hex");

// Constant-time comparison, so response timing cannot leak how much of the
// submitted code was correct.
const otpMatches = (submittedOtp, storedHash) => {
    if (!storedHash || submittedOtp === undefined || submittedOtp === null) return false;

    const submittedHash = hashOtp(submittedOtp);
    const a = Buffer.from(submittedHash, "hex");
    const b = Buffer.from(storedHash, "hex");

    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
};

const otpExpiryDate = () => new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

const secondsSince = (date) =>
    Math.floor((Date.now() - new Date(date).getTime()) / 1000);

// The code is only ever returned in the API response when this is explicitly
// switched on for local development. It must be false in production.
const shouldExposeOtp = () => process.env.EXPOSE_DEV_OTP === "true";

// ---------------------------------------------------------------------------
// Test accounts
// ---------------------------------------------------------------------------
// A small, named list of numbers whose code is always the same, so the app can
// be developed without waiting for a text message.
//
// This is the dangerous part of the file, so it is written to be difficult to
// switch on by accident:
//
//   1. It needs TWO environment variables, not one. Neither on its own does
//      anything. A stray variable copied to production is inert.
//   2. It applies only to numbers listed by hand. It is not "all numbers" with
//      an exception list — it is nothing, with an inclusion list.
//   3. The code must be the right length and all digits, or the whole thing
//      stays off and says so at startup.
//   4. It shouts at startup, every time. A server log that says TEST OTP
//      ENABLED is hard to leave running by mistake.
//
// The controller adds one more rule: it never applies to an admin.
//
// Everything else stays exactly as it is — the code is still hashed, still
// expires in five minutes, still single use, still limited to five attempts.
// The ONLY difference is that the digits are predictable for these numbers.
// That keeps this change small, which is the point: nothing about the login
// path behaves differently, so nothing else can break.
//
// NEVER set these two on the live deployment.

const TEST_OTP_VALUE = String(process.env.TEST_OTP || "").trim();

const TEST_IDENTIFIERS = String(process.env.TEST_PHONE_NUMBERS || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

// Numbers get typed a dozen ways — +447700900099, 07700 900099, 44 7700
// 900099. Comparing the digits alone means the list works however it is
// written, in the variable and in the request.
const digitsOnly = (value) => String(value).replace(/\D/g, "");

const TEST_OTP_IS_VALID =
    TEST_OTP_VALUE.length === OTP_LENGTH && /^\d+$/.test(TEST_OTP_VALUE);

const testAccountsEnabled = () =>
    TEST_OTP_IS_VALID && TEST_IDENTIFIERS.length > 0;

const isTestIdentifier = (identifier) => {
    if (!testAccountsEnabled()) return false;

    const wanted = digitsOnly(identifier);
    if (!wanted) return false;

    return TEST_IDENTIFIERS.some(
        (entry) => entry === identifier || digitsOnly(entry) === wanted
    );
};

const getTestOtp = () => TEST_OTP_VALUE;

// ---------------------------------------------------------------------------
// The test admin
// ---------------------------------------------------------------------------
// An admin can open every driver's passport and every operator's licence, so
// an admin account with a guessable code is the worst thing in this file. It
// is allowed only because the admin screens have to be built by somebody who
// cannot read the server's logs.
//
// It gets its own variable rather than another entry in the list above, for
// one reason: nobody can enable it by accident. Adding a number to a list is a
// small act; naming a variable TEST_ADMIN_PHONE is a decision. And if it ever
// appears in a production settings page, the name alone says what is wrong.
//
// One number, not a list. There is no reason to need two.
const TEST_ADMIN_VALUE = String(process.env.TEST_ADMIN_PHONE || "").trim();

// The number must ALSO be in the main list. Two variables have to agree, so
// TEST_ADMIN_PHONE on its own is not a second, quieter way in.
const isTestAdminIdentifier = (identifier) => {
    if (!TEST_ADMIN_VALUE) return false;
    if (!isTestIdentifier(identifier)) return false;

    const wanted = digitsOnly(identifier);
    if (!wanted) return false;

    return (
        TEST_ADMIN_VALUE === identifier ||
        digitsOnly(TEST_ADMIN_VALUE) === wanted
    );
};

// Said once, at startup, loudly.
if (TEST_OTP_VALUE && !TEST_OTP_IS_VALID) {
    console.warn(
        `TEST_OTP is set but is not ${OTP_LENGTH} digits — test accounts are OFF.`
    );
} else if (TEST_OTP_VALUE && TEST_IDENTIFIERS.length === 0) {
    console.warn("TEST_OTP is set but TEST_PHONE_NUMBERS is empty — test accounts are OFF.");
} else if (testAccountsEnabled()) {
    console.warn("=================================================================");
    console.warn(`TEST OTP ENABLED for ${TEST_IDENTIFIERS.length} number(s).`);
    console.warn("These accounts accept one fixed code. NEVER enable this on live.");

    if (TEST_ADMIN_VALUE) {
        // Its own line, because this is the part somebody should notice from
        // across the room.
        console.warn("   >>> ONE OF THEM IS AN ADMIN ACCOUNT <<<");
    }

    console.warn("=================================================================");
}

if (TEST_ADMIN_VALUE && testAccountsEnabled() && !isTestIdentifier(TEST_ADMIN_VALUE)) {
    console.warn("TEST_ADMIN_PHONE is set but is not listed in TEST_PHONE_NUMBERS — it will not work.");
}

module.exports = {
    OTP_LENGTH,
    OTP_TTL_MINUTES,
    MAX_VERIFY_ATTEMPTS,
    MAX_RESENDS,
    RESEND_COOLDOWN_SECONDS,
    generateOtp,
    hashOtp,
    otpMatches,
    otpExpiryDate,
    secondsSince,
    shouldExposeOtp,

    testAccountsEnabled,
    isTestIdentifier,
    isTestAdminIdentifier,
    getTestOtp
};