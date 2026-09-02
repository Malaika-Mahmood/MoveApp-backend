const multer = require("multer");
const upload = require("../config/multerConfig");

// Wraps multer so its errors come back as JSON.
//
// Without this, a rejected file (wrong type, too large) reaches Express's
// default error handler and the app receives an HTML error page. Asima's
// Retrofit call would fail to parse it and report something unrelated.
const uploadFile = (fieldName = "file") => (req, res, next) => {
    upload.single(fieldName)(req, res, (err) => {
        if (!err) return next();

        if (err instanceof multer.MulterError) {
            if (err.code === "LIMIT_FILE_SIZE") {
                return res.status(400).json({
                    message: "File must be 10 MB or smaller",
                    error_code: "FILE_TOO_LARGE"
                });
            }

            if (err.code === "LIMIT_UNEXPECTED_FILE") {
                return res.status(400).json({
                    message: "File must be a JPG, PNG or PDF, sent under the key 'file'",
                    error_code: "INVALID_FILE_TYPE"
                });
            }

            return res.status(400).json({
                message: "File upload failed",
                error_code: "UPLOAD_ERROR"
            });
        }

        console.error("Unexpected upload error:", err);
        res.status(500).json({ message: "Something went wrong while receiving the file" });
    });
};

module.exports = uploadFile;