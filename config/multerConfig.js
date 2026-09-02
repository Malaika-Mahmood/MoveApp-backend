const multer = require("multer");
const { ALLOWED_MIME_TYPES } = require("../utils/fileType");

// memoryStorage, not diskStorage.
//
// The file arrives as a Buffer and the controller hands it to storageService,
// which decides where it actually goes. That is what lets local disk today
// become Cloudinary tomorrow without touching any controller — and it is the
// only option that can work on a read-only filesystem like Vercel's.
//
// 10 MB is small enough that holding it in memory is fine.
const storage = multer.memoryStorage();

// First gate, based on what the client claims. The real check is in the
// controller, which reads the file's actual first bytes.
const fileFilter = (req, file, cb) => {
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new multer.MulterError("LIMIT_UNEXPECTED_FILE", "file"), false);
    }
};

const upload = multer({
    storage,
    fileFilter,
    limits: {
        fileSize: 10 * 1024 * 1024,   // 10 MB
        files: 1
    }
});

module.exports = upload;