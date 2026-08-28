const pool = require("../config/db");

const REQUIRED_DOCUMENTS = [
    "nic_front",
    "nic_back",
    "pco_licence_front",
    "pco_licence_back",
    "driving_licence_front",
    "driving_licence_back",
    "passport_photo",
    "selfie_front",  // Updated
    "selfie_left",   // Updated
    "selfie_right"   // Updated
];

// UPLOAD DRIVER DOCUMENT
const uploadDocument = async (req, res) => {
    try {
        const { user_id, document_type } = req.body;

        if (!user_id || !document_type) {
            return res.status(400).json({
                message: "user_id and document_type are required"
            });
        }

        if (!REQUIRED_DOCUMENTS.includes(document_type)) {
            return res.status(400).json({
                message: `document_type must be one of: ${REQUIRED_DOCUMENTS.join(", ")}`
            });
        }

        if (!req.file) {
            return res.status(400).json({
                message: "No file uploaded, or the file format was rejected (only JPG, PNG, PDF allowed)"
            });
        }

        const fileUrl = `/uploads/${req.file.filename}`;
        const fileFormat = req.file.mimetype;

        const newDoc = await pool.query(
            `INSERT INTO driver_documents (user_id, document_type, file_url, file_format, status)
             VALUES ($1, $2, $3, $4, 'pending_review')
             RETURNING id, user_id, document_type, file_url, status, uploaded_at`,
            [user_id, document_type, fileUrl, fileFormat]
        );

        const existingDocs = await pool.query(
            "SELECT DISTINCT document_type FROM driver_documents WHERE user_id = $1",
            [user_id]
        );
        const uploadedTypes = existingDocs.rows.map(row => row.document_type);
        const allDocumentsUploaded = REQUIRED_DOCUMENTS.every(type => uploadedTypes.includes(type));

        if (allDocumentsUploaded) {
            await pool.query(
                "UPDATE users SET status = 'pending_verification' WHERE id = $1 AND status = 'account_created'",
                [user_id]
            );
        }

        res.status(201).json({
            message: "Document uploaded successfully",
            document: newDoc.rows[0],
            all_documents_complete: allDocumentsUploaded
        });

    } catch (error) {
        console.error("Error in uploadDocument:", error);
        res.status(500).json({
            message: "Something went wrong while uploading the document"
        });
    }
};

// GET ALL DOCUMENTS FOR A DRIVER (with completion status)
const getDriverDocuments = async (req, res) => {
    try {
        const { id } = req.params;

        const docs = await pool.query(
            "SELECT * FROM driver_documents WHERE user_id = $1 ORDER BY uploaded_at DESC",
            [id]
        );

        const uploadedTypes = docs.rows.map(row => row.document_type);
        const missingDocuments = REQUIRED_DOCUMENTS.filter(type => !uploadedTypes.includes(type));

        res.status(200).json({
            documents: docs.rows,
            missing_documents: missingDocuments,
            is_complete: missingDocuments.length === 0
        });

    } catch (error) {
        console.error("Error in getDriverDocuments:", error);
        res.status(500).json({
            message: "Something went wrong while fetching documents"
        });
    }
};

// UPDATE DRIVER TEXT DETAILS (NIC number, address/postcode)
const updateDriverDetails = async (req, res) => {
    try {
        const { id } = req.params;
        const { nic_number, address, driving_licence_number, pco_licence_number } = req.body;

        if (!nic_number && !address && !driving_licence_number && !pco_licence_number) {
            return res.status(400).json({
                message: "Provide at least one of: nic_number, address, driving_licence_number, pco_licence_number"
            });
        }

        // UK National Insurance Number format: 2 letters + 6 digits + 1 letter (e.g. QQ123456C)
        if (nic_number && !/^[A-CEGHJ-PR-TW-Z]{1}[A-CEGHJ-NPR-TW-Z]{1}\d{6}[A-D]{1}$/i.test(nic_number)) {
            return res.status(400).json({
                message: "nic_number must be a valid UK National Insurance Number format (e.g. QQ123456C)"
            });
        }

        // UK driving licence format: 16 characters, e.g. MORGA753116SM9IJ
        if (driving_licence_number && !/^[A-Z9]{5}\d{6}[A-Z9]{2}\d[A-Z]{2}$/.test(driving_licence_number)) {
            return res.status(400).json({
                message: "driving_licence_number does not match the expected UK format (16 characters)"
            });
        }

        // PCO/PHV licence number: numeric, typically 5-8 digits
        if (pco_licence_number && !/^\d{5,8}$/.test(pco_licence_number)) {
            return res.status(400).json({
                message: "pco_licence_number must be 5-8 digits"
            });
        }

        const updated = await pool.query(
            `UPDATE users
             SET nic_number = COALESCE($1, nic_number),
                 address = COALESCE($2, address),
                 driving_licence_number = COALESCE($3, driving_licence_number),
                 pco_licence_number = COALESCE($4, pco_licence_number)
             WHERE id = $5
             RETURNING id, full_name, email, phone, nic_number, address, driving_licence_number, pco_licence_number, role, status`,
            [nic_number, address, driving_licence_number, pco_licence_number, id]
        );

        if (updated.rows.length === 0) {
            return res.status(404).json({ message: "Driver not found" });
        }

        res.status(200).json({
            message: "Driver details updated successfully",
            user: updated.rows[0]
        });

    } catch (error) {
        console.error("Error in updateDriverDetails:", error);
        res.status(500).json({
            message: "Something went wrong while updating driver details"
        });
    }
};

module.exports = { uploadDocument, getDriverDocuments, updateDriverDetails };