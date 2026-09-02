// Detects the real file type from the first few bytes.
//
// req.file.mimetype comes from the client and can say anything — an .exe
// renamed to .jpg arrives claiming to be image/jpeg. The bytes at the start of
// a file cannot be faked the same way, so that is what we check.

const SIGNATURES = [
    { mime: "image/jpeg", ext: "jpg", bytes: [0xFF, 0xD8, 0xFF] },
    { mime: "image/png", ext: "png", bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] },
    { mime: "application/pdf", ext: "pdf", bytes: [0x25, 0x50, 0x44, 0x46] }   // "%PDF"
];

// Returns { mime, ext } or null when nothing matches
const detectFileType = (buffer) => {
    if (!Buffer.isBuffer(buffer) || buffer.length < 8) return null;

    for (const sig of SIGNATURES) {
        const matches = sig.bytes.every((byte, i) => buffer[i] === byte);
        if (matches) return { mime: sig.mime, ext: sig.ext };
    }

    return null;
};

const ALLOWED_MIME_TYPES = SIGNATURES.map((s) => s.mime);

module.exports = { detectFileType, ALLOWED_MIME_TYPES };