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
    shouldExposeOtp
};