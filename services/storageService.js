// MoveApp — file storage.
//
// Every uploaded file goes through this file. Today it writes to local disk.
// When Cloudinary or S3 is bought, ONLY this file changes — no controller,
// no route, no database column.
//
// IMPORTANT: local disk does not work on Vercel (the filesystem is read-only
// and wiped between requests). Document upload therefore has to be tested on
// localhost until cloud storage is in place.

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const UPLOAD_ROOT = path.join(process.cwd(), "uploads");

// Files are grouped by month so one directory never ends up with 100,000
// entries, which some filesystems handle badly.
const buildKey = (ext) => {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    // A random name, never the driver's original filename — that could contain
    // path separators, or the driver's real name, which does not belong in a URL.
    return `${yyyy}/${mm}/${crypto.randomUUID()}.${ext}`;
};

// Saves a buffer and returns the key needed to read it back later
const save = async (buffer, ext) => {
    const key = buildKey(ext);
    const fullPath = path.join(UPLOAD_ROOT, key);

    await fsp.mkdir(path.dirname(fullPath), { recursive: true });
    await fsp.writeFile(fullPath, buffer);

    return { key, size: buffer.length };
};

// Guards against a key like "../../etc/passwd" reaching the filesystem
const resolveSafePath = (key) => {
    const fullPath = path.resolve(UPLOAD_ROOT, key);
    if (!fullPath.startsWith(path.resolve(UPLOAD_ROOT) + path.sep)) {
        throw new Error("Invalid storage key");
    }
    return fullPath;
};

const createReadStream = (key) => fs.createReadStream(resolveSafePath(key));

// Whole file in memory — used when building the combined PDF, which needs the
// bytes rather than a stream. Fine at 10 MB per file; if documents ever get
// much bigger, the PDF build should stream instead.
const readBuffer = async (key) => fsp.readFile(resolveSafePath(key));

const exists = async (key) => {
    try {
        await fsp.access(resolveSafePath(key));
        return true;
    } catch {
        return false;
    }
};

const remove = async (key) => {
    try {
        await fsp.unlink(resolveSafePath(key));
        return true;
    } catch {
        return false;   // already gone is not an error worth failing a request over
    }
};

// The API returns this rather than a direct file path, so files stay private:
// the endpoint checks who is asking before streaming anything.
const buildFileUrl = (documentId) => `/api/v1/documents/${documentId}/file`;

module.exports = { save, createReadStream, readBuffer, exists, remove, buildFileUrl };