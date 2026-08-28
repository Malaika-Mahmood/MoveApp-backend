const multer = require("multer");
const path = require("path");

// Where to store files and what to name them
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, "uploads/"); // saves into the /uploads folder
    },
    filename: function (req, file, cb) {
        // Example: 1735000000000-driving_licence.jpg
        const uniqueSuffix = Date.now();
        cb(null, `${uniqueSuffix}-${file.originalname}`);
    }
});

// Only allow images and PDFs
const fileFilter = (req, file, cb) => {
    const allowedTypes = ["image/jpeg", "image/png", "image/jpg", "application/pdf"];
    if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error("Only JPG, PNG, and PDF files are allowed"), false);
    }
};

const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB max per file
});

module.exports = upload;