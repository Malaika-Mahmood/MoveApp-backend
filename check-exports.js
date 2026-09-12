// Run with:  node check-exports.js
//
// Loads every controller and prints which handler names are missing.
// Nothing is changed — it only reads.

require("dotenv").config();

const needed = {
    "./controllers/authController": [
        "registerStart", "registerVerify", "registerResend", "createAccount"
    ],
    "./controllers/otpController": [
        "sendOtp", "verifyOtp", "sendEmailOtp", "verifyEmailOtp"
    ],
    "./controllers/googleAuthController": ["googleLogin"],
    "./controllers/documentController": [
        "uploadDocument", "getMyDocuments", "getMyDocumentsPdf",
        "getDriverDocumentsPdfForOperator", "getDriverDocumentsPdfForAdmin",
        "getDocumentFile", "deprecated"
    ],
    "./controllers/driverController": ["getMe", "updatePersonalInfo"],
    "./controllers/vehicleController": [
        "addVehicle", "getMyVehicles", "uploadVehicleDocument",
        "getVehicleDocuments", "getVehicleDocumentFile"
    ],
    "./controllers/operatorController": [
        "getPendingDrivers", "getDriverDetail", "verifyDriverDocument",
        "verifyVehicleDocument", "updateDriverDetails", "updateVehicleDetails",
        "setDriverSuspension"
    ],
    "./controllers/operatorProfileController": [
        "getMe", "getMyDocumentsPdf", "loadOperatorPack", "safeFileName",
        "updateProfile", "uploadDocument", "addCouncil", "removeCouncil",
        "getOperatorDocumentFile", "getCouncilFile"
    ],
    "./controllers/adminController": [
        "getOperators", "getOperatorDetail", "getOperatorDocumentsPdf",
        "getDrivers", "verifyOperatorDocument", "verifyCouncil",
        "setOperatorSuspension", "listAdmins", "createAdmin"
    ],
    "./middleware/authenticate": null,       // module itself must be a function
    "./middleware/authorize": null,
    "./middleware/uploadFile": null,
    "./middleware/rateLimit": null,
    "./middleware/requireApprovedOperator": null
};

let problems = 0;

for (const [path, names] of Object.entries(needed)) {
    let mod;

    try {
        mod = require(path);
    } catch (err) {
        console.log(`\nCANNOT LOAD  ${path}`);
        console.log(`             ${err.message}`);
        problems++;
        continue;
    }

    if (names === null) {
        if (typeof mod !== "function") {
            console.log(`\nNOT A FUNCTION  ${path}  (it is ${typeof mod})`);
            problems++;
        }
        continue;
    }

    const missing = names.filter((n) => typeof mod[n] !== "function");

    if (missing.length > 0) {
        console.log(`\nMISSING in ${path}`);
        missing.forEach((n) => console.log(`   ${n}  ->  ${typeof mod[n]}`));
        console.log(`   this file actually exports: ${Object.keys(mod).join(", ")}`);
        problems++;
    }
}

console.log(problems === 0
    ? "\nAll controllers and middleware are fine."
    : `\n${problems} file(s) above are the problem.`);