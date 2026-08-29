const pool = require("../config/db");

const REQUIRED_VEHICLE_DOCUMENTS = [
    "pco_vehicle_paper",
    "v5_logbook",
    "mot_road_tax",
    "car_insurance",
    "valid_mot",
    "photo_front",
    "photo_back",
    "photo_interior"
];

// DRIVER ADDS A VEHICLE (own vehicle)
const addVehicle = async (req, res) => {
    try {
        const { driver_id, vehicle_class, make, model, year, registration_number, colour } = req.body;

        if (!driver_id || !vehicle_class || !make || !model || !registration_number) {
            return res.status(400).json({
                message: "driver_id, vehicle_class, make, model, and registration_number are required"
            });
        }

        // Confirm driver exists
        const driverCheck = await pool.query(
            "SELECT id FROM users WHERE id = $1 AND role = 'driver'",
            [driver_id]
        );
        if (driverCheck.rows.length === 0) {
            return res.status(404).json({ message: "Driver not found" });
        }

        const newVehicle = await pool.query(
            `INSERT INTO vehicles
                (registration_number, make, model, vehicle_class, year, color, driver_id, owner_type, availability_status, verification_status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'driver', 'available', 'pending_verification')
             RETURNING *`,
            [registration_number, make, model, vehicle_class, year || null, colour || null, driver_id]
        );

        res.status(201).json({
            message: "Vehicle added successfully. Upload documents to complete verification.",
            vehicle: newVehicle.rows[0]
        });

    } catch (error) {
        if (error.code === "23505") { // unique violation (registration_number)
            return res.status(409).json({ message: "A vehicle with this registration number already exists" });
        }
        console.error("Error in addVehicle:", error);
        res.status(500).json({ message: "Something went wrong while adding the vehicle" });
    }
};

// GET ALL VEHICLES BELONGING TO A DRIVER
const getDriverVehicles = async (req, res) => {
    try {
        const { id } = req.params;

        const vehicles = await pool.query(
            "SELECT * FROM vehicles WHERE driver_id = $1 ORDER BY created_at DESC",
            [id]
        );

        res.status(200).json({ vehicles: vehicles.rows });

    } catch (error) {
        console.error("Error in getDriverVehicles:", error);
        res.status(500).json({ message: "Something went wrong while fetching vehicles" });
    }
};

// UPLOAD A VEHICLE DOCUMENT / PHOTO
const uploadVehicleDocument = async (req, res) => {
    try {
        const { id } = req.params; // vehicle id
        const { document_type } = req.body;

        if (!document_type) {
            return res.status(400).json({ message: "document_type is required" });
        }

        if (!REQUIRED_VEHICLE_DOCUMENTS.includes(document_type)) {
            return res.status(400).json({
                message: `document_type must be one of: ${REQUIRED_VEHICLE_DOCUMENTS.join(", ")}`
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
            `INSERT INTO vehicle_documents (vehicle_id, document_type, file_url, file_format, status)
             VALUES ($1, $2, $3, $4, 'pending_review')
             RETURNING id, vehicle_id, document_type, file_url, status, uploaded_at`,
            [id, document_type, fileUrl, fileFormat]
        );

        // Check if all required vehicle documents are now uploaded
        const existingDocs = await pool.query(
            "SELECT DISTINCT document_type FROM vehicle_documents WHERE vehicle_id = $1",
            [id]
        );
        const uploadedTypes = existingDocs.rows.map(row => row.document_type);
        const allDocumentsUploaded = REQUIRED_VEHICLE_DOCUMENTS.every(type => uploadedTypes.includes(type));

        res.status(201).json({
            message: "Vehicle document uploaded successfully",
            document: newDoc.rows[0],
            all_documents_complete: allDocumentsUploaded
        });

    } catch (error) {
        console.error("Error in uploadVehicleDocument:", error);
        res.status(500).json({ message: "Something went wrong while uploading the vehicle document" });
    }
};

// GET ALL DOCUMENTS FOR A VEHICLE
const getVehicleDocuments = async (req, res) => {
    try {
        const { id } = req.params;

        const docs = await pool.query(
            "SELECT * FROM vehicle_documents WHERE vehicle_id = $1 ORDER BY uploaded_at DESC",
            [id]
        );

        const uploadedTypes = docs.rows.map(row => row.document_type);
        const missingDocuments = REQUIRED_VEHICLE_DOCUMENTS.filter(type => !uploadedTypes.includes(type));

        res.status(200).json({
            documents: docs.rows,
            missing_documents: missingDocuments,
            is_complete: missingDocuments.length === 0
        });

    } catch (error) {
        console.error("Error in getVehicleDocuments:", error);
        res.status(500).json({ message: "Something went wrong while fetching vehicle documents" });
    }
};

module.exports = { addVehicle, getDriverVehicles, uploadVehicleDocument, getVehicleDocuments };