// MoveApp — file storage.
//
// Every uploaded file goes through here. Two backends, one interface:
//
//   local       writes to ./uploads. Works on a laptop, does NOT work on
//               Vercel — that filesystem is read-only and wiped between
//               requests.
//   cloudinary  works everywhere.
//
// Which one is used is decided by the environment, not by the code that calls
// it. With CLOUDINARY_CLOUD_NAME set, new files go to Cloudinary; without it,
// to disk. That means a laptop with no Cloudinary keys still works, and
// production always uses Cloudinary because the variables are there.
//
// Both can be read at the same time. The storage key says which backend a file
// came from, so documents uploaded before the switch keep working and nothing
// has to be migrated in a hurry.
//
// ---------------------------------------------------------------------------
// Why the API still serves the bytes itself
// ---------------------------------------------------------------------------
// buildFileUrl has not changed: it still returns /api/v1/documents/:id/file,
// and that endpoint checks who is asking before it sends anything.
//
// It would be less work to hand out Cloudinary URLs directly, and it would be
// a mistake. A signed Cloudinary URL works for whoever holds it — paste it in
// a message and the passport goes with it. Our endpoint asks every time.
//
// It costs a round trip through the server. For documents that are read a few
// times each during verification, that is nothing next to the alternative.

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { Readable, PassThrough } = require("stream");

// ---------------------------------------------------------------------------
// Which backend
// ---------------------------------------------------------------------------

// The SDK reads CLOUDINARY_URL by itself; the three separate variables are
// supported because Vercel's settings page is easier to fill in that way.
const cloudName = process.env.CLOUDINARY_CLOUD_NAME
    || (process.env.CLOUDINARY_URL || "").split("@")[1];

const useCloudinary = Boolean(cloudName);

let cloudinary = null;

if (useCloudinary) {
    // Required lazily so a laptop without the package installed still runs the
    // rest of the API. A missing package should not stop somebody logging in.
    cloudinary = require("cloudinary").v2;

    if (process.env.CLOUDINARY_CLOUD_NAME) {
        cloudinary.config({
            cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
            api_key: process.env.CLOUDINARY_API_KEY,
            api_secret: process.env.CLOUDINARY_API_SECRET,
            secure: true
        });
    }

    console.log(`File storage: Cloudinary (${process.env.CLOUDINARY_CLOUD_NAME || "from CLOUDINARY_URL"})`);
} else {
    console.log("File storage: local disk (./uploads) — will NOT work on Vercel");
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------
// A local key looks like        2026/09/3f2a....jpg
// A Cloudinary key looks like   cld:image:jpg:moveapp/2026/09/3f2a...
//
// The prefix is what lets both live in one database. Everything below asks
// isCloudKey first and there is no other place that needs to know.

const CLOUD_PREFIX = "cld:";

const isCloudKey = (key) => String(key || "").startsWith(CLOUD_PREFIX);

const packCloudKey = ({ resourceType, format, publicId }) =>
    `${CLOUD_PREFIX}${resourceType}:${format || ""}:${publicId}`;

const unpackCloudKey = (key) => {
    const rest = String(key).slice(CLOUD_PREFIX.length);
    const firstColon = rest.indexOf(":");
    const secondColon = rest.indexOf(":", firstColon + 1);

    return {
        resourceType: rest.slice(0, firstColon),
        format: rest.slice(firstColon + 1, secondColon) || null,
        // The public id may itself contain colons in theory, so it is taken as
        // everything after the second one rather than by splitting.
        publicId: rest.slice(secondColon + 1)
    };
};

// Grouped by month so no single folder ends up with a hundred thousand
// entries, which some filesystems handle badly and every file browser does.
const monthFolder = () => {
    const now = new Date();
    return `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}`;
};

// A random name, never the driver's own filename. Theirs could contain path
// separators, or their real name, and neither belongs in a URL.
const randomName = () => crypto.randomUUID();

// ---------------------------------------------------------------------------
// Local disk
// ---------------------------------------------------------------------------

const UPLOAD_ROOT = path.join(process.cwd(), "uploads");

// Guards against a key like "../../etc/passwd" reaching the filesystem.
const resolveSafePath = (key) => {
    const fullPath = path.resolve(UPLOAD_ROOT, key);
    if (!fullPath.startsWith(path.resolve(UPLOAD_ROOT) + path.sep)) {
        throw new Error("Invalid storage key");
    }
    return fullPath;
};

const localSave = async (buffer, ext) => {
    const key = `${monthFolder()}/${randomName()}.${ext}`;
    const fullPath = path.join(UPLOAD_ROOT, key);

    await fsp.mkdir(path.dirname(fullPath), { recursive: true });
    await fsp.writeFile(fullPath, buffer);

    return { key, size: buffer.length };
};

// ---------------------------------------------------------------------------
// Cloudinary
// ---------------------------------------------------------------------------

// Uploaded as `authenticated`, so the plain URL is not merely hard to guess —
// it does not work at all without a signature. Belt and braces: we do not hand
// those URLs out anyway, but a private file should be private at the far end
// too, not only by our good manners.
const cloudSave = (buffer, ext) =>
    new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            {
                folder: `moveapp/${monthFolder()}`,
                public_id: randomName(),
                resource_type: "auto",   // jpg, png and pdf all land correctly
                type: "authenticated",
                // Cloudinary would otherwise strip an exact duplicate to the
                // same public id. Two drivers uploading the same stock photo
                // must stay two documents.
                overwrite: false,
                unique_filename: false
            },
            (error, result) => {
                if (error) return reject(error);

                resolve({
                    key: packCloudKey({
                        resourceType: result.resource_type,
                        format: result.format || ext,
                        publicId: result.public_id
                    }),
                    size: result.bytes
                });
            }
        );

        Readable.from(buffer).pipe(stream);
    });

// A signed, short-lived URL the server uses to read the file back. It never
// leaves this module.
const cloudUrl = (key) => {
    const { resourceType, format, publicId } = unpackCloudKey(key);

    return cloudinary.url(publicId, {
        resource_type: resourceType,
        type: "authenticated",
        format: format || undefined,
        sign_url: true,
        secure: true
    });
};

const cloudFetch = async (key, method = "GET") => {
    const response = await fetch(cloudUrl(key), { method });
    return response;
};

// ---------------------------------------------------------------------------
// The interface — unchanged from the local-only version
// ---------------------------------------------------------------------------

const save = (buffer, ext) =>
    useCloudinary ? cloudSave(buffer, ext) : localSave(buffer, ext);

// Deliberately still synchronous.
//
// The controllers do `const stream = storage.createReadStream(key)` and pipe
// it. Making this async would mean editing every one of those call sites to
// await — more changed files, more to get wrong, for no gain. So a
// PassThrough is returned at once and the fetched body is piped into it when
// it arrives. A failure destroys the stream, which surfaces as an error on the
// response exactly as a missing local file would.
const createReadStream = (key) => {
    if (!isCloudKey(key)) return fs.createReadStream(resolveSafePath(key));

    const out = new PassThrough();

    cloudFetch(key)
        .then((response) => {
            if (!response.ok || !response.body) {
                return out.destroy(new Error(`Cloudinary responded ${response.status}`));
            }
            Readable.fromWeb(response.body).pipe(out);
        })
        .catch((error) => out.destroy(error));

    return out;
};

// The whole file in memory. Used when building the combined PDF, which needs
// the bytes rather than a stream. Fine at 10 MB a file; if documents ever get
// much larger the PDF build should stream instead.
const readBuffer = async (key) => {
    if (!isCloudKey(key)) return fsp.readFile(resolveSafePath(key));

    const response = await cloudFetch(key);
    if (!response.ok) throw new Error(`Cloudinary responded ${response.status}`);

    return Buffer.from(await response.arrayBuffer());
};

// A HEAD rather than trusting the database.
//
// It is one extra round trip per document view, and it buys a clean 404 when a
// file has gone missing instead of a half-written response and a 500. The
// controllers call this before streaming precisely so they can say "not
// found" properly.
const exists = async (key) => {
    if (!key) return false;

    if (!isCloudKey(key)) {
        try {
            await fsp.access(resolveSafePath(key));
            return true;
        } catch {
            return false;
        }
    }

    try {
        const response = await cloudFetch(key, "HEAD");
        return response.ok;
    } catch {
        return false;
    }
};

const remove = async (key) => {
    if (!key) return false;

    if (!isCloudKey(key)) {
        try {
            await fsp.unlink(resolveSafePath(key));
            return true;
        } catch {
            return false;   // already gone is not worth failing a request over
        }
    }

    try {
        const { resourceType, publicId } = unpackCloudKey(key);
        await cloudinary.uploader.destroy(publicId, {
            resource_type: resourceType,
            type: "authenticated"
        });
        return true;
    } catch (error) {
        console.error("Cloudinary delete failed:", error.message);
        return false;
    }
};

// What the API returns instead of a file path, so files stay private: the
// endpoint checks who is asking before streaming anything.
const buildFileUrl = (documentId) => `/api/v1/documents/${documentId}/file`;

module.exports = {
    save,
    createReadStream,
    readBuffer,
    exists,
    remove,
    buildFileUrl,

    // Exported for the migration script and for tests. Nothing else should
    // need to know which backend a key belongs to.
    isCloudKey,
    useCloudinary
};