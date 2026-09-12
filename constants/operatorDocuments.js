// Documents an operator submits about their own business, so that an admin
// can verify them — the same relationship the operator has with a driver.

const REQUIRED_OPERATOR_DOCUMENTS = [
    // Business
    "operator_licence",
    "public_liability_insurance",
    "employers_liability_insurance",
    // Identity
    "operator_passport",
    "operator_driving_licence",
    // Proof of address — one of: utility bill, bank statement, credit card
    // statement, all within the last 3 months
    "proof_of_address"
];

// The head-and-shoulders photograph that goes in the top-right corner of the
// operator's document pack, the same way the driver's passport photo does.
//
// OPTIONAL, not required, and deliberately so: operators are already verified
// and approved in production. Adding a seventh required document would make
// every one of them incomplete again, and the next time anything recalculated
// their status they would drop out of "approved" and lose access to their
// drivers — for a photograph.
//
// Once the existing operators have uploaded one, move this line up into
// REQUIRED_OPERATOR_DOCUMENTS and nothing else has to change.
const OPTIONAL_OPERATOR_DOCUMENTS = [
    "operator_photo"
];

const ALL_OPERATOR_DOCUMENTS = [
    ...REQUIRED_OPERATOR_DOCUMENTS,
    ...OPTIONAL_OPERATOR_DOCUMENTS
];

// Everything here expires except proof of address, which is judged on how
// recent it is rather than an expiry date printed on it.
const OPERATOR_DOCUMENTS_WITH_EXPIRY = [
    "operator_licence",
    "public_liability_insurance",
    "employers_liability_insurance",
    "operator_passport",
    "operator_driving_licence"
];

const operatorDocumentNeedsExpiry = (type) =>
    OPERATOR_DOCUMENTS_WITH_EXPIRY.includes(type);

const OPERATOR_DOCUMENT_LABELS = {
    operator_licence: "Operator licence",
    public_liability_insurance: "Public liability insurance",
    employers_liability_insurance: "Employer's liability insurance",
    operator_passport: "Passport",
    operator_driving_licence: "Driving licence",
    proof_of_address: "Proof of address",
    operator_photo: "Photo (optional)"
};

// Grouping for the app's "Complete Your Verification" screen
const OPERATOR_DOCUMENT_GROUPS = [
    {
        title: "Business documents",
        types: ["operator_licence", "public_liability_insurance", "employers_liability_insurance"]
    },
    {
        title: "Identity documents",
        types: ["operator_passport", "operator_driving_licence", "operator_photo"]
    },
    {
        title: "Proof of address",
        hint: "One of: utility bill, bank statement (last 3 months), or credit card statement",
        types: ["proof_of_address"]
    }
];

module.exports = {
    REQUIRED_OPERATOR_DOCUMENTS,
    OPTIONAL_OPERATOR_DOCUMENTS,
    ALL_OPERATOR_DOCUMENTS,
    OPERATOR_DOCUMENTS_WITH_EXPIRY,
    operatorDocumentNeedsExpiry,
    OPERATOR_DOCUMENT_LABELS,
    OPERATOR_DOCUMENT_GROUPS
};