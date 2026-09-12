const multer = require("multer");

// memoryStorage, not diskStorage.
//
// The file arrives as a Buffer and the controller hands it to storageService,
// which decides where it actually goes. That is what lets local disk today
// become Cloudinary tomorrow without touching any controller — and it is the
// only option that can work on a read-only filesystem like Vercel's.
const storage = multer.memoryStorage();

// No mimetype filter here on purpose.
//
// Content-Type is supplied by the client and is often wrong or missing — a
// perfectly good PDF gets rejected because the header said something else.
// The controller checks the file's actual first bytes instead, which cannot
// be faked the same way, so a second guess at this layer only causes
// false rejections.
const upload = multer({
    storage,
    limits: {
        fileSize: 10 * 1024 * 1024,   // 10 MB
        files: 1
    }
});

module.exports = upload;