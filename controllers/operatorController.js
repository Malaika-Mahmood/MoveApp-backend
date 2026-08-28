const pool = require("../config/db");

// GET ALL DRIVERS PENDING VERIFICATION
const getPendingDrivers = async (req, res) => {
    try {
        const drivers = await pool.query(
            `SELECT id, full_name, email, phone, nic_number, address, status, created_at
             FROM users
             WHERE role = 'driver' AND status = 'pending_verification'
             ORDER BY created_at ASC`
        );

        res.status(200).json({ drivers: drivers.rows });

    } catch (error) {
        console.error("Error in getPendingDrivers:", error);
        res.status(500).json({ message: "Something went wrong while fetching pending drivers" });
    }
};

// APPROVE OR REJECT A SINGLE DOCUMENT
const verifyDocument = async (req, res) => {
    try {
        const { documentId } = req.params;
        const { status, rejection_reason } = req.body;

        if (!["approved", "rejected"].includes(status)) {
            return res.status(400).json({ message: "status must be 'approved' or 'rejected'" });
        }

        if (status === "rejected" && !rejection_reason) {
            return res.status(400).json({ message: "rejection_reason is required when rejecting a document" });
        }

        // 1. Update the document
        const updatedDoc = await pool.query(
            `UPDATE driver_documents
             SET status = $1, rejection_reason = $2
             WHERE id = $3
             RETURNING *`,
            [status, status === "rejected" ? rejection_reason : null, documentId]
        );

        if (updatedDoc.rows.length === 0) {
            return res.status(404).json({ message: "Document not found" });
        }

        const driverId = updatedDoc.rows[0].user_id;

        // 2. If rejected — driver stays pending, they'll need to re-upload
        if (status === "rejected") {
            return res.status(200).json({
                message: "Document rejected. Driver has been notified to re-upload.",
                document: updatedDoc.rows[0]
            });
        }

        // 3. If approved — check if ALL of this driver's documents are now approved
        const allDocs = await pool.query(
            "SELECT status FROM driver_documents WHERE user_id = $1",
            [driverId]
        );
        const allApproved = allDocs.rows.every(doc => doc.status === "approved");

        if (allApproved) {
            await pool.query(
                "UPDATE users SET status = 'approved' WHERE id = $1",
                [driverId]
            );
        }

        res.status(200).json({
            message: "Document approved",
            document: updatedDoc.rows[0],
            driver_fully_approved: allApproved
        });

    } catch (error) {
        console.error("Error in verifyDocument:", error);
        res.status(500).json({ message: "Something went wrong while verifying the document" });
    }
};
// GET ALL AVAILABLE VEHICLES
const getAvailableVehicles = async (req, res) => {
    try {
        const vehicles = await pool.query(
            "SELECT * FROM vehicles WHERE status = 'available' ORDER BY class, model"
        );

        res.status(200).json({ vehicles: vehicles.rows });

    } catch (error) {
        console.error("Error in getAvailableVehicles:", error);
        res.status(500).json({ message: "Something went wrong while fetching vehicles" });
    }
};

// ASSIGN A VEHICLE TO A DRIVER
const assignVehicle = async (req, res) => {
    try {
        const { id } = req.params; // driver id
        const { vehicle_id } = req.body;

        if (!vehicle_id) {
            return res.status(400).json({ message: "vehicle_id is required" });
        }

        // 1. Confirm the driver exists and is approved
        const driverCheck = await pool.query(
            "SELECT id, status FROM users WHERE id = $1 AND role = 'driver'",
            [id]
        );
        if (driverCheck.rows.length === 0) {
            return res.status(404).json({ message: "Driver not found" });
        }
        if (driverCheck.rows[0].status !== "approved") {
            return res.status(400).json({
                message: "Driver must be fully approved before a vehicle can be assigned"
            });
        }

        // 2. Confirm the vehicle exists and is available
        const vehicleCheck = await pool.query(
            "SELECT id, status FROM vehicles WHERE id = $1",
            [vehicle_id]
        );
        if (vehicleCheck.rows.length === 0) {
            return res.status(404).json({ message: "Vehicle not found" });
        }
        if (vehicleCheck.rows[0].status !== "available") {
            return res.status(400).json({ message: "This vehicle is not available" });
        }

        // 3. If this driver already has a different vehicle assigned, free it up first
        await pool.query(
            "UPDATE vehicles SET status = 'available', assigned_driver_id = NULL WHERE assigned_driver_id = $1",
            [id]
        );

        // 4. Assign the new vehicle
        const updatedVehicle = await pool.query(
            `UPDATE vehicles
             SET status = 'assigned', assigned_driver_id = $1, updated_at = NOW()
             WHERE id = $2
             RETURNING *`,
            [id, vehicle_id]
        );

        res.status(200).json({
            message: "Vehicle assigned successfully",
            vehicle: updatedVehicle.rows[0]
        });

    } catch (error) {
        console.error("Error in assignVehicle:", error);
        res.status(500).json({ message: "Something went wrong while assigning the vehicle" });
    }
};

// UNASSIGN A VEHICLE FROM A DRIVER
const unassignVehicle = async (req, res) => {
    try {
        const { id } = req.params; // driver id

        const result = await pool.query(
            `UPDATE vehicles
             SET status = 'available', assigned_driver_id = NULL, updated_at = NOW()
             WHERE assigned_driver_id = $1
             RETURNING *`,
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: "This driver has no vehicle currently assigned" });
        }

        res.status(200).json({
            message: "Vehicle unassigned successfully",
            vehicle: result.rows[0]
        });

    } catch (error) {
        console.error("Error in unassignVehicle:", error);
        res.status(500).json({ message: "Something went wrong while unassigning the vehicle" });
    }
};
module.exports = { getPendingDrivers, verifyDocument, getAvailableVehicles, assignVehicle, unassignVehicle };