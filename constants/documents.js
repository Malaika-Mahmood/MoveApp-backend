// Every list of document types lives here. Previously the driver list sat in
// documentController and the operator code could not see it, which is how the
// "approved with 2 of 10 documents" bug survived.

// The National Insurance document is gone — the driver types the number on the
// Personal Information screen instead, and the operator checks it against the
// licence. There is no longer an ni_front / ni_back upload.
//
// There is now ONE selfie, not three. The phone captures it live and scans the
// face from every angle during that capture, so what arrives here is a single
// verified image rather than three separate photographs the driver could have
// taken from a gallery.
const REQUIRED_DRIVER_DOCUMENTS = [
    "pco_licence_front",
    "pco_licence_back",
    "driving_licence_front",
    "driving_licence_back",
    "passport_photo",
    "selfie"
];

// Shown with a "Skip now" button. Never blocks verification.
const OPTIONAL_DRIVER_DOCUMENTS = [
    "passport_copy",
    "private_hire_paper_part"
];

const ALL_DRIVER_DOCUMENTS = [...REQUIRED_DRIVER_DOCUMENTS, ...OPTIONAL_DRIVER_DOCUMENTS];

const REQUIRED_VEHICLE_DOCUMENTS = [
    "pco_vehicle_paper",
    "v5_logbook",
    "mot_road_tax",
    "car_insurance",
    "mot_licence",
    "photo_front",
    "photo_back",
    "photo_interior"
];

// Only applies when the vehicle is rented or driven with the owner's
// permission, so it never blocks verification.
const OPTIONAL_VEHICLE_DOCUMENTS = [
    "rental_agreement"
];

const ALL_VEHICLE_DOCUMENTS = [...REQUIRED_VEHICLE_DOCUMENTS, ...OPTIONAL_VEHICLE_DOCUMENTS];

// Documents that carry an expiry date. The operator fills these in while
// approving — they are reading the document anyway.
//
// A photo or a National Insurance letter does not expire, so asking for a date
// on those would just be noise.
const DRIVER_DOCUMENTS_WITH_EXPIRY = [
    "driving_licence_front",
    "pco_licence_front",
    "private_hire_paper_part"
];

const VEHICLE_DOCUMENTS_WITH_EXPIRY = [
    "pco_vehicle_paper",
    "mot_road_tax",
    "car_insurance",
    "mot_licence"
];

const documentNeedsExpiry = (type) =>
    DRIVER_DOCUMENTS_WITH_EXPIRY.includes(type) || VEHICLE_DOCUMENTS_WITH_EXPIRY.includes(type);

// Kept out of the PDF pack — the selfies exist so an operator can match the
// face against the identity documents inside the app. They are not part of a
// document pack anyone would send on.
const DOCUMENTS_EXCLUDED_FROM_PDF = [
    "selfie"
];

// Where the file came from on the phone
const DOCUMENT_SOURCES = ["scan", "gallery", "pdf"];

// Human labels, so the app does not have to hard-code its own copy of these
// and drift out of step with the backend.
const DOCUMENT_LABELS = {
    pco_licence_front: "PCO licence — front",
    pco_licence_back: "PCO licence — back",
    driving_licence_front: "Driving licence — front",
    driving_licence_back: "Driving licence — back",
    passport_photo: "Passport photo",
    selfie: "Live selfie",
    passport_copy: "Passport copy (optional)",
    private_hire_paper_part: "Private hire paper part (optional)",

    pco_vehicle_paper: "PCO vehicle licence",
    v5_logbook: "V5 logbook (V5C)",
    mot_road_tax: "MOT road tax",
    car_insurance: "Car insurance",
    mot_licence: "MOT licence",
    photo_front: "Vehicle photo — front",
    photo_back: "Vehicle photo — rear",
    photo_interior: "Vehicle photo — interior",
    rental_agreement: "Rental agreement / permission (optional)"
};

module.exports = {
    REQUIRED_DRIVER_DOCUMENTS,
    OPTIONAL_DRIVER_DOCUMENTS,
    ALL_DRIVER_DOCUMENTS,
    REQUIRED_VEHICLE_DOCUMENTS,
    OPTIONAL_VEHICLE_DOCUMENTS,
    ALL_VEHICLE_DOCUMENTS,
    DRIVER_DOCUMENTS_WITH_EXPIRY,
    VEHICLE_DOCUMENTS_WITH_EXPIRY,
    DOCUMENTS_EXCLUDED_FROM_PDF,
    documentNeedsExpiry,
    DOCUMENT_SOURCES,
    DOCUMENT_LABELS
};